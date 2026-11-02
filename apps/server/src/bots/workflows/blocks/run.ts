/**
 * Drives one block step for one pass: builds its `BlockIO` over the run decider's primitives,
 * lets the block derive and decide, then settles the children it observed. Every child intent is
 * keyed by the child's step (`turn:<scope>/<child>@1`, `ws:<scope>/<child>`, …), so the same
 * request on every pass records once and a replay after a crash reaches the same receipt.
 */
import * as DateTime from "effect/DateTime";
import type * as Result from "effect/Result";
import type { Json } from "effect/Schema";

import type {
  WorkflowFieldSpec,
  WorkflowModelRef,
  WorkflowModelUse,
  WorkflowOutputShape,
} from "@t3tools/contracts";
import type { JsonValue } from "@t3tools/shared/workflows";

import { liveTarget } from "../fold.ts";
import { type Fact, type Intent, ledgerStream } from "../facts.ts";
import { stepThreadId } from "../ids.ts";
import type { BlockEventEntry, RunState, StepAttempt } from "../state.ts";
import { emptyLedger, type LedgerState } from "./ledger.ts";
import { blockReader, blockScope, childKeys, childStep } from "./reader.ts";
import type {
  BlockDecider,
  BlockIO,
  BlockKind,
  BlockNode,
  BlockWorkspace,
  Claim,
  TurnObservation,
  UnitObservation,
} from "./types.ts";

const isoOf = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

type ResolvedStatus = "succeeded" | "failed" | "lost" | "timed_out" | "cancelled" | "ambiguous";

/** The run decider's primitives a block runs on. */
export interface BlockHost {
  readonly state: RunState;
  readonly now: number;
  readonly runDir: string;
  readonly title: string;
  readonly workflowId: string;
  readonly ledgers: ReadonlyMap<string, LedgerState>;
  /** Reservation of a child turn that names none. */
  readonly defaultReservation: number;
  readonly has: (key: string) => boolean;
  readonly latest: (step: string) => StepAttempt | undefined;
  /** Records an intent; a start the budget does not admit is dropped (the key stays absent). */
  readonly record: (intent: Intent) => void;
  readonly emit: (key: string, fact: Fact, stream?: string) => void;
  readonly resolve: (
    step: string,
    attempt: number,
    status: ResolvedStatus,
    port: string | null,
    output?: Json,
    error?: string | null,
  ) => void;
  /** The owner's gate before a protected command. */
  readonly approval: (
    step: string,
    gateKey: string,
    argv: ReadonlyArray<string>,
  ) => "go" | "wait" | { readonly refused: string };
  readonly stepDir: (step: string, attempt: number) => string;
  readonly render: (
    template: string,
    roots: { readonly [root: string]: JsonValue },
  ) => Result.Result<string, string>;
  readonly evaluate: (
    expr: string,
    roots: { readonly [root: string]: JsonValue },
  ) => Result.Result<JsonValue, string>;
  readonly model: (use: WorkflowModelUse) => Result.Result<WorkflowModelRef, string>;
  readonly namedWorkspace: (name: string) => BlockWorkspace | null;
}

const FIELD_TYPES: Record<WorkflowFieldSpec["type"], string> = {
  string: "a string",
  number: "a number",
  boolean: "true or false",
  "string[]": "an array of strings",
  "number[]": "an array of numbers",
  json: "any JSON value except null",
};

/** Words the shape as keys and value types: shown the raw schema, cheap models echo it back. */
export const outputInstruction = (shape: WorkflowOutputShape | undefined): string => {
  if (shape === undefined) return "";
  const keys = Object.entries(shape).map(
    ([name, field]) =>
      `"${name}" (${FIELD_TYPES[field.type]}${field.pattern === undefined ? "" : ` matching ${field.pattern}`}${field.optional ? ", optional" : ""})`,
  );
  return `\n\nEnd your reply with a \`\`\`json block holding one object whose keys are ${keys.join(", ")}.`;
};

/** True once the block's first pass recorded its `started` event. */
export const blockBegun = (state: RunState, step: string, attempt: number): boolean =>
  (state.blocks.get(blockScope(step, attempt)) ?? []).some((e) => e.id === "started");

