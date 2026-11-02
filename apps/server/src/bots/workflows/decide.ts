/**
 * The run decider (§3.1): pure, from the compiled definition, the folded state and the clock to
 * the facts to append next. An executable intent leaves as `IntentRecorded`; the actor runs it.
 * Every fact has a deterministic key, and nothing whose key the state already holds is emitted.
 */
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";
import type { Json } from "effect/Schema";

import type {
  WorkflowAgentNode,
  WorkflowCommandNode,
  WorkflowNode,
  WorkflowStepStatus,
  WorkflowWorkspaceUse,
} from "@t3tools/contracts";
import {
  checkOutput,
  classifyCommand,
  evalExpr,
  evalTemplateValue,
  isTruthy,
  parseExpr,
  parseTemplate,
  renderTemplate,
  resolveModelUse,
  type CompiledGraph,
  type CompiledNode,
  type CompiledWorkflow,
  type EvalEnv,
  type JsonValue,
} from "@t3tools/shared/workflows";

import {
  type Fact,
  type Intent,
  type NewFact,
  type RunFact,
  runStream,
  workflowStream,
} from "./facts.ts";
import { runIdFor, stepThreadId } from "./ids.ts";
import { isSubStep, nodeIdOfStep } from "./steps.ts";
import { liveTarget } from "./fold.ts";
import type { GateDecided, RunState, StepAttempt } from "./state.ts";

export interface DecideContext {
  /** Epoch milliseconds. */
  readonly now: number;
  /** Absolute directory of this run (`~/.t3/workflows/runs/<runId>`): `run.dir`, `step.dir`. */
  readonly runDir: string;
  /** Workflows that start when this one fails (`workflowFailed` triggers). */
  readonly failureSubscribers: ReadonlyArray<{
    readonly workflowId: string;
    readonly triggerId: string;
  }>;
}

/** A lost turn, or a lost command that may run again, is replayed this often (crash recovery). */
const MAX_LOST_REPLAYS = 2;
const AMBIGUOUS_OPTIONS = ["rerun", "fail", "cancel"] as const;
const DURATION_UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000 } as const;
const durationMs = (text: string): number =>
  Number(text.slice(0, -1)) * DURATION_UNIT_MS[text.slice(-1) as keyof typeof DURATION_UNIT_MS];

type Resolution = Extract<RunFact, { readonly _tag: "StepResolved" }>;
type ResolvedStatus = Resolution["status"];

/**
 * When a resolved attempt runs again, or null; dispatch and deadlines share it. `rerun` (a retry, or
 * what a reopened run's end stopped) and ambiguous go at once; "fail" on an ambiguous gate ends it;
 * a matching retry policy waits its backoff; lost replays at once, a bounded number of times.
 */
const retryReadyAt = (
  node: WorkflowNode,
  attempt: number,
  status: ResolvedStatus,
  resolvedAt: string,
  markedFailed: boolean,
  rerun: boolean,
): number | null => {
  const at = Date.parse(resolvedAt);
  if (rerun && status !== "succeeded") return at;
  if (markedFailed) return null;
  if (status === "ambiguous") return at;
  if (status === "succeeded" || status === "cancelled") return null;
  const policy = node.retry;
  if (policy !== undefined && policy.on.includes(status) && attempt <= policy.max) {
    return at + (policy.backoff === undefined ? 0 : durationMs(policy.backoff));
  }
  if (status === "lost" && (node.kind === "command" || node.kind === "agent")) {
    return attempt <= MAX_LOST_REPLAYS ? at : null;
  }
  return null;
};

/** A step's settled outcome as the graph sees it, after retries. */
interface Final {
  readonly status: ResolvedStatus | "skipped";
  readonly port: string | null;
  readonly output: Json;
}

/** One instance of one level: the top graph, a map item or a loop iteration. */
interface Level {
  readonly graph: CompiledGraph;
  /** Step-key prefix of this instance: `""`, `"each[2]/"`. */
  readonly prefix: string;
  readonly parent: Level | null;
  /** The map item this instance runs, and the `as` alias that also names it. */
  readonly item: { readonly value: Json; readonly alias: string | null } | null;
  readonly iteration: number | null;
}

type LevelOutcome =
  | { readonly done: false }
  | { readonly done: true; readonly failed: string | null; readonly output: Json };

const stepKey = (step: string, attempt: number) => `${step}@${attempt}`;
const isStart = (intent: Intent) =>
  intent._tag === "StartTurn" || intent._tag === "StartUnit" || intent._tag === "StartChildRun";

/**
 * After the end nothing new runs, but a turn or unit whose start receipt arrived late (it was
 * executing when the run ended) still has to stop: interrupt every started attempt left live.
 */
const interruptsAfterEnd = (state: RunState): ReadonlyArray<NewFact> =>
  [...state.intents.values()].flatMap((entry) => {
    const target = liveTarget(entry, state);
    const key = `interrupt:${entry.intent.key}`;
    if (target === null || state.keys.has(key) || !("step" in entry.intent)) return [];
    const intent: Intent = { _tag: "Interrupt", key, step: entry.intent.step, target };
    return [{ stream: runStream(state.runId), key, fact: { _tag: "IntentRecorded", intent } }];
  });
const isoOf = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

/** The top-level steps an edge from `step` leads to. */
const successorsOf = (compiled: CompiledWorkflow, step: string): ReadonlyArray<string> =>
  compiled.root.edges.filter((edge) => edge.from === step).map((edge) => edge.to);

/**
 * Why `step` cannot be retried now, or null. A retry runs the step's latest attempt again like
 * Israel's "rerun", so the failure must not have led anywhere yet; a failed run reopens for it.
 */
export const retryRefusal = (
  compiled: CompiledWorkflow,
  state: RunState,
  step: string,
): string | null => {
  if (state.started === null) return "the run has not started";
  if (step.includes("/")) return `retry the step that contains ${step}`;
  const node = nodeAt(compiled, step);
  const latestAttempt = state.attempts.get(step)?.at(-1);
  if (node === undefined || latestAttempt === undefined) return `${step} has not run`;
  if (latestAttempt.resolved === null) return `${step} is still running`;
  if (latestAttempt.resolved.status === "succeeded") return `${step} succeeded`;
  const after = successorsOf(compiled, step).find((next) => state.attempts.has(next));
  if (after !== undefined) return `${after} already ran after ${step}`;
  if (state.ended === null) return null;
  if (state.ended.status !== "failed") return `the run ended ${state.ended.status}`;
  if (state.started.parent !== null) return "retry the call step in the parent run";
  const declared = compiled.definition.workspaces ?? {};
  const removed = [...state.workspaces.keys()].find(
    (name) => Object.hasOwn(declared, name) && state.keys.has(`rm:${name}`),
  );
  if (removed !== undefined) return `the worktree ${removed} was already removed`;
  const given = [...state.workspaces.values()].find(
    (w) => w.branch !== null && state.releasedBranches.has(w.branch),
  );
  return given?.branch == null ? null : `its branch ${given.branch} went to a newer run`;
};

/**
 * After the end: stop what is still live, reopen for a retry once nothing is, or remove the
 * worktrees `retain` lets go. A disposable read-only checkout always goes; a declared worktree stays
 * when `retain` is `always`, or `on_failure` (the default) and the run did not succeed.
 */
