/**
 * What a block reads about its children, from the folded run. The decider reads through the same
 * functions with this pass's records laid over the state, so a block sees what it just asked for.
 */
import { activeMs, spentTokens } from "../budget/budget.ts";
import type { BlockEventEntry, RunState, StepAttempt } from "../state.ts";
import type {
  BlockReader,
  GitObservation,
  TurnObservation,
  UnitObservation,
  WorkspaceObservation,
} from "./types.ts";

/** Children of attempt n > 1 live under `<step>/a<n>`, so a retried block starts fresh. */
export const blockScope = (step: string, attempt: number): string =>
  attempt === 1 ? step : `${step}/a${attempt}`;

const CHILD_ID = /^[a-z0-9_]+(\/[a-z0-9_]+)*$/;

/** The child's step key; a child id is lowercase segments, so it fits `WorkflowStepKey`. */
export const childStep = (scope: string, child: string): string => {
  if (!CHILD_ID.test(child)) throw new Error(`invalid block child id "${child}"`);
  return `${scope}/${child}`;
};

export const childKeys = (step: string) => ({
  turn: `turn:${step}@1`,
  nudge: `nudge:${step}@1`,
  unit: `unit:${step}@1`,
  workspace: `ws:${step}`,
  git: `git:${step}`,
});

/** This pass's view over the folded state; absent in views, where the state is all there is. */
export interface ReaderOverlay {
  /** True for a key recorded this pass or before. */
  readonly has: (key: string) => boolean;
  /** The latest attempt of a step, this pass's resolutions included. */
  readonly latest: (step: string) => StepAttempt | undefined;
  readonly events: ReadonlyArray<BlockEventEntry>;
}

export const blockReader = (
  state: RunState,
  step: string,
  attempt: number,
  now: number,
  overlay?: ReaderOverlay,
): BlockReader => {
  const scope = blockScope(step, attempt);
  const has = overlay?.has ?? ((key: string) => state.keys.has(key));
  const latest =
    overlay?.latest ?? ((s: string) => state.attempts.get(s)?.find((a) => a.attempt === 1));
  const resultOf = (key: string) => state.intents.get(key)?.result ?? null;
  const absentOrWaiting = (key: string) =>
    has(key) ? ({ _tag: "Waiting" } as const) : ({ _tag: "Absent" } as const);

  const turnOf = (child: string): TurnObservation => {
    const s = childStep(scope, child);
    const keys = childKeys(s);
    const result = resultOf(keys.turn);
    if (result === null) return absentOrWaiting(keys.turn);
    if (result._tag === "IntentFailed") return { _tag: "Failed", error: result.error };
    const a = latest(s);
    const settled = a?.settled ?? null;
    if (a === undefined || settled === null) return { _tag: "Waiting" };
    const observed = a.nudge ?? settled;
    return {
      _tag: "Settled",
      ok: observed.status === "completed",
      status: observed.status,
      text: observed.text,
      output: observed.output,
      error: observed.status === "completed" ? null : observed.text,
      threadId: a.threadId ?? "",
      headSha: observed.headSha ?? settled.headSha ?? null,
      treeHash: observed.treeHash ?? settled.treeHash ?? null,
    };
  };

  const unitOf = (child: string): UnitObservation => {
    const s = childStep(scope, child);
    const key = childKeys(s).unit;
    const result = resultOf(key);
    if (result === null) return absentOrWaiting(key);
    if (result._tag === "IntentFailed") return { _tag: "Failed", error: result.error };
    const exited = latest(s)?.exited ?? null;
    if (exited === null) return { _tag: "Waiting" };
    const intent = state.intents.get(key)?.intent;
    const parsed =
      intent?._tag !== "StartUnit" ||
      (intent.parse ?? "none") === "none" ||
      (exited.parseError ?? null) === null;
    return {
      _tag: "Exited",
      ok: !exited.lost && exited.signal !== "TIMEOUT" && exited.exit === 0 && parsed,
      exit: exited.exit,
      signal: exited.signal,
      out: exited.out,
      tail: exited.tail,
      lost: exited.lost,
      parseError: exited.parseError ?? null,
    };
  };

  const workspaceOf = (child: string): WorkspaceObservation => {
    const s = childStep(scope, child);
    const key = childKeys(s).workspace;
    const result = resultOf(key);
    if (result === null) return absentOrWaiting(key);
    if (result._tag === "IntentFailed") return { _tag: "Failed", error: result.error };
    const intent = state.intents.get(key)?.intent;
    if (result._tag !== "WorkspaceReady" || intent?._tag !== "PrepareWorkspace")
      return { _tag: "Waiting" };
    return {
      _tag: "Ready",
      workspace: {
        name: result.name,
        path: result.path,
        project: intent.projectRef,
        branch: result.branch,
        headSha: result.headSha,
      },
    };
  };

  const gitOf = (child: string): GitObservation => {
    const key = childKeys(childStep(scope, child)).git;
    const result = resultOf(key);
    if (result === null) return absentOrWaiting(key);
    if (result._tag === "IntentFailed") return { _tag: "Failed", error: result.error };
    return result._tag === "GitOpDone" ? { _tag: "Done", sha: result.sha } : { _tag: "Waiting" };
  };

  const childStatus: BlockReader["childStatus"] = (child) => {
    const s = childStep(scope, child);
    if (state.skipped.has(s)) return "skipped";
    const a = latest(s);
    if (a?.resolved) return a.resolved.status;
    for (const gate of state.gates.values())
      if (gate.intent.step === s && gate.decision === null) return "waiting_gate";
    if (a === undefined) return "pending";
    return a.threadId !== null || a.unit !== null ? "running" : "dispatched";
  };

  const firstStart = (): number | null => {
    let first: number | null = null;
    for (const [s, attempts] of state.attempts) {
      if (!s.startsWith(`${scope}/`)) continue;
      for (const a of attempts) {
        if (a.startedAt === null) continue;
        const at = Date.parse(a.startedAt);
        if (first === null || at < first) first = at;
      }
    }
    return first;
  };

  return {
    runId: state.runId,
    step,
    attempt,
    turnOf,
    unitOf,
    workspaceOf,
    gitOf,
    childStatus,
    events: overlay?.events ?? state.blocks.get(scope) ?? [],
    spent: () => spentTokens(state, `${scope}/`),
    activeMs: () => {
      const from = firstStart();
      return from === null ? 0 : activeMs(state, now, from);
    },
  };
};
