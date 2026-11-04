/**
 * What clients read about a run, derived from the folded journal and never stored (§1.4). Pure:
 * the engine reads the facts, folds them and calls these.
 */
import type {
  WorkflowGateView,
  WorkflowRunDelta,
  WorkflowRunSummary,
  WorkflowRunTriggerView,
  WorkflowStepAttemptView,
  WorkflowStepDetail,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type { Json } from "effect/Schema";
import { gateReason, type CompiledWorkflow } from "@t3tools/shared/workflows";

import {
  ThreadId,
  WorkflowRunId,
  WorkflowId,
  WorkflowHash,
  WorkflowStepKey,
  WorkflowNodeId,
  type WorkflowStepCost,
} from "@t3tools/contracts";
import { runIdFor } from "./ids.ts";
import { activeClockRunning, activeMs } from "./budget/budget.ts";
import { blockViews } from "./blocks/registry.ts";
import { isSubStep, nodeIdOfStep } from "./steps.ts";
import type { StoredFact } from "./facts.ts";
import type { GateState, RunState, StepAttempt } from "./state.ts";

/** Costs added up: usage is complete or unavailable only when every part is; USD only when every part has one. */
const sumCosts = (
  parts: ReadonlyArray<WorkflowStepCost | null | undefined>,
): WorkflowStepCost | null => {
  const costs = parts.filter((c): c is WorkflowStepCost => c != null);
  if (costs.length === 0) return null;
  return {
    billable: costs.reduce((n, c) => n + c.billable, 0),
    input: costs.reduce((n, c) => n + c.input, 0),
    output: costs.reduce((n, c) => n + c.output, 0),
    cacheRead: costs.reduce((n, c) => n + c.cacheRead, 0),
    usage: costs.every((c) => c.usage === "complete")
      ? "complete"
      : costs.every((c) => c.usage === "unavailable")
        ? "unavailable"
        : "partial",
    usdEstimate: costs.every((c) => c.usdEstimate !== null)
      ? costs.reduce((n, c) => n + (c.usdEstimate ?? 0), 0)
      : null,
  };
};

const shortOf = (gate: GateState): string => gate.intent.short ?? gateReason(gate.intent.ask);
/** Gates still waiting for the user, oldest first; one routed to the bot waits for the bot. */
const waitingGates = (state: RunState): ReadonlyArray<GateState> =>
  state.ended === null
    ? [...state.gates.values()]
        .filter((g) => g.decision === null && g.intent.bot === undefined)
        .sort(
          (a, b) =>
            (state.intents.get(a.intent.key)?.seq ?? 0) -
            (state.intents.get(b.intent.key)?.seq ?? 0),
        )
    : [];

/** The summary of a run that started (its stream has RunStarted). */
export const runSummary = (state: RunState, now?: number): WorkflowRunSummary => {
  const started = state.started;
  if (!started) throw new Error("RunStarted required");
  now ??= Date.parse(state.ended?.at ?? started.at);
  const total = sumCosts(
    [...state.attempts.values()].flat().flatMap((a) => [a.settled?.cost, a.nudge?.cost]),
  ) ?? {
    billable: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    usage: "unavailable",
    usdEstimate: null,
  };
  const intents = [...state.intents.values()].map((e) => e.intent);
  const waiting = waitingGates(state);
  const gate = waiting[0];
  return {
    runId: WorkflowRunId.make(state.runId),
    workflowId: WorkflowId.make(started.workflowId),
    title: started.title,
    hash: WorkflowHash.make(started.hash),
    commit: started.commit,
    status: state.ended?.status ?? (state.paused ? "paused" : "running"),
    pausedFor: state.paused?.reason ?? null,
    skipReason: null,
    trigger: {
      id: started.trigger.id ?? started.trigger.kind,
      kind: started.trigger.kind,
      label: started.trigger.label,
    },
    startedAt: started.at,
    endedAt: state.ended?.at ?? null,
    outputStatus: state.output?.status ?? null,
    stepsUsed: intents.filter(
      (i) => i._tag === "StartTurn" || i._tag === "StartUnit" || i._tag === "StartChildRun",
    ).length,
    cost: total,
    reservedTokens: intents.reduce(
      (n, i) =>
        n +
        (i._tag === "StartTurn" &&
        !state.attempts.get(i.step)?.find((a) => a.attempt === i.attempt)?.settled
          ? i.reservation
          : 0),
      0,
    ),
    openGates: waiting.length,
    pullRequest:
      [...state.intents.values()]
        .reverse()
        .flatMap((entry) =>
          entry.result?._tag === "PullRequestOpened" ? [entry.result.url] : [],
        )[0] ?? null,
    activeMs: activeMs(state, state.ended ? Date.parse(state.ended.at) : now),
    activeSince: activeClockRunning(state, now)
      ? DateTime.formatIso(DateTime.makeUnsafe(now))
      : null,
    gate:
      gate === undefined
        ? null
        : {
            key: gate.intent.gateKey,
            reason: shortOf(gate),
            openedAt: gate.openedAt ?? started.at,
          },
  };
};

/** The header of a run's trigger card; the payload itself is read on demand. */
export const runTriggerView = (trigger: {
  readonly id?: string | undefined;
  readonly kind: string;
  readonly occurrence: string;
  readonly label: string;
  readonly payload: Json;
}): WorkflowRunTriggerView => ({
  id: trigger.id ?? trigger.kind,
  kind: trigger.kind,
  label: trigger.label,
  occurrence: trigger.occurrence,
  test: trigger.occurrence.startsWith("test:"),
  payloadBytes: JSON.stringify(trigger.payload ?? null).length,
});

/**
 * A run that has no RunStarted yet, from its workflow's stream: `queued` while its TriggerFired
 * waits, `skipped` with the reason once a TriggerSkipped answered it. null when the occurrence is unknown.
 */
export const pendingSummary = (
  workflowFacts: ReadonlyArray<StoredFact>,
  runId: string,
  title: string,
): WorkflowRunSummary | null => {
  if (workflowFacts.some((e) => e.fact._tag === "RunCreated" && e.fact.runId === runId))
    return null;
  for (const entry of workflowFacts) {
    const f = entry.fact;
    const workflowId = entry.stream.slice("workflow:".length);
    if (f._tag !== "TriggerFired" || runIdFor(workflowId, f.occurrence) !== runId) continue;
    const skipped = workflowFacts
      .map((e) => e.fact)
      .find((fact) => fact._tag === "TriggerSkipped" && fact.occurrence === f.occurrence);
    return {
      runId: WorkflowRunId.make(runId),
      workflowId: WorkflowId.make(workflowId),
      title,
      hash: null,
      commit: null,
      status: skipped ? "skipped" : "queued",
      skipReason: skipped?._tag === "TriggerSkipped" ? skipped.reason : null,
      pausedFor: null,
      trigger: { id: f.triggerId, kind: f.kind, label: f.label },
      startedAt: f.at,
      endedAt: null,
      outputStatus: null,
      stepsUsed: 0,
      cost: {
        billable: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        usage: "unavailable",
        usdEstimate: null,
      },
      reservedTokens: 0,
      openGates: 0,
      pullRequest: null,
      activeMs: null,
      activeSince: null,
    };
  }
  return null;
};

/**
 * An accept command or judge turn is never resolved itself (its step is): it reads as what it did,
 * or `cancelled` when the run ended before it finished.
 */
const subStepStatus = (a: StepAttempt, state: RunState): WorkflowStepAttemptView["status"] => {
  // Stopped by the run's end: its exit or settle is the interrupt's, not what it would have done.
  const intentKey = `${a.step.endsWith("/accept") ? "accept" : "judge"}:${a.step.replace(/\/(accept|judge)$/, "")}@${a.attempt}`;
  if (state.ended !== null && state.keys.has(`interrupt:${intentKey}`)) return "cancelled";
  if (a.exited !== null) {
    return a.exited.exit === 0 && !a.exited.lost && a.exited.signal === null
      ? "succeeded"
      : "failed";
  }
  if (a.settled !== null) return a.settled.status === "completed" ? "succeeded" : "failed";
  if (state.ended !== null) return "cancelled";
  return a.threadId || a.unit ? "running" : "dispatched";
};

/** One view per attempt of every step, in the order the attempts started (`firstSeq`). */
export const stepViews = (
  compiled: CompiledWorkflow,
  state: RunState,
): ReadonlyArray<WorkflowStepAttemptView> => {
  const nodeInfo = (step: string) => {
    const id = nodeIdOfStep(step);
    const find = (graph: CompiledWorkflow["root"]): string | undefined => {
      for (const node of graph.nodes.values()) {
        if (node.id === id) return node.node.kind;
        if (node.body) {
          const kind = find(node.body);
          if (kind) return kind;
        }
      }
      return undefined;
    };
    return { node: WorkflowNodeId.make(id), kind: find(compiled.root) ?? "unknown" };
  };
  const views: WorkflowStepAttemptView[] = [...state.attempts.values()]
    .flat()
    .sort((a, b) => a.firstSeq - b.firstSeq)
    .map((a) => ({
      key: WorkflowStepKey.make(a.step),
      ...nodeInfo(a.step),
      attempt: a.attempt,
      status:
        a.resolved?.status ??
        (isSubStep(a.step)
          ? subStepStatus(a, state)
          : [...state.gates.values()].some((g) => g.intent.step === a.step && !g.decision)
            ? "waiting_gate"
            : a.threadId || a.unit
              ? "running"
              : "dispatched"),
      threadId: a.threadId ? ThreadId.make(a.threadId) : null,
      startedAt: a.startedAt,
      endedAt: a.resolved?.at ?? null,
      queuedMs: a.exited?.queuedMs ?? null,
      port: a.resolved?.port ?? null,
      summary:
        (a.resolved?.error ?? a.nudge?.text ?? a.settled?.text ?? a.exited?.tail)?.slice(0, 500) ??
        null,
      cost: sumCosts([a.settled?.cost, a.nudge?.cost]),
      evidence: null,
    }));
  // A dead path a retry reopened keeps its old skip fact; the attempts it got since are the truth.
  for (const step of [...state.skipped.keys()].filter((s) => !state.attempts.has(s)).sort())
    views.push({
      key: WorkflowStepKey.make(step),
      ...nodeInfo(step),
      attempt: 1,
      status: "skipped",
      threadId: null,
      startedAt: null,
      endedAt: null,
      queuedMs: null,
      port: null,
      summary: null,
      cost: null,
      evidence: null,
    });
  // A gate step, or a command waiting for approval, has no attempt yet: it waits on its gate,
  // unless the run ended without a decision.
  for (const gate of state.ended === null ? state.gates.values() : []) {
    const step = gate.intent.step;
    if (gate.decision !== null || (state.attempts.get(step)?.length ?? 0) > 0) continue;
    if (views.some((v) => v.key === step)) continue;
    views.push({
      key: WorkflowStepKey.make(step),
      ...nodeInfo(step),
      attempt: Number(/@(\d+)$/.exec(gate.intent.gateKey)?.[1] ?? 1),
      status: "waiting_gate",
      threadId: null,
      startedAt: gate.openedAt,
      endedAt: null,
      queuedMs: null,
      port: null,
      summary: shortOf(gate),
      cost: null,
      evidence: null,
    });
  }
  return views;
};

/**
 * Every gate the run opened, in the order it opened them. A bot's gate it never decided, handed
 * to Israel as `escalated:<key>`, shows only as Israel's.
 */
export const gateViews = (state: RunState): ReadonlyArray<WorkflowGateView> => {
  return [...state.gates.values()]
    .filter(
      (g) =>
        g.intent.bot === undefined ||
        g.decision !== null ||
        !state.gates.has(`escalated:${g.intent.gateKey}`),
    )
    .sort(
      (a, b) =>
        (state.intents.get(a.intent.key)?.seq ?? 0) - (state.intents.get(b.intent.key)?.seq ?? 0),
    )
    .map((g) => ({
      key: g.intent.gateKey,
      step: WorkflowStepKey.make(g.intent.step),
      ask: g.intent.ask,
      reason: shortOf(g),
      options: g.intent.options,
      openedAt: g.openedAt ?? state.started?.at ?? "",
      expiresAt: g.intent.expiresAt,
      decision: g.decision
        ? { option: g.decision.option, note: g.decision.note, at: g.decision.at, by: g.decision.by }
        : null,
      ...(g.intent.bot === undefined ? {} : { bot: g.intent.bot }),
    }));
};

/** What changed after `afterSeq`: attempts and gates whose `lastSeq` is greater, and the summary. */
export const runDelta = (
  compiled: CompiledWorkflow,
  state: RunState,
  afterSeq: number,
  now?: number,
): WorkflowRunDelta => {
  return {
    runId: WorkflowRunId.make(state.runId),
    seq: state.lastSeq,
    summary: runSummary(state, now),
    steps: stepViews(compiled, state).filter((v) => changedAfter(state, v, afterSeq)),
    gates: gateViews(state).filter((g) => (state.gates.get(g.key)?.lastSeq ?? 0) > afterSeq),
    blocks: blockViews(compiled, state, afterSeq),
    ...(state.warnings.some((w) => w.seq > afterSeq) ? { warnings: runWarnings(state) } : {}),
  };
};

/** The run's warnings, oldest first; absent from views of runs that have none. */
export const runWarnings = (state: RunState): ReadonlyArray<string> =>
  state.warnings.map((warning) => warning.message);

const changedAfter = (
  state: RunState,
  view: WorkflowStepAttemptView,
  afterSeq: number,
): boolean => {
  if (view.status === "skipped") return (state.skippedSeq.get(view.key) ?? 0) > afterSeq;
  const attempt = state.attempts.get(view.key)?.find((a) => a.attempt === view.attempt);
  if (attempt !== undefined) return attempt.lastSeq > afterSeq;
  return [...state.gates.values()].some((g) => g.intent.step === view.key && g.lastSeq > afterSeq);
};

/** One attempt in full: its view, its output, the agent's text and the command's log tail. */
export const stepDetail = (
  compiled: CompiledWorkflow,
  state: RunState,
  step: string,
  attempt: number,
): WorkflowStepDetail | null => {
  const a = state.attempts.get(step)?.find((a) => a.attempt === attempt);
  const view = stepViews(compiled, state).find((v) => v.key === step && v.attempt === attempt);
  if (!a || !view) return null;
  return {
    view,
    output: a.resolved?.output ?? null,
    text: (a.nudge ?? a.settled)?.text.slice(0, 16384) ?? null,
    logs: a.exited ? [{ name: "stdout", tail: a.exited.tail, path: null }] : [],
  };
};