const afterEnd = (compiled: CompiledWorkflow, state: RunState, now: number) => {
  const interrupts = interruptsAfterEnd(state);
  // A start still executing (or being abandoned) has no receipt yet, so it counts as live too.
  const live = [...state.intents.values()].filter(
    (entry) =>
      liveTarget(entry, state) !== null || (isStart(entry.intent) && entry.result === null),
  );
  if (interrupts.length > 0 || live.length > 0) return interrupts;
  const ended = state.ended;
  if (ended === null) return [];
  const retry = state.controls.find(
    (c) =>
      c.seq > state.endedSeq &&
      c.control.control === "retry" &&
      c.control.step !== null &&
      retryRefusal(compiled, state, c.control.step) === null,
  );
  if (retry?.control.step != null) {
    // A newer run taking a branch over after this read refuses the reopening, atomically.
    const reopened: NewFact = {
      stream: runStream(state.runId),
      key: `reopen:${retry.key}`,
      fact: { _tag: "RunReopened", step: retry.control.step, by: retry.control.by, at: isoOf(now) },
      guard: { absent: ["BranchReleased"], after: state.lastSeq },
    };
    return [reopened];
  }
  const declared = compiled.definition.workspaces ?? {};
  return [...state.workspaces.keys()].flatMap((name): ReadonlyArray<NewFact> => {
    const decl = Object.hasOwn(declared, name) ? declared[name] : undefined;
    const retain = decl?.retain ?? "on_failure";
    const keep =
      decl !== undefined &&
      (retain === "always" || (retain === "on_failure" && ended.status !== "succeeded"));
    const key = `rm:${name}`;
    if (keep || state.keys.has(key)) return [];
    const intent: Intent = { _tag: "RemoveWorkspace", key, name };
    return [{ stream: runStream(state.runId), key, fact: { _tag: "IntentRecorded", intent } }];
  });
};

