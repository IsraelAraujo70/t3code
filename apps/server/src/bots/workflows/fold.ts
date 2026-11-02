/** Folds a run's facts into the state `decide` reads. Pure; the journal is the only truth. */
import type { StoredFact } from "./facts.ts";
import type { IntentEntry, RunState, StepAttempt } from "./state.ts";

export const emptyRunState = (runId: string): RunState => ({
  runId,
  lastSeq: 0,
  started: null,
  ended: null,
  endedSeq: 0,
  reopenedSeq: 0,
  generation: 0,
  output: null,
  paused: null,
  pauseCount: 0,
  resumeCount: 0,
  intents: new Map(),
  attempts: new Map(),
  skipped: new Map(),
  skippedSeq: new Map(),
  keys: new Set(),
  children: new Map(),
  expansions: new Map(),
  iterations: new Map(),
  gates: new Map(),
  requests: new Map(),
  controls: [],
  workspaces: new Map(),
  releasedBranches: new Set(),
});

/**
 * The workspaces after a turn or command reported the head it left: facts fold in journal order,
 * so the last observation wins even when parallel steps settle out of order.
 */
const advanceHead = (
  state: Pick<RunState, "workspaces" | "intents">,
  fact: {
    readonly step: string;
    readonly attempt: number;
    readonly headSha?: string | null | undefined;
  },
): RunState["workspaces"] => {
  if (fact.headSha == null) return state.workspaces;
  for (const { intent } of state.intents.values()) {
    if (intent._tag !== "StartTurn" && intent._tag !== "StartUnit") continue;
    if (intent.step !== fact.step || intent.attempt !== fact.attempt) continue;
    const name = intent._tag === "StartTurn" ? intent.workspace.name : intent.cwd.name;
    const ready = state.workspaces.get(name);
    return ready === undefined
      ? state.workspaces
      : new Map(state.workspaces).set(name, { ...ready, headSha: fact.headSha });
  }
  return state.workspaces;
};