export const runBlock = <K extends BlockKind, State>(
  decider: BlockDecider<K, State>,
  node: BlockNode<K>,
  step: string,
  attempt: number,
  host: BlockHost,
): void => {
  const state = host.state;
  const scope = blockScope(step, attempt);
  const runId = state.runId;
  const events: BlockEventEntry[] = [...(state.blocks.get(scope) ?? [])];
  const event = (id: string, payload: Json) => {
    const key = `block:${scope}:${id}`;
    if (host.has(key)) return;
    host.emit(key, { _tag: "BlockAdvanced", step: scope, id, event: payload });
    events.push({ id, seq: state.lastSeq + 1, event: payload });
  };
  event("started", null);

  const reader = blockReader(state, step, attempt, host.now, {
    has: host.has,
    latest: host.latest,
    events,
  });
  /** Children read this pass, settled by default at the end unless the block overrode them. */
  const observed = new Map<string, () => void>();
  const overridden = new Set<string>();
  const settle = (s: string, status: ResolvedStatus, output: Json, error: string | null) => {
    if (host.latest(s)?.resolved) return;
    host.resolve(s, 1, status, status === "succeeded" ? "ok" : "fail", output, error);
  };

  const turnStatus = (s: string, o: Extract<TurnObservation, { _tag: "Settled" }>) => {
    if (o.ok) return "succeeded" as const;
    if (o.status === "completed" || o.status === "failed") return "failed" as const;
    const interrupted =
      host.has(`interrupt:${childKeys(s).turn}`) || host.has(`interrupt:${childKeys(s).nudge}`);
    return interrupted ? ("timed_out" as const) : ("lost" as const);
  };

  const turn = (child: string, request: Parameters<BlockIO["turn"]>[1]): TurnObservation => {
    const s = childStep(scope, child);
    const keys = childKeys(s);
    if (!host.has(keys.turn)) {
      let threadId: string = stepThreadId(runId, keys.turn);
      let mode: "new" | "continue" = "new";
      let workspace = { name: request.workspace.name, path: request.workspace.path };
      if (request.continues !== undefined) {
        const previous = childKeys(childStep(scope, request.continues)).turn;
        const prevIntent = state.intents.get(previous)?.intent;
        const prevThread = host.latest(childStep(scope, request.continues))?.threadId ?? null;
        if (prevIntent?._tag !== "StartTurn" || prevThread === null)
          return { _tag: "Failed", error: `the thread of ${request.continues} does not exist` };
        threadId = prevThread;
        mode = "continue";
        workspace = prevIntent.workspace;
      }
      host.record({
        _tag: "StartTurn",
        key: keys.turn,
        step: s,
        attempt: 1,
        threadId,
        mode,
        projectRef: request.workspace.project,
        title: `${host.title} · ${s}`,
        workspace,
        prompt: request.prompt + outputInstruction(request.output),
        model: request.model,
        access: request.access,
        reservation: request.reservation ?? host.defaultReservation,
        ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
      });
      return { _tag: "Waiting" };
    }
    const seen = reader.turnOf(child);
    if (seen._tag !== "Settled") return seen;
    const settled = host.latest(s)?.settled ?? null;
    if (request.output !== undefined && settled?.status === "completed") {
      if (settled.outputError !== null) {
        const turnIntent = state.intents.get(keys.turn)?.intent;
        if (!host.has(keys.nudge)) {
          if (turnIntent?._tag !== "StartTurn") return { _tag: "Waiting" };
          host.record({
            ...turnIntent,
            key: keys.nudge,
            threadId: seen.threadId,
            mode: "continue",
            prompt: `Your reply had no valid JSON block (${settled.outputError}).${outputInstruction(request.output)}`,
          });
          return { _tag: "Waiting" };
        }
        const nudgeResult = state.intents.get(keys.nudge)?.result ?? null;
        if (nudgeResult?._tag === "IntentFailed") {
          const failed = { ...seen, ok: false, error: nudgeResult.error };
          observed.set(s, () => settle(s, "failed", null, nudgeResult.error));
          return failed;
        }
        const nudge = host.latest(s)?.nudge ?? null;
        if (nudge === null) return { _tag: "Waiting" };
        const ok = nudge.status === "completed" && nudge.outputError === null;
        const result = {
          ...seen,
          ok,
          status: nudge.status,
          text: nudge.text,
          output: nudge.output,
          error: ok ? null : (nudge.outputError ?? nudge.text),
        };
        observed.set(s, () =>
          settle(s, ok ? "succeeded" : turnStatus(s, result), result.output, result.error),
        );
        return result;
      }
    }
    observed.set(s, () => settle(s, turnStatus(s, seen), seen.output, seen.error));
    return seen;
  };

  const unit = (child: string, request: Parameters<BlockIO["unit"]>[1]): UnitObservation => {
    const s = childStep(scope, child);
    const key = childKeys(s).unit;
    if (!host.has(key)) {
      const cleared = host.approval(s, `protect:${s}@1`, request.argv);
      if (cleared === "wait") return { _tag: "Waiting" };
      if (cleared !== "go") return { _tag: "Failed", error: cleared.refused };
      const env = { ...request.env };
      if (request.reservation !== undefined) env.WF_TOKEN_BUDGET = String(request.reservation);
      host.record({
        _tag: "StartUnit",
        key,
        step: s,
        attempt: 1,
        argv: [...request.argv],
        cwd: { name: request.cwd.name, path: request.cwd.path },
        heavy: request.heavy,
        replay: request.replay,
        timeoutMs: request.timeoutMs,
        env,
        parse: request.parse ?? "none",
        ...(request.reservation === undefined ? {} : { reservation: request.reservation }),
        ...(request.tokensFrom === undefined ? {} : { tokensFrom: request.tokensFrom }),
      });
      return { _tag: "Waiting" };
    }
    const seen = reader.unitOf(child);
    if (seen._tag === "Exited") {
      const status: ResolvedStatus = seen.ok
        ? "succeeded"
        : seen.lost
          ? "lost"
          : seen.signal === "TIMEOUT"
            ? "timed_out"
            : "failed";
      observed.set(s, () =>
        settle(s, status, seen.out, seen.ok ? null : (seen.parseError ?? seen.tail)),
      );
    }
    return seen;
  };

  const workspace: BlockIO["workspace"] = (child, request) => {
    const s = childStep(scope, child);
    const key = childKeys(s).workspace;
    if (!host.has(key)) {
      host.record({
        _tag: "PrepareWorkspace",
        key,
        name: s,
        projectRef: request.project,
        baseRef: request.baseRef,
        branch: request.branch,
      });
      return { _tag: "Waiting" };
    }
    return reader.workspaceOf(child);
  };

  const gitOp = (
    child: string,
    ws: BlockWorkspace,
    op: Extract<Intent, { _tag: "GitOp" }>["op"],
  ) => {
    const key = childKeys(childStep(scope, child)).git;
    if (!host.has(key)) {
      host.record({ _tag: "GitOp", key, workspace: ws.name, op });
      return { _tag: "Waiting" } as const;
    }
    return reader.gitOf(child);
  };

  const ledgerOf = (id: string) => host.ledgers.get(id) ?? emptyLedger(id);

  const register: BlockIO["register"] = (ledgerId, child, entry): Claim => {
    const s = childStep(scope, child);
    const existing = ledgerOf(ledgerId).entries.get(entry.key);
    if (existing !== undefined)
      return existing.runId === runId && existing.step === s ? "mine" : "taken";
    host.emit(
      `entry:${entry.key}`,
      {
        _tag: "EntryRegistered",
        key: entry.key,
        workflowId: host.workflowId,
        runId,
        step: s,
        hypothesis: entry.hypothesis,
        barHash: entry.barHash,
        at: isoOf(host.now),
      },
      ledgerStream(ledgerId),
    );
    return "pending";
  };

  const seeTree: BlockIO["seeTree"] = (ledgerId, treeHash, entryKey): Claim => {
    const claim = ledgerOf(ledgerId).trees.get(treeHash);
    if (claim !== undefined)
      return claim.entryKey === entryKey && claim.runId === runId ? "mine" : "taken";
    host.emit(
      `tree:${treeHash}`,
      { _tag: "TreeSeen", treeHash, entryKey, runId },
      ledgerStream(ledgerId),
    );
    return "pending";
  };

  const io: BlockIO = {
    ...reader,
    now: host.now,
    runDir: host.runDir,
    stepDir: (child) => host.stepDir(childStep(scope, child), 1),
    workspace,
    turn,
    unit,
    advance: (child, r) =>
      gitOp(child, r.workspace, { kind: "advance", branch: r.branch, from: r.from, to: r.to }),
    mergeLocal: (child, r) =>
      gitOp(child, r.workspace, { kind: "mergeLocal", from: r.from, expectHead: r.expectHead }),
    namedWorkspace: host.namedWorkspace,
    remove: (ws) => {
      const key = `rm:${ws.name}`;
      if (!host.has(key)) host.record({ _tag: "RemoveWorkspace", key, name: ws.name });
    },
    interrupt: (child) => {
      const s = childStep(scope, child);
      const keys = childKeys(s);
      for (const key of [keys.turn, keys.nudge, keys.unit]) {
        const entry = state.intents.get(key);
        const target = entry === undefined ? null : liveTarget(entry, state);
        if (target === null || host.has(`interrupt:${key}`)) continue;
        host.record({ _tag: "Interrupt", key: `interrupt:${key}`, step: s, target });
      }
    },
    settleChild: (child, status, error) => {
      const s = childStep(scope, child);
      overridden.add(s);
      settle(
        s,
        status,
        host.latest(s)?.exited?.out ?? host.latest(s)?.settled?.output ?? null,
        error,
      );
    },
    event,
    ledger: ledgerOf,
    register,
    seeTree,
    resolveEntry: (ledgerId, entry) => {
      const resolved = ledgerOf(ledgerId).entries.get(entry.key)?.verdict ?? null;
      if (resolved !== null) return;
      host.emit(
        `resolved:${entry.key}`,
        { _tag: "EntryResolved", ...entry, at: isoOf(host.now) },
        ledgerStream(ledgerId),
      );
    },
    render: (template, roots = {}) => host.render(template, roots),
    evaluate: (expr, roots = {}) => host.evaluate(expr, roots),
    model: host.model,
    finish: (port, output, options) => {
      const exports = options?.exports;
      const value: { [key: string]: Json } = { ...output };
      if (exports !== undefined) {
        value.exports = Object.fromEntries(
          Object.entries(exports).map(([name, e]) => [
            name,
            {
              name: e.workspace.name,
              path: e.workspace.path,
              project: e.workspace.project,
              branch: e.workspace.branch,
              head: e.head,
            },
          ]),
        );
      }
      host.resolve(
        step,
        attempt,
        port === "fail" ? "failed" : "succeeded",
        port,
        value,
        options?.error ?? null,
      );
    },
  };

  decider.decide(node, decider.derive(node, io), io);
  for (const [s, settleDefault] of observed) if (!overridden.has(s)) settleDefault();
};