export const decide = (
  compiled: CompiledWorkflow,
  state: RunState,
  ctx: DecideContext,
): ReadonlyArray<NewFact> => {
  const started = state.started;
  if (started === null) return [];
  if (state.ended !== null) return afterEnd(compiled, state, ctx.now);
  const definition = compiled.definition;
  const runId = state.runId;
  const stream = runStream(runId);
  const out: NewFact[] = [];
  const emittedKeys = new Set<string>();
  const nowIso = isoOf(ctx.now);
  /** Keys written once per run carry the reopening count after the first end. */
  const once = (key: string) => (state.generation === 0 ? key : `${key}:${state.generation}`);

  const has = (key: string) => state.keys.has(key) || emittedKeys.has(key);
  let cancelling = false;
  /** Paused after this pass's own RunPaused/RunResumed facts. */
  let pausedNow = state.paused !== null;
  /** Gate decisions this pass recorded (expiry), read alongside the folded ones. */
  const decidedNow = new Map<string, GateDecided>();
  const decisionOf = (gateKey: string): GateDecided | null =>
    state.gates.get(gateKey)?.decision ?? decidedNow.get(gateKey) ?? null;
  const emit = (key: string, fact: Fact, target = stream) => {
    if (emittedKeys.has(`${target}\u0000${key}`)) return;
    if (target === stream && state.keys.has(key)) return;
    if (fact._tag === "RunPaused") pausedNow = true;
    if (fact._tag === "GateDecided" && !decidedNow.has(fact.gateKey))
      decidedNow.set(fact.gateKey, fact);
    if (fact._tag === "RunResumed") pausedNow = false;
    emittedKeys.add(`${target}\u0000${key}`);
    if (target === stream) emittedKeys.add(key);
    out.push({ stream: target, key, fact });
  };
  /** Attempts this pass created or resolved, over the folded ones, so successors see them now. */
  const overlay = new Map<string, StepAttempt>();
  let startsNow = 0;
  const record = (intent: Intent) => {
    if (has(intent.key)) return;
    // Every start, an accept, a nudge or a judge included, spends a step of the budget.
    if (isStart(intent) && !admits()) return;
    emit(intent.key, { _tag: "IntentRecorded", intent });
    if (isStart(intent)) startsNow += 1;
    if (
      intent._tag === "StartTurn" ||
      intent._tag === "StartUnit" ||
      intent._tag === "StartChildRun"
    ) {
      if (latest(intent.step)?.attempt !== intent.attempt) {
        overlay.set(intent.step, emptyAttempt(intent.step, intent.attempt));
      }
    }
  };
  const resolve = (
    step: string,
    attempt: number,
    status: ResolvedStatus,
    port: string | null,
    output: Json = null,
    error: string | null = null,
  ) => {
    const fact: Resolution = {
      _tag: "StepResolved",
      step,
      attempt,
      status,
      port,
      output,
      error,
      at: nowIso,
    };
    emit(`resolved:${stepKey(step, attempt)}`, fact);
    const base = latest(step);
    overlay.set(step, {
      ...(base?.attempt === attempt ? base : emptyAttempt(step, attempt)),
      resolved: fact,
    });
  };

  // ── Reading the state ───────────────────────────────────────────────────────────────────────

  const attemptsOf = (step: string): ReadonlyArray<StepAttempt> => state.attempts.get(step) ?? [];
  const latest = (step: string): StepAttempt | undefined =>
    overlay.get(step) ?? attemptsOf(step).at(-1);
  const resultOf = (key: string) => state.intents.get(key)?.result ?? null;
  const resolutionOf = (a: StepAttempt): Resolution | null => a.resolved;
  const emptyAttempt = (step: string, attempt: number): StepAttempt => ({
    step,
    attempt,
    firstSeq: state.lastSeq + 1,
    lastSeq: state.lastSeq + 1,
    startedAt: null,
    threadId: null,
    unit: null,
    settled: null,
    nudge: null,
    exited: null,
    child: null,
    resolved: null,
    stoppedByEnd: false,
  });
  const skippedNow = new Set<string>();
  // A dead path is derived again every pass, so a retried step that now succeeds reopens it.
  const isSkipped = (step: string) => {
    const stored = state.skipped.get(step);
    return (stored !== undefined && stored !== "dead-path") || skippedNow.has(step);
  };
  const skip = (step: string, reason: "guard" | "dead-path" | "once") => {
    skippedNow.add(step);
    emit(`skip:${step}`, { _tag: "StepSkipped", step, reason });
  };

  const markedFailed = (step: string, attempt: number) =>
    decisionOf(`ambiguous:${stepKey(step, attempt)}`)?.option === "fail";
  /** Israel's retry of the step after this attempt, or the run's end stopped it and it reopened. */
  const rerunWanted = (a: StepAttempt) =>
    a.stoppedByEnd ||
    state.controls.some(
      (c) =>
        c.control.control === "retry" &&
        c.control.step === a.step &&
        c.seq > a.firstSeq &&
        retryRefusal(compiled, state, a.step) === null,
    );
  const willRetry = (node: WorkflowNode, a: StepAttempt, r: Resolution): boolean =>
    retryReadyAt(
      node,
      a.attempt,
      r.status,
      r.at,
      markedFailed(a.step, a.attempt),
      rerunWanted(a),
    ) !== null;

  const finalOf = (node: WorkflowNode, step: string): Final | null => {
    if (isSkipped(step)) return { status: "skipped", port: null, output: null };
    const a = latest(step);
    if (a === undefined) return null;
    const r = resolutionOf(a);
    if (r === null || willRetry(node, a, r)) return null;
    return { status: r.status, port: r.port, output: r.output };
  };

  const statusOf = (step: string): WorkflowStepStatus => {
    if (isSkipped(step)) return "skipped";
    const a = latest(step);
    if (a === undefined) return "pending";
    const r = resolutionOf(a);
    if (r !== null) return r.status;
    for (const gate of state.gates.values()) {
      if (gate.intent.step === step && gate.decision === null) return "waiting_gate";
    }
    return a.threadId !== null || a.unit !== null ? "running" : "dispatched";
  };

  /** The fold keeps each workspace's head at the last observation that reported one. */
  const workspaceHead = (name: string): string | null =>
    state.workspaces.get(name)?.headSha ?? null;

  // ── Expressions ─────────────────────────────────────────────────────────────────────────────

  const nodeView = (step: string): JsonValue => {
    const a = latest(step);
    const r = a === undefined ? null : resolutionOf(a);
    return {
      output: (r?.output ?? null) as JsonValue,
      status: statusOf(step),
      port: r?.port ?? null,
      thread: a?.threadId ?? null,
    };
  };

  const triggerRoot = (): JsonValue => {
    const payload = started.trigger.payload as JsonValue;
    const base = { kind: started.trigger.kind, label: started.trigger.label };
    return payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? { ...payload, ...base }
      : { ...base, payload };
  };

  const envFor = (level: Level, extra: { readonly [root: string]: JsonValue } = {}): EvalEnv => {
    const nodes: Record<string, JsonValue> = {};
    const roots: Record<string, JsonValue> = {};
    for (let l: Level | null = level; l !== null; l = l.parent) {
      for (const id of l.graph.nodes.keys())
        if (!(id in nodes)) nodes[id] = nodeView(l.prefix + id);
      if (l.item !== null) {
        if (!("item" in roots)) roots.item = l.item.value as JsonValue;
        if (l.item.alias !== null && !(l.item.alias in roots))
          roots[l.item.alias] = l.item.value as JsonValue;
      }
      if (l.iteration !== null && !("iteration" in roots)) roots.iteration = l.iteration;
    }
    const workspaces: Record<string, JsonValue> = {};
    for (const name of Object.keys(definition.workspaces ?? {})) {
      const ready = state.workspaces.get(name);
      workspaces[name] = {
        branch: ready?.branch ?? null,
        head: workspaceHead(name),
        path: ready?.path ?? null,
      };
    }
    return {
      roots: {
        params: started.params as JsonValue,
        trigger: triggerRoot(),
        nodes,
        workspaces,
        run: { id: runId, dir: ctx.runDir },
        ...roots,
        ...extra,
      },
    };
  };

  const stepDir = (step: string, attempt: number) =>
    `${ctx.runDir}/steps/${step.replace(/[^a-z0-9_]/g, "_")}@${attempt}`;

  /** Templates and expressions were checked by the compiler; a failure here is a runtime value error. */
  const render = (text: string, env: EvalEnv): Result.Result<string, string> => {
    const parsed = parseTemplate(text);
    if (Result.isFailure(parsed)) return Result.fail(parsed.failure.message);
    const rendered = renderTemplate(parsed.success, env);
    return Result.isFailure(rendered)
      ? Result.fail(rendered.failure.message)
      : Result.succeed(rendered.success);
  };
  const value = (text: string, env: EvalEnv): Result.Result<JsonValue, string> => {
    const parsed = parseTemplate(text);
    if (Result.isFailure(parsed)) return Result.fail(parsed.failure.message);
    const evaluated = evalTemplateValue(parsed.success, env);
    return Result.isFailure(evaluated)
      ? Result.fail(evaluated.failure.message)
      : Result.succeed(evaluated.success);
  };
  const evaluate = (text: string, env: EvalEnv): Result.Result<JsonValue, string> => {
    const parsed = parseExpr(text);
    if (Result.isFailure(parsed)) return Result.fail(parsed.failure.message);
    const evaluated = evalExpr(parsed.success, env);
    return Result.isFailure(evaluated)
      ? Result.fail(evaluated.failure.message)
      : Result.succeed(evaluated.success);
  };
  const renderAll = (
    record: { readonly [key: string]: string },
    env: EvalEnv,
  ): Result.Result<Record<string, JsonValue>, string> => {
    const result: Record<string, JsonValue> = {};
    for (const [key, text] of Object.entries(record)) {
      const v = value(text, env);
      if (Result.isFailure(v)) return Result.fail(`${key}: ${v.failure}`);
      result[key] = v.success;
    }
    return Result.succeed(result);
  };

  // ── Workspaces ──────────────────────────────────────────────────────────────────────────────

  /** The worktree a step uses, or null while it is being prepared (the intent is recorded). */
  const workspaceFor = (
    use: WorkflowWorkspaceUse,
    access: "read" | "write",
    step: string,
    attempt: number,
    level: Level,
  ): Result.Result<
    { readonly name: string; readonly path: string; readonly project: string } | null,
    string
  > => {
    const disposable = (project: string, baseRef: string) => {
      const name = stepKey(step, attempt);
      const key = `ws:${name}`;
      const ready = resultOf(key);
      if (ready?._tag === "WorkspaceReady")
        return Result.succeed({ name, path: ready.path, project });
      if (ready?._tag === "IntentFailed") return Result.fail(ready.error);
      record({ _tag: "PrepareWorkspace", key, name, projectRef: project, baseRef, branch: null });
      return Result.succeed(null);
    };
    if (typeof use !== "string") {
      const project = render(use.project, envFor(level));
      if (Result.isFailure(project)) return Result.fail(project.failure);
      // Every read-only checkout of a project starts from the sha pinned on first use.
      const pinKey = `pin:${project.success}`;
      const pin = resultOf(pinKey);
      if (pin?._tag === "IntentFailed") return Result.fail(pin.error);
      if (pin?._tag !== "RefResolved") {
        record({ _tag: "ResolveRef", key: pinKey, projectRef: project.success, ref: "HEAD" });
        return Result.succeed(null);
      }
      return disposable(project.success, pin.sha);
    }
    const decl = definition.workspaces?.[use];
    if (decl === undefined || !Object.hasOwn(definition.workspaces ?? {}, use)) {
      return Result.fail(
        `workspace ${use} is a block export, which arrives with the blocks (slice 7)`,
      );
    }
    const env = envFor(level);
    const project = render(decl.project, env);
    if (Result.isFailure(project)) return Result.fail(project.failure);
    const key = `ws:${use}`;
    const ready = resultOf(key);
    if (ready?._tag === "IntentFailed") return Result.fail(ready.error);
    if (ready?._tag !== "WorkspaceReady") {
      const branch = render(decl.branch, env);
      if (Result.isFailure(branch)) return Result.fail(branch.failure);
      if (!/^wf\/[A-Za-z0-9._/-]{1,120}$/.test(branch.success)) {
        return Result.fail(`branch "${branch.success}" is not a wf/… branch`);
      }
      let baseRef: string;
      if (decl.base.startsWith("workspace:")) {
        const head = workspaceHead(decl.base.slice("workspace:".length));
        if (head === null) return Result.fail(`${decl.base} has no HEAD yet`);
        baseRef = head;
      } else {
        const base = render(decl.base, env);
        if (Result.isFailure(base)) return Result.fail(base.failure);
        baseRef = base.success;
      }
      record({
        _tag: "PrepareWorkspace",
        key,
        name: use,
        projectRef: project.success,
        baseRef,
        branch: branch.success,
      });
      return Result.succeed(null);
    }
    if (access === "write")
      return Result.succeed({ name: use, path: ready.path, project: project.success });
    return disposable(project.success, workspaceHead(use) ?? ready.headSha);
  };

  // ── Dispatch and progress per kind ──────────────────────────────────────────────────────────

  const outputInstruction = (node: WorkflowAgentNode) =>
    node.output === undefined
      ? ""
      : `\n\nEnd your reply with a \`\`\`json block holding an object with these fields: ${JSON.stringify(node.output)}.`;

  const startTurn = (
    node: WorkflowAgentNode,
    step: string,
    attempt: number,
    level: Level,
  ): void => {
    const access = node.access ?? "read";
    const continued = node.thread?.startsWith("continue:")
      ? node.thread.slice("continue:".length)
      : null;
    if (continued !== null) {
      const previous = findStep(level, continued);
      const prevAttempt = previous === null ? undefined : latest(previous);
      const prevIntent =
        prevAttempt === undefined
          ? undefined
          : state.intents.get(`turn:${stepKey(prevAttempt.step, prevAttempt.attempt)}`)?.intent;
      if (prevAttempt?.threadId == null || prevIntent?._tag !== "StartTurn") {
        resolve(step, attempt, "failed", "fail", null, `the thread of ${continued} does not exist`);
        return;
      }
      const prompt = render(node.prompt, envFor(level, { step: { dir: stepDir(step, attempt) } }));
      if (Result.isFailure(prompt))
        return void resolve(step, attempt, "failed", "fail", null, prompt.failure);
      record({
        ...prevIntent,
        key: `turn:${stepKey(step, attempt)}`,
        step,
        attempt,
        threadId: prevAttempt.threadId,
        mode: "continue",
        prompt: prompt.success + outputInstruction(node),
        // The compiler keeps a thread on one model; the reservation is this step's own.
        reservation: node.tokenReservation ?? 0,
      });
      return;
    }
    const workspace = workspaceFor(node.workspace, access, step, attempt, level);
    if (Result.isFailure(workspace))
      return void resolve(step, attempt, "failed", "fail", null, workspace.failure);
    if (workspace.success === null) return;
    const model = resolveModelUse(node.model, definition.models);
    if (Result.isFailure(model))
      return void resolve(step, attempt, "failed", "fail", null, model.failure);
    const prompt = render(node.prompt, envFor(level, { step: { dir: stepDir(step, attempt) } }));
    if (Result.isFailure(prompt))
      return void resolve(step, attempt, "failed", "fail", null, prompt.failure);
    const key = `turn:${stepKey(step, attempt)}`;
    record({
      _tag: "StartTurn",
      key,
      step,
      attempt,
      threadId: stepThreadId(runId, key),
      mode: "new",
      projectRef: workspace.success.project,
      title: `${definition.title} · ${step}`,
      workspace: { name: workspace.success.name, path: workspace.success.path },
      prompt: prompt.success + outputInstruction(node),
      model: model.success,
      access,
      reservation: node.tokenReservation ?? 0,
    });
  };

  /** The owner's gate before a command: refused at once, waiting for Israel, or cleared. */
  const approval = (
    step: string,
    gateKey: string,
    argv: ReadonlyArray<string>,
  ): "go" | "wait" | { readonly refused: string } => {
    const verdict = classifyCommand(argv);
    if (verdict.kind === "forbidden" || verdict.kind === "inline-shell") {
      return { refused: verdict.reason };
    }
    if (verdict.kind !== "protected") return "go";
    const ask = `${step} wants to run \`${argv.join(" ")}\` (${verdict.action}: ${verdict.reason}). Approve?`;
    const decision = decisionOf(gateKey);
    if (decision === null) {
      record({
        _tag: "OpenGate",
        key: `open:${gateKey}`,
        step,
        gateKey,
        reason: "protected",
        ask,
        options: ["approve", "reject"],
        expiresAt: null,
      });
      return "wait";
    }
    if (decision.option !== "approve")
      return { refused: `Israel did not approve ${verdict.action}` };
    // The approval is for the argv the gate showed; one that renders differently now is not it.
    const shown = state.gates.get(gateKey)?.intent.ask;
    return shown === undefined || shown === ask
      ? "go"
      : { refused: "the command changed after Israel approved it; start a new run to ask again" };
  };

  /**
   * How a turn that did not complete ends its step. Only a turn upstream cancelled (a restart it
   * could not resume) is lost and replayed; a stop the engine did not send, such as Israel's in
   * the step thread, fails the step; the engine's own interrupt is a timeout.
   */
  const turnEnd = (
    status: "failed" | "cancelled" | "interrupted",
    interrupts: ReadonlyArray<string>,
  ): ResolvedStatus =>
    status === "failed"
      ? "failed"
      : cancelling
        ? "cancelled"
        : interrupts.some(has)
          ? "timed_out"
          : status === "interrupted"
            ? "failed"
            : "lost";

  const progressAgent = (node: WorkflowAgentNode, step: string, a: StepAttempt, level: Level) => {
    const key = `turn:${stepKey(step, a.attempt)}`;
    if (!has(key)) return startTurn(node, step, a.attempt, level);
    const launched = resultOf(key);
    if (launched?._tag === "IntentFailed") {
      return resolve(step, a.attempt, "failed", "fail", null, launched.error);
    }
    const settled = a.settled;
    if (settled === null) return;
    const ownInterrupts = [
      `interrupt:turn:${stepKey(step, a.attempt)}`,
      `interrupt:nudge:${stepKey(step, a.attempt)}`,
    ];
    // An outcome the engine could not observe may still be running: Israel decides, no retry does.
    if (settled.unobserved === true) return ambiguous(step, a.attempt, settled.text);
    if (settled.status !== "completed") {
      const status = turnEnd(settled.status, ownInterrupts);
      return resolve(step, a.attempt, status, "fail", null, settled.text);
    }
    let output: Json = { text: settled.text };
    if (node.output !== undefined) {
      // The compiler trusts declared fields in argv, env and refs: only a checked output goes on.
      const shape = node.output;
      const checked = (turn: { readonly output: Json; readonly outputError: string | null }) =>
        turn.outputError !== null
          ? Result.fail(turn.outputError)
          : checkOutput(shape, turn.output as JsonValue);
      const first = checked(settled);
      if (Result.isSuccess(first)) {
        output = first.success;
      } else {
        const nudgeKey = `nudge:${stepKey(step, a.attempt)}`;
        if (!has(nudgeKey)) {
          const turn = state.intents.get(key)?.intent;
          if (turn?._tag !== "StartTurn" || a.threadId === null) return;
          record({
            ...turn,
            key: nudgeKey,
            threadId: a.threadId,
            mode: "continue",
            prompt: `Your reply's JSON block was not valid: ${first.failure}.${outputInstruction(node)}`,
          });
          return;
        }
        const nudgeStart = resultOf(nudgeKey);
        if (nudgeStart?._tag === "IntentFailed") {
          return resolve(step, a.attempt, "failed", "fail", null, nudgeStart.error);
        }
        if (a.nudge === null) return;
        if (a.nudge.unobserved === true) return ambiguous(step, a.attempt, a.nudge.text);
        if (a.nudge.status !== "completed") {
          const status = turnEnd(a.nudge.status, ownInterrupts);
          return resolve(step, a.attempt, status, "fail", null, a.nudge.text);
        }
        const second = checked(a.nudge);
        if (Result.isFailure(second)) {
          return resolve(step, a.attempt, "failed", "fail", null, second.failure);
        }
        output = second.success;
      }
    }
    const accept = node.accept;
    if (accept === undefined) return resolve(step, a.attempt, "succeeded", "ok", output);
    const acceptKey = `accept:${stepKey(step, a.attempt)}`;
    const acceptResult = resultOf(acceptKey);
    if (acceptResult?._tag === "IntentFailed") {
      return resolve(step, a.attempt, "failed", "fail", output, acceptResult.error);
    }
    const turnIntent = state.intents.get(key)?.intent;
    if (turnIntent?._tag !== "StartTurn") return;
    if ("argv" in accept) {
      const exited = acceptExit(acceptKey);
      if (!has(acceptKey)) {
        const argv = renderArgv(accept.argv, envFor(level));
        if (Result.isFailure(argv))
          return resolve(step, a.attempt, "failed", "fail", output, argv.failure);
        const cleared = approval(step, `protect:${step}/accept@${a.attempt}`, argv.success);
        if (cleared === "wait") return;
        if (cleared !== "go")
          return resolve(step, a.attempt, "failed", "fail", output, cleared.refused);
        record({
          _tag: "StartUnit",
          key: acceptKey,
          step: `${step}/accept`,
          attempt: a.attempt,
          argv: argv.success,
          cwd: turnIntent.workspace,
          heavy: accept.heavy === true,
          replay: "safe",
          timeoutMs: durationMs(definition.budget.wall),
          env: {},
        });
        return;
      }
      if (exited === null) return;
      // An accept command whose outcome is unknown is no verdict: no check may read it.
      if (exited.signal === "TIMEOUT") {
        return resolve(step, a.attempt, "timed_out", "fail", output, exited.tail);
      }
      if (exited.signal === "UNOBSERVED") {
        return ambiguous(step, a.attempt, `the acceptance check: ${exited.tail}`);
      }
      if (exited.lost) {
        const why = "its unit vanished without an exit receipt";
        return resolve(step, a.attempt, "failed", "fail", output, `the acceptance check: ${why}`);
      }
      const check = evaluate(
        accept.check,
        envFor(level, { exit: exited.exit, out: exited.out as JsonValue }),
      );
      if (Result.isFailure(check))
        return resolve(step, a.attempt, "failed", "fail", output, check.failure);
      return resolve(
        step,
        a.attempt,
        "succeeded",
        isTruthy(check.success) ? "pass" : "fail",
        output,
      );
    }
    const judgeKey = `judge:${stepKey(step, a.attempt)}`;
    if (!has(judgeKey)) {
      const model = resolveModelUse(accept.judge, definition.models);
      if (Result.isFailure(model))
        return resolve(step, a.attempt, "failed", "fail", output, model.failure);
      const criterion = render(accept.criterion, envFor(level));
      if (Result.isFailure(criterion))
        return resolve(step, a.attempt, "failed", "fail", output, criterion.failure);
      record({
        ...turnIntent,
        key: judgeKey,
        step: `${step}/judge`,
        threadId: stepThreadId(runId, judgeKey),
        mode: "new",
        access: "read",
        model: model.success,
        prompt: `${criterion.success}\n\nJudge the work in this worktree. End with a \`\`\`json block: {"pass": boolean, "reason": string}.`,
      });
      return;
    }
    const judgeStart = resultOf(judgeKey);
    if (judgeStart?._tag === "IntentFailed") {
      return resolve(step, a.attempt, "failed", "fail", output, judgeStart.error);
    }
    const judged = attemptsOf(`${step}/judge`).find((x) => x.attempt === a.attempt)?.settled;
    if (judged?.unobserved === true) return ambiguous(step, a.attempt, `the judge: ${judged.text}`);
    if (judged != null && judged.status !== "completed") {
      const status = turnEnd(judged.status, [`interrupt:${judgeKey}`]);
      return resolve(step, a.attempt, status, "fail", output, judged.text);
    }
    const verdict = judgeVerdict(judgeKey);
    if (verdict === undefined) return;
    if (verdict === null)
      return resolve(step, a.attempt, "failed", "fail", output, "the judge gave no verdict");
    return resolve(step, a.attempt, "succeeded", verdict ? "pass" : "fail", output);
  };

  /** Accept and judge run as sub-steps keyed `<step>/accept` and `<step>/judge`. */
  const acceptExit = (key: string) => {
    const intent = state.intents.get(key)?.intent;
    if (intent?._tag !== "StartUnit") return null;
    return attemptsOf(intent.step).find((x) => x.attempt === intent.attempt)?.exited ?? null;
  };
  const judgeVerdict = (key: string): boolean | null | undefined => {
    const intent = state.intents.get(key)?.intent;
    if (intent?._tag !== "StartTurn") return undefined;
    const settled = attemptsOf(intent.step).find((x) => x.attempt === intent.attempt)?.settled;
    if (settled == null) return undefined;
    // A verdict counts only from a judge turn that completed with valid JSON.
    if (settled.status !== "completed" || settled.outputError !== null) return null;
    const output = settled.output;
    if (output === null || typeof output !== "object" || Array.isArray(output)) return null;
    const pass = (output as { readonly [k: string]: Json })["pass"];
    return typeof pass === "boolean" ? pass : null;
  };

  const renderArgv = (
    argv: ReadonlyArray<string>,
    env: EvalEnv,
  ): Result.Result<ReadonlyArray<string>, string> => {
    const rendered: string[] = [];
    for (const arg of argv) {
      const r = render(arg, env);
      if (Result.isFailure(r)) return Result.fail(r.failure);
      rendered.push(r.success);
    }
    return Result.succeed(rendered);
  };

  const progressCommand = (
    node: WorkflowCommandNode,
    step: string,
    a: StepAttempt,
    level: Level,
  ) => {
    const name = stepKey(step, a.attempt);
    const unitKey = `unit:${name}`;
    const env = envFor(level, { step: { dir: stepDir(step, a.attempt) } });
    if (!has(unitKey)) {
      const workspace = workspaceFor(node.cwd, "write", step, a.attempt, level);
      if (Result.isFailure(workspace))
        return resolve(step, a.attempt, "failed", "fail", null, workspace.failure);
      if (workspace.success === null) return;
      const argv = renderArgv(node.argv, env);
      if (Result.isFailure(argv))
        return resolve(step, a.attempt, "failed", "fail", null, argv.failure);
      const cleared = approval(step, `protect:${name}`, argv.success);
      if (cleared === "wait") return;
      if (cleared !== "go")
        return resolve(step, a.attempt, "failed", "fail", null, cleared.refused);
      const envVars = renderAll(node.env ?? {}, env);
      if (Result.isFailure(envVars))
        return resolve(step, a.attempt, "failed", "fail", null, envVars.failure);
      record({
        _tag: "StartUnit",
        key: unitKey,
        step,
        attempt: a.attempt,
        argv: argv.success,
        cwd: { name: workspace.success.name, path: workspace.success.path },
        heavy: node.heavy === true,
        replay: node.replay ?? "never",
        timeoutMs:
          node.timeout === undefined
            ? durationMs(definition.budget.wall)
            : durationMs(node.timeout),
        env: Object.fromEntries(Object.entries(envVars.success).map(([k, v]) => [k, String(v)])),
        parse: node.parse ?? "none",
      });
      return;
    }
    const spawned = resultOf(unitKey);
    if (spawned?._tag === "IntentFailed") {
      return resolve(step, a.attempt, "failed", "fail", null, spawned.error);
    }
    const exited = a.exited;
    if (exited === null) return;
    if (exited.lost) {
      if (!exited.started || (node.replay ?? "never") === "safe") {
        return resolve(
          step,
          a.attempt,
          "lost",
          "fail",
          null,
          "the unit stopped without an exit receipt",
        );
      }
      return ambiguous(
        step,
        a.attempt,
        "the command started and its unit vanished without an exit receipt",
      );
    }
    if (exited.signal === "TIMEOUT")
      return resolve(step, a.attempt, "timed_out", "fail", null, exited.tail);
    // The engine could not observe the unit: it may still run, so Israel decides, no retry or check.
    if (exited.signal === "UNOBSERVED") return ambiguous(step, a.attempt, exited.tail);
    if ((node.parse ?? "none") !== "none" && (exited.parseError ?? null) !== null) {
      return resolve(step, a.attempt, "failed", "fail", null, exited.parseError ?? null);
    }
    const out = exited.out;
    if (node.check !== undefined) {
      const check = evaluate(
        node.check,
        envFor(level, { exit: exited.exit, out: out as JsonValue }),
      );
      if (Result.isFailure(check))
        return resolve(step, a.attempt, "failed", "fail", out, check.failure);
      return resolve(step, a.attempt, "succeeded", isTruthy(check.success) ? "pass" : "fail", out);
    }
    return exited.exit === 0
      ? resolve(step, a.attempt, "succeeded", "ok", out)
      : resolve(step, a.attempt, "failed", "fail", out, exited.tail);
  };

  /** A command that may have run halfway pauses the run until Israel says what happened. */
  const ambiguous = (step: string, attempt: number, why: string) => {
    const gateKey = `ambiguous:${stepKey(step, attempt)}`;
    const decision = decisionOf(gateKey);
    if (decision === null) {
      record({
        _tag: "OpenGate",
        key: `open:${gateKey}`,
        step,
        gateKey,
        reason: "ambiguous",
        ask: `${step}: ${why}. Run it again, mark it failed, or cancel the run?`,
        options: [...AMBIGUOUS_OPTIONS],
        expiresAt: null,
      });
      if (state.paused === null) {
        emit(`pause:${state.pauseCount + 1}`, {
          _tag: "RunPaused",
          reason: "ambiguous",
          detail: why,
          at: nowIso,
        });
      }
      return;
    }
    // The run stays paused while any other ambiguous gate still waits for Israel.
    const othersOpen = [...state.gates.values()].some(
      (g) =>
        g.intent.reason === "ambiguous" &&
        g.intent.gateKey !== gateKey &&
        decisionOf(g.intent.gateKey) === null,
    );
    if (state.paused?.reason === "ambiguous" && !othersOpen) {
      emit(`resume:${state.resumeCount + 1}`, { _tag: "RunResumed", at: nowIso });
    }
    if (decision.option === "fail") return resolve(step, attempt, "failed", "fail", null, why);
    resolve(
      step,
      attempt,
      decision.option === "cancel" ? "cancelled" : "ambiguous",
      null,
      null,
      why,
    );
    if (decision.option === "cancel") cancelling = true;
  };

  // ── Graph ───────────────────────────────────────────────────────────────────────────────────

  const findStep = (level: Level, id: string): string | null => {
    for (let l: Level | null = level; l !== null; l = l.parent) {
      if (l.graph.nodes.has(id)) return l.prefix + id;
    }
    return null;
  };

  const dispatched = [...state.intents.values()].filter((e) => isStart(e.intent)).length;
  const overWall = ctx.now >= Date.parse(started.at) + started.budget.wallMs;
  /** A ready step was refused because the run used every step of its budget. */
  let refused = false;
  /** Whether the run takes new work: not paused, cancelling or past its wall. */
  const open = () => !pausedNow && !cancelling && !overWall;
  /** Whether a start fits the step budget; only starts spend it, so outputs and branches still run. */
  const admits = () => {
    if (!open()) return false;
    if (dispatched + startsNow < started.budget.steps) return true;
    refused = true;
    return false;
  };

  /** Starts attempt `attempt` of a step: guards, then the kind's first intent or fact. */
  const dispatch = (node: WorkflowNode, step: string, attempt: number, level: Level) => {
    if (!open()) return;
    switch (node.kind) {
      case "agent":
        return startTurn(node, step, attempt, level);
      case "command":
        return progressCommand(node, step, { ...emptyAttempt(step, attempt) }, level);
      case "gate": {
        const gateKey = stepKey(step, attempt);
        const decision = decisionOf(gateKey);
        if (decision !== null) return resolve(step, attempt, "succeeded", decision.option);
        const ask = render(node.ask, envFor(level));
        if (Result.isFailure(ask))
          return resolve(step, attempt, "failed", "fail", null, ask.failure);
        record({
          _tag: "OpenGate",
          key: `open:${gateKey}`,
          step,
          gateKey,
          reason: "gate",
          ask: ask.success,
          options: [...(node.options ?? ["approve", "reject"])],
          expiresAt:
            node.expires === undefined ? null : isoOf(ctx.now + durationMs(node.expires.after)),
        });
        return;
      }
      case "branch": {
        const env = envFor(level);
        for (const c of node.cases) {
          const r = evaluate(c.when, env);
          if (Result.isFailure(r)) return resolve(step, attempt, "failed", "fail", null, r.failure);
          if (isTruthy(r.success)) return resolve(step, attempt, "succeeded", c.port);
        }
        return resolve(step, attempt, "succeeded", node.else ?? null);
      }
      case "output": {
        const env = envFor(level);
        const valueResult = renderAll(node.value, env);
        if (Result.isFailure(valueResult)) {
          return resolve(step, attempt, "failed", "fail", null, valueResult.failure);
        }
        const report = node.report === undefined ? null : render(node.report, env);
        const handoff = node.handoff === undefined ? null : render(node.handoff, env);
        if (report !== null && Result.isFailure(report))
          return resolve(step, attempt, "failed", "fail", null, report.failure);
        if (handoff !== null && Result.isFailure(handoff))
          return resolve(step, attempt, "failed", "fail", null, handoff.failure);
        resolve(step, attempt, "succeeded", null, valueResult.success as Json);
        if (level.parent === null) {
          emit(once("output"), {
            _tag: "OutputSet",
            status: node.status,
            value: valueResult.success as { readonly [key: string]: Json },
            report: report?.success ?? null,
            handoff: handoff?.success ?? null,
          });
        }
        return;
      }
      case "call":
        return startChild(node, step, attempt, level);
      case "map":
      case "loop":
        return progressBody(node, step, attempt, level);
      case "hillclimb":
      case "arena":
      case "graph":
      case "interrogate":
        return resolve(
          step,
          attempt,
          "failed",
          "fail",
          null,
          `${node.kind} blocks arrive with slice 7`,
        );
    }
  };

  const startChild = (
    node: Extract<WorkflowNode, { readonly kind: "call" }>,
    step: string,
    attempt: number,
    level: Level,
  ) => {
    const key = `child:${stepKey(step, attempt)}`;
    if (has(key)) return;
    const params = renderAll(node.params, envFor(level));
    if (Result.isFailure(params))
      return resolve(step, attempt, "failed", "fail", null, params.failure);
    record({
      _tag: "StartChildRun",
      key,
      step,
      attempt,
      workflowId: node.workflow,
      params: params.success as { readonly [key: string]: Json },
    });
  };

  /** Map items and loop iterations run their body as levels with their own step-key prefix. */
  const progressBody = (
    node: Extract<WorkflowNode, { readonly kind: "map" | "loop" }>,
    step: string,
    attempt: number,
    level: Level,
  ) => {
    const body = level.graph.nodes.get(step.slice(level.prefix.length))?.body ?? null;
    if (body === null)
      return resolve(step, attempt, "failed", "fail", null, "the body did not compile");
    // A retried container runs a fresh body: attempt n > 1 scopes its keys under `<step>/r<n>`.
    const scope = attempt === 1 ? step : `${step}/r${attempt}`;
    if (node.kind === "map") {
      let items = state.expansions.get(scope);
      if (items === undefined) {
        const r = evaluate(node.items, envFor(level));
        if (Result.isFailure(r)) return resolve(step, attempt, "failed", "fail", null, r.failure);
        if (!Array.isArray(r.success))
          return resolve(step, attempt, "failed", "fail", null, "items is not a list");
        items = (r.success as ReadonlyArray<Json>).slice(0, node.maxItems);
        emit(`expand:${scope}`, { _tag: "MapExpanded", step: scope, items });
      }
      const results: Json[] = [];
      let active = 0;
      for (const [index, item] of items.entries()) {
        const instance: Level = {
          graph: body,
          prefix: `${scope}[${index}]/`,
          parent: level,
          item: { value: item, alias: node.as ?? null },
          iteration: index,
        };
        const begun = [...body.nodes.keys()].some(
          (id) => latest(instance.prefix + id) !== undefined || isSkipped(instance.prefix + id),
        );
        if (!begun && active >= node.concurrency) return;
        const outcome = advance(instance);
        if (!outcome.done) {
          active++;
          continue;
        }
        if (outcome.failed !== null) {
          return resolve(step, attempt, "failed", "fail", null, `item ${index}: ${outcome.failed}`);
        }
        if (node.collect === undefined) {
          results.push(outcome.output);
        } else {
          const collected = renderAll(node.collect, envFor(instance));
          if (Result.isFailure(collected))
            return resolve(step, attempt, "failed", "fail", null, collected.failure);
          results.push(collected.success as Json);
        }
      }
      if (results.length === items.length) resolve(step, attempt, "succeeded", "ok", results);
      return;
    }
    let current = state.iterations.get(scope);
    if (current === undefined) {
      current = 0;
      emit(`iter:${scope}:0`, { _tag: "IterationStarted", step: scope, index: 0 });
    }
    // Iterations that finish in this pass hand over to the next one in the same pass.
    while (true) {
      const instance: Level = {
        graph: body,
        prefix: `${scope}[${current}]/`,
        parent: level,
        item: null,
        iteration: current,
      };
      const outcome = advance(instance);
      if (!outcome.done) return;
      if (outcome.failed !== null) {
        return resolve(
          step,
          attempt,
          "failed",
          "fail",
          null,
          `iteration ${current}: ${outcome.failed}`,
        );
      }
      const until = evaluate(node.until, envFor(instance));
      if (Result.isFailure(until))
        return resolve(step, attempt, "failed", "fail", null, until.failure);
      if (isTruthy(until.success)) return resolve(step, attempt, "succeeded", "ok", outcome.output);
      if (current + 1 >= node.max) {
        return resolve(
          step,
          attempt,
          "failed",
          "fail",
          outcome.output,
          `until stayed false for ${node.max} iterations`,
        );
      }
      current += 1;
      emit(`iter:${scope}:${current}`, { _tag: "IterationStarted", step: scope, index: current });
    }
  };

  /** Moves one level instance forward and says whether it is done. */
  function advance(level: Level): LevelOutcome {
    let failed: string | null = null;
    let output: Json = null;
    let done = true;
    for (const id of level.graph.order) {
      const compiled = level.graph.nodes.get(id);
      if (compiled === undefined) continue;
      const node = compiled.node;
      const step = level.prefix + id;
      // Act first, then read the outcome again, so successors in this same pass see it.
      if (finalOf(node, step) === null && failed === null) stepForward(compiled, step, level);
      const final = finalOf(node, step);
      if (final === null) {
        done = false;
        continue;
      }
      if (final.status !== "skipped" && final.status !== "succeeded" && final.port === "fail") {
        const handled = compiled.outgoing.some((e) => e.port === "fail");
        if (!handled && node.continueOnFail !== true) failed ??= `${id} ${final.status}`;
      }
      if (node.kind === "output" && final.status === "succeeded") output = final.output;
    }
    // An output reached in a body ends that instance even if other branches are still open.
    if (level.parent !== null && output !== null) return { done: true, failed, output };
    // An unhandled failure ends the level now; the run's end interrupts what still runs.
    if (failed !== null) return { done: true, failed, output };
    return done ? { done: true, failed, output } : { done: false };
  }

  /** One step's next move: settle what it observed, start its next attempt, or start it. */
  function stepForward(compiled: CompiledNode, step: string, level: Level) {
    const node = compiled.node;
    const current = latest(step);
    if (current === undefined) {
      if (!startStep(compiled, step, level)) return;
    } else if (resolutionOf(current) === null) {
      progress(node, step, current, level);
    }
    // Whatever just resolved may be retried at once (a `map`, `loop` or `branch` resolves while dispatching).
    const a = latest(step);
    const r = a === undefined ? null : resolutionOf(a);
    if (a === undefined || r === null || !open()) return;
    const ready = retryReadyAt(
      node,
      a.attempt,
      r.status,
      r.at,
      markedFailed(step, a.attempt),
      rerunWanted(a),
    );
    if (ready !== null && ctx.now >= ready) dispatch(node, step, a.attempt + 1, level);
  }

  /** Readiness, guard and first dispatch of a step that has no attempt; false when it did not start. */
  function startStep(compiled: CompiledNode, step: string, level: Level): boolean {
    const node = compiled.node;
    const ready = readiness(compiled.incoming, level, node.join ?? "all");
    if (ready === "wait") return false;
    if (ready === "dead") {
      skip(step, "dead-path");
      return false;
    }
    if (!open()) return false;
    if (node.when !== undefined) {
      const guard = evaluate(node.when, envFor(level));
      if (Result.isFailure(guard)) {
        resolve(step, 1, "failed", "fail", null, guard.failure);
        return true;
      }
      if (!isTruthy(guard.success)) {
        skip(step, "guard");
        return false;
      }
    }
    dispatch(node, step, 1, level);
    return true;
  }

  const progress = (node: WorkflowNode, step: string, a: StepAttempt, level: Level) => {
    switch (node.kind) {
      case "agent":
        return progressAgent(node, step, a, level);
      case "command":
        return progressCommand(node, step, a, level);
      case "gate": {
        const decision = decisionOf(stepKey(step, a.attempt));
        if (decision !== null) resolve(step, a.attempt, "succeeded", decision.option);
        return;
      }
      case "call": {
        const childKey = `child:${stepKey(step, a.attempt)}`;
        if (!has(childKey)) return startChild(node, step, a.attempt, level);
        const startedChild = resultOf(childKey);
        if (startedChild?._tag === "IntentFailed") {
          return resolve(step, a.attempt, "failed", "fail", null, startedChild.error);
        }
        const ended =
          a.child ??
          (startedChild?._tag === "ChildRunStarted"
            ? (state.children.get(startedChild.childRunId) ?? null)
            : null);
        if (ended === null) return;
        return ended.status === "succeeded"
          ? resolve(step, a.attempt, "succeeded", "ok", ended.output)
          : resolve(step, a.attempt, "failed", "fail", ended.output, `child run ${ended.status}`);
      }
      case "map":
      case "loop":
        return progressBody(node, step, a.attempt, level);
      default:
        return dispatch(node, step, a.attempt, level);
    }
  };

  const readiness = (
    incoming: CompiledGraph["edges"],
    level: Level,
    join: "all" | "any",
  ): "ready" | "wait" | "dead" => {
    if (incoming.length === 0) return "ready";
    let satisfied = 0;
    let pending = 0;
    for (const edge of incoming) {
      const from = level.graph.nodes.get(edge.from);
      if (from === undefined) continue;
      const final = finalOf(from.node, level.prefix + edge.from);
      if (final === null) pending++;
      else if (final.status !== "skipped" && final.port === edge.port) satisfied++;
    }
    if (join === "any" && satisfied > 0) return "ready";
    if (pending > 0) return "wait";
    return satisfied > 0 ? "ready" : "dead";
  };

  /** Work in flight: a start recorded and not answered yet, or answered and still running. */
  const anyRunning = (): boolean =>
    startsNow > 0 ||
    [...state.intents.values()].some((entry) => {
      const intent = entry.intent;
      if (!isStart(intent) || !("attempt" in intent)) return false;
      if (entry.result !== null) return liveTarget(entry, state) !== null;
      const attempt = latest(intent.step);
      return attempt?.attempt === intent.attempt && resolutionOf(attempt) === null;
    });

  // ── The run ─────────────────────────────────────────────────────────────────────────────────

  // 1. Controls. Any cancel cancels; of pause and resume only the latest acts, keyed by its own
  // control so it applies once and an old pause never comes back after a resume.
  // Controls before the run last reopened were for the run that ended.
  const liveControls = state.controls.filter((c) => c.seq > state.reopenedSeq);
  for (const { control } of liveControls) if (control.control === "cancel") cancelling = true;
  const toggle = [...liveControls]
    .reverse()
    .find(({ control }) => control.control === "pause" || control.control === "resume");
  if (toggle?.control.control === "pause" && !pausedNow) {
    emit(`pause:${toggle.key}`, {
      _tag: "RunPaused",
      reason: "user",
      detail: toggle.control.by,
      at: nowIso,
    });
  }
  if (toggle?.control.control === "resume" && state.paused?.reason === "user") {
    emit(`resume:${toggle.key}`, { _tag: "RunResumed", at: nowIso });
  }

  // 2. Runtime requests: decline, or ask Israel when the step allows it.
  for (const request of state.requests.values()) {
    const answerKey = `answer:${request.requestId}`;
    if (has(answerKey)) continue;
    const node = nodeAt(compiled, request.step);
    if (node?.kind === "agent" && node.askIsrael === true) {
      const gateKey = `ask:${request.requestId}`;
      const decision = decisionOf(gateKey);
      if (decision === null) {
        record({
          _tag: "OpenGate",
          key: `open:${gateKey}`,
          step: request.step,
          gateKey,
          reason: "question",
          ask: request.text,
          options: ["answer", "decline"],
          expiresAt: null,
        });
        continue;
      }
      record({
        _tag: "AnswerRequest",
        key: answerKey,
        threadId: request.threadId,
        requestId: request.requestId,
        answer: decision.option === "answer" ? { text: decision.note ?? "" } : "decline",
      });
      continue;
    }
    record({
      _tag: "AnswerRequest",
      key: answerKey,
      threadId: request.threadId,
      requestId: request.requestId,
      answer: "decline",
    });
  }

  /** Interrupts every running start the predicate selects, each under `interrupt:<intent key>`. */
  const interruptLive = (select: (intent: Intent) => boolean = () => true) => {
    for (const entry of state.intents.values()) {
      const target = liveTarget(entry, state);
      if (target === null || !select(entry.intent) || !("step" in entry.intent)) continue;
      record({
        _tag: "Interrupt",
        key: `interrupt:${entry.intent.key}`,
        step: entry.intent.step,
        target,
      });
    }
  };

  // 3. Gate expiry and step timeouts.
  for (const [gateKey, gate] of state.gates) {
    const expiresAt = gate.intent.expiresAt;
    if (gate.decision !== null || expiresAt === null || ctx.now < Date.parse(expiresAt)) continue;
    const node = nodeAt(compiled, gate.intent.step);
    const option = node?.kind === "gate" ? node.expires?.decision : undefined;
    if (option === undefined) continue;
    emit(`gate:${gateKey}`, {
      _tag: "GateDecided",
      gateKey,
      option,
      note: null,
      by: "expiry",
      at: nowIso,
    });
  }
  // Units enforce their own timeout (StartUnit.timeoutMs); a turn past its step's timeout is interrupted.
  interruptLive((intent) => {
    if (intent._tag !== "StartTurn") return false;
    const limit = nodeAt(compiled, intent.step)?.timeout;
    const startedAt = latest(intent.step)?.startedAt ?? null;
    return (
      limit !== undefined &&
      startedAt !== null &&
      ctx.now >= Date.parse(startedAt) + durationMs(limit)
    );
  });

  // 4. The graph.
  const top: Level = {
    graph: compiled.root,
    prefix: "",
    parent: null,
    item: null,
    iteration: null,
  };
  const outcome = advance(top);

  // 5. The end: atomic with its outcome, its notices and the runs it starts.
  const endWith = (status: "succeeded" | "failed" | "cancelled" | "budget_exhausted") => {
    emit(once("ended"), { _tag: "RunEnded", status, at: nowIso });
    interruptLive();
    // Nothing stays running in an ended run: every attempt without an outcome ends with it. An
    // accept or judge sub-step is never resolved itself; views read its own exit or settle.
    for (const step of new Set([...state.attempts.keys(), ...overlay.keys()])) {
      if (isSubStep(step)) continue;
      const a = latest(step);
      if (a !== undefined && resolutionOf(a) === null) {
        resolve(step, a.attempt, "cancelled", null, null, `the run ended ${status}`);
      }
    }
    emit(
      once(`outcome:${runId}`),
      { _tag: "RunOutcome", runId, status },
      workflowStream(started.workflowId),
    );
    if (started.parent !== null) {
      let value: Json = state.output?.value ?? null;
      for (const f of out) if (f.fact._tag === "OutputSet") value = f.fact.value;
      emit(
        `child:${runId}`,
        {
          _tag: "ChildRunEnded",
          childRunId: runId,
          status,
          output: value,
          cost: {
            billable: 0,
            input: 0,
            output: 0,
            cacheRead: 0,
            usage: "unavailable",
            usdEstimate: null,
          },
        },
        runStream(started.parent.runId),
      );
    }
    const runPath = `/workflows/runs/${runId}`;
    if (status === "succeeded") {
      const node = outputNodeReached(compiled, state, out);
      if (node?.notify === true) {
        record({
          _tag: "Notify",
          key: once("notify:end"),
          kind: "finished",
          title: definition.title,
          body: node.status,
          runPath,
        });
      }
      return;
    }
    record({
      _tag: "Notify",
      key: once("notify:end"),
      kind: "failed",
      title: definition.title,
      body: status,
      runPath,
    });
    if (status !== "failed" || started.causalDepth + 1 >= 2) return;
    for (const subscriber of ctx.failureSubscribers) {
      if (subscriber.workflowId === started.workflowId) continue;
      const occurrence = once(`run-failed:${runId}`);
      emit(
        occurrence,
        {
          _tag: "TriggerFired",
          runId: runIdFor(subscriber.workflowId, occurrence),
          triggerId: subscriber.triggerId,
          kind: "workflowFailed",
          occurrence,
          label: `${definition.title} failed`,
          params: {},
          payload: { runId, workflowId: started.workflowId },
          causalDepth: started.causalDepth + 1,
          parent: null,
          at: nowIso,
        },
        workflowStream(subscriber.workflowId),
      );
    }
  };

  const outputReached = state.output !== null || out.some((f) => f.fact._tag === "OutputSet");
  if (cancelling) endWith("cancelled");
  else if (outputReached) endWith("succeeded");
  else if (outcome.done) endWith(outcome.failed === null ? "succeeded" : "failed");
  else if (overWall || (refused && !anyRunning())) endWith("budget_exhausted");

  // Needs-you notices: one per opened gate, keyed by the gate.
  for (const fact of out) {
    if (fact.fact._tag !== "IntentRecorded" || fact.fact.intent._tag !== "OpenGate") continue;
    const gate = fact.fact.intent;
    record({
      _tag: "Notify",
      key: `notify:gate:${gate.gateKey}`,
      kind: "needs_you",
      title: definition.title,
      body: gate.ask,
      runPath: `/workflows/runs/${runId}`,
    });
  }
  return out;
};