/** Applies one fact of the run's stream; facts arrive in seq order. */
export const applyRunFact = (state: RunState, stored: StoredFact): RunState => {
  let next = { ...state, lastSeq: stored.seq, keys: new Set(state.keys).add(stored.key) };
  const fact = stored.fact;
  const updateAttempt = (step: string, attempt: number, patch: Partial<StepAttempt>) => {
    const attempts = new Map(next.attempts);
    const entries = [...(attempts.get(step) ?? [])];
    const index = entries.findIndex((entry) => entry.attempt === attempt);
    const previous = entries[index] ?? {
      step,
      attempt,
      firstSeq: stored.seq,
      lastSeq: stored.seq,
      startedAt: null,
      threadId: null,
      unit: null,
      settled: null,
      nudge: null,
      exited: null,
      child: null,
      resolved: null,
      stoppedByEnd: false,
    };
    const entry = { ...previous, ...patch, lastSeq: stored.seq };
    if (index < 0) entries.push(entry);
    else entries[index] = entry;
    attempts.set(
      step,
      entries.sort((a, b) => a.attempt - b.attempt),
    );
    next = { ...next, attempts };
  };
  switch (fact._tag) {
    case "TriggerFired":
    case "RunCreated":
    case "TriggerSkipped":
    case "RunOutcome":
    case "Toggled":
    case "Suspended":
    case "Unsuspended":
      break;
    case "RunStarted":
      next.started = fact;
      break;
    case "RunEnded":
      next.ended = fact;
      next.endedSeq = stored.seq;
      break;
    case "BranchReleased":
      next.releasedBranches = new Set(next.releasedBranches).add(fact.branch);
      break;
    case "RunReopened": {
      next.ended = null;
      next.output = null;
      next.paused = null;
      next.reopenedSeq = stored.seq;
      next.generation++;
      // Dead paths are derived again every pass; the failure that cut them may now be retried.
      const live = [...next.skipped].filter(([, reason]) => reason !== "dead-path");
      next.skipped = new Map(live);
      next.skippedSeq = new Map([...next.skippedSeq].filter(([step]) => next.skipped.has(step)));
      break;
    }
    case "OutputSet":
      next.output = fact;
      break;
    case "RunPaused":
      next.paused = fact;
      next.pauseCount++;
      break;
    case "RunResumed":
      next.paused = null;
      next.resumeCount++;
      break;
    case "IntentRecorded": {
      const intent = fact.intent;
      next.intents = new Map(next.intents).set(stored.key, {
        intent,
        seq: stored.seq,
        result: null,
      });
      if ("attempt" in intent) {
        const existing = next.attempts
          .get(intent.step)
          ?.find((entry) => entry.attempt === intent.attempt);
        updateAttempt(
          intent.step,
          intent.attempt,
          intent._tag === "StartTurn" && intent.mode === "new" && !existing?.threadId
            ? { threadId: intent.threadId }
            : {},
        );
      }
      if (intent._tag === "OpenGate")
        next.gates = new Map(next.gates).set(intent.gateKey, {
          intent,
          openedAt: null,
          decision: null,
          lastSeq: stored.seq,
        });
      break;
    }
    case "TurnSettled":
      updateAttempt(
        fact.step,
        fact.attempt,
        stored.key.endsWith(":nudge") ? { nudge: fact } : { settled: fact },
      );
      next.workspaces = advanceHead(next, fact);
      break;
    case "UnitExited":
      updateAttempt(fact.step, fact.attempt, { exited: fact });
      next.workspaces = advanceHead(next, fact);
      break;
    case "StepResolved":
      // The end batch resolves what it stopped right after its RunEnded.
      updateAttempt(fact.step, fact.attempt, { resolved: fact, stoppedByEnd: next.ended !== null });
      break;
    case "ChildRunEnded":
      next.children = new Map(next.children).set(fact.childRunId, fact);
      for (const { intent, result } of next.intents.values()) {
        if (
          intent._tag === "StartChildRun" &&
          result?._tag === "ChildRunStarted" &&
          result.childRunId === fact.childRunId
        )
          updateAttempt(intent.step, intent.attempt, { child: fact });
      }
      break;
    case "StepSkipped":
      next.skipped = new Map(next.skipped).set(fact.step, fact.reason);
      next.skippedSeq = new Map(next.skippedSeq).set(fact.step, stored.seq);
      break;
    case "MapExpanded":
      next.expansions = new Map(next.expansions).set(fact.step, fact.items);
      break;
    case "IterationStarted":
      next.iterations = new Map(next.iterations).set(
        fact.step,
        Math.max(next.iterations.get(fact.step) ?? fact.index, fact.index),
      );
      break;
    case "RuntimeRequest":
      next.requests = new Map(next.requests).set(fact.requestId, fact);
      break;
    case "GateDecided": {
      const gate = next.gates.get(fact.gateKey);
      if (gate && !gate.decision)
        next.gates = new Map(next.gates).set(fact.gateKey, {
          ...gate,
          decision: fact,
          lastSeq: stored.seq,
        });
      break;
    }
    case "ControlRequested":
      next.controls = [...next.controls, { key: stored.key, seq: stored.seq, control: fact }];
      break;
    default: {
      const key = stored.key.slice("result:".length);
      const entry = stored.key.startsWith("result:") ? next.intents.get(key) : undefined;
      if (!entry) break;
      next.intents = new Map(next.intents).set(key, { ...entry, result: fact });
      if (fact._tag === "TurnStarted" && "attempt" in entry.intent)
        updateAttempt(entry.intent.step, entry.intent.attempt, {
          threadId: fact.threadId,
          startedAt: stored.at,
        });
      if (fact._tag === "UnitSpawned" && "attempt" in entry.intent)
        updateAttempt(entry.intent.step, entry.intent.attempt, {
          unit: fact.unit,
          startedAt: stored.at,
        });
      if (fact._tag === "ChildRunStarted" && "attempt" in entry.intent) {
        const ended = next.children.get(fact.childRunId);
        if (ended !== undefined)
          updateAttempt(entry.intent.step, entry.intent.attempt, { child: ended });
      }
      if (fact._tag === "ChildRunStarted" && "attempt" in entry.intent)
        updateAttempt(entry.intent.step, entry.intent.attempt, { startedAt: stored.at });
      if (fact._tag === "WorkspaceReady")
        next.workspaces = new Map(next.workspaces).set(fact.name, fact);
      if (fact._tag === "GateOpened") {
        const gate = next.gates.get(fact.gateKey);
        if (gate)
          next.gates = new Map(next.gates).set(fact.gateKey, {
            ...gate,
            openedAt: fact.at,
            lastSeq: stored.seq,
          });
      }
    }
  }
  return next;
};

export const foldRun = (runId: string, facts: ReadonlyArray<StoredFact>): RunState =>
  facts.reduce(applyRunFact, emptyRunState(runId));

/** What a running start can be stopped through. */
export type LiveTarget =
  | { readonly threadId: string }
  | { readonly unit: string }
  | { readonly childRunId: string };

/**
 * A start intent whose turn, unit or child run is running: it has its start receipt and no
 * outcome yet. Each such intent is live work; an interrupt targets it by its own key.
 */
export const liveTarget = (entry: IntentEntry, state: RunState): LiveTarget | null => {
  const intent = entry.intent;
  const result = entry.result;
  if (intent._tag === "StartChildRun") {
    if (result?._tag !== "ChildRunStarted" || state.children.has(result.childRunId)) return null;
    return { childRunId: result.childRunId };
  }
  if (intent._tag !== "StartTurn" && intent._tag !== "StartUnit") return null;
  const attempt = state.attempts.get(intent.step)?.find((a) => a.attempt === intent.attempt);
  if (intent._tag === "StartUnit") {
    return result?._tag === "UnitSpawned" && attempt?.exited == null ? { unit: result.unit } : null;
  }
  if (result?._tag !== "TurnStarted") return null;
  const observed = intent.key.startsWith("nudge:") ? attempt?.nudge : attempt?.settled;
  return observed == null ? { threadId: result.threadId } : null;
};