/** The node a step key names: the last path segment, without its `[i]` index. */
const nodeAt = (compiled: CompiledWorkflow, step: string): WorkflowNode | undefined => {
  const id = nodeIdOfStep(step);
  const search = (graph: CompiledGraph): WorkflowNode | undefined => {
    for (const [nodeId, node] of graph.nodes) {
      if (nodeId === id) return node.node;
      if (node.body !== null) {
        const found = search(node.body);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  return search(compiled.root);
};

const outputNodeReached = (
  compiled: CompiledWorkflow,
  state: RunState,
  out: ReadonlyArray<NewFact>,
): Extract<WorkflowNode, { readonly kind: "output" }> | undefined => {
  for (const [id, node] of compiled.root.nodes) {
    if (node.node.kind !== "output") continue;
    const resolved =
      state.attempts.get(id)?.some((a) => a.resolved?.status === "succeeded") === true ||
      out.some((f) => f.fact._tag === "StepResolved" && f.fact.step === id);
    if (resolved) return node.node;
  }
  return undefined;
};

/** The next instant at which `decide` would act without a new fact (timeouts, gate expiry, backoff). */
/**
 * The earliest instant after `now` at which `decide` would act without a new fact: the wall
 * budget, a gate's expiry, a live turn's timeout, a retry's backoff. Epoch milliseconds, or null.
 */
export const nextDeadline = (
  compiled: CompiledWorkflow,
  state: RunState,
  now: number,
): number | null => {
  const started = state.started;
  if (started === null || state.ended !== null) return null;
  const candidates: number[] = [Date.parse(started.at) + started.budget.wallMs];
  for (const gate of state.gates.values()) {
    if (gate.decision === null && gate.intent.expiresAt !== null)
      candidates.push(Date.parse(gate.intent.expiresAt));
  }
  for (const entry of state.intents.values()) {
    const intent = entry.intent;
    if (intent._tag !== "StartTurn" || liveTarget(entry, state) === null) continue;
    if (state.keys.has(`interrupt:${intent.key}`)) continue;
    const timeout = nodeAt(compiled, intent.step)?.timeout;
    const startedAt = state.attempts
      .get(intent.step)
      ?.find((a) => a.attempt === intent.attempt)?.startedAt;
    if (timeout !== undefined && startedAt != null) {
      candidates.push(Date.parse(startedAt) + durationMs(timeout));
    }
  }
  for (const attempts of state.attempts.values()) {
    const a = attempts.at(-1);
    const node = a === undefined ? undefined : nodeAt(compiled, a.step);
    if (a?.resolved == null || node === undefined) continue;
    const marked = state.gates.get(`ambiguous:${a.step}@${a.attempt}`)?.decision?.option === "fail";
    // A rerun is dispatched in the pass that sees it, so it needs no deadline.
    const ready = retryReadyAt(node, a.attempt, a.resolved.status, a.resolved.at, marked, false);
    if (ready !== null) candidates.push(ready);
  }
  const future = candidates.filter((at) => Number.isFinite(at) && at > now);
  return future.length === 0 ? null : Math.min(...future);
};
