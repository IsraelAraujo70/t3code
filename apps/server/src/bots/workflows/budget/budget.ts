/**
 * Budget arithmetic over a folded run (§9.1, §9.2): what a start reserves, what it is charged,
 * active time, the latest ceilings, fatigue and the host's workflow day. Pure; `decide` and the
 * views read the same numbers, so there is no second copy that could disagree.
 */
import { liveTarget } from "../fold.ts";
import { type Intent, type NewFact, runStream } from "../facts.ts";
import type { IntentEntry, RunState } from "../state.ts";

/** What the engine knows beyond the run: supplied through `DecideContext.budget`. */
export interface BudgetContext {
  /**
   * Reservation of a turn whose node gives no `tokenReservation`: the mean billable of that node
   * in earlier runs of the workflow, else `DEFAULT_TURN_RESERVATION`. Keyed by node id.
   */
  readonly estimate: (nodeId: string) => number;
  /** The token budget of the version a `call` node would start; absent when unknown. */
  readonly childTokens?: (workflowId: string) => number | undefined;
  /** The host's workflow day; null when the engine does not track it (tests, no cap). */
  readonly day: {
    /** Billable charged by every run in the current day, this one included. */
    readonly spent: number;
    readonly cap: number;
    /** Epoch ms at which the day turns. */
    readonly endsAt: number;
  } | null;
}

/** p95 billable of 4,207 completed real turns (statev2 copy, 2026-10-10..29): 262,763. */
export const DEFAULT_TURN_RESERVATION = 250_000;

export interface Ceilings {
  readonly steps: number;
  readonly wallMs: number;
  readonly tokens: number;
  readonly usd: number | null;
}

/** Tokens a start reserves: a turn's or a child run's `reservation`, a paid unit's, else 0. */
export const reservationOf = (intent: Intent): number => {
  return intent._tag === "StartTurn" ||
    intent._tag === "StartUnit" ||
    intent._tag === "StartChildRun"
    ? (intent.reservation ?? 0)
    : 0;
};

/**
 * Billable charged for one start: the settled turn's billable (plus its nudge), or a paid unit's
 * `out[tokensFrom]`. Usage that is partial, unavailable or unreadable is charged the reservation
 * when that is larger, never zero. null while the start has not settled.
 */
export const chargeOf = (state: RunState, entry: IntentEntry): number | null => {
  const intent = entry.intent;
  if (entry.result?._tag === "IntentFailed") return 0;
  if (intent._tag === "StartChildRun") {
    const ended =
      entry.result?._tag === "ChildRunStarted"
        ? state.children.get(entry.result.childRunId)
        : undefined;
    if (ended === undefined)
      return entry.result === null || entry.result._tag === "ChildRunStarted" ? null : 0;
    // A child skipped before it started (disabled, suspended, invalid) spent nothing.
    if (ended.status === "skipped") return 0;
    return ended.cost.usage === "complete"
      ? ended.cost.billable
      : Math.max(ended.cost.billable, reservationOf(intent));
  }
  if (intent._tag !== "StartTurn" && intent._tag !== "StartUnit") return 0;
  const attempt = state.attempts.get(intent.step)?.find((a) => a.attempt === intent.attempt);
  if (intent._tag === "StartTurn") {
    const observed = intent.key.startsWith("nudge:") ? attempt?.nudge : attempt?.settled;
    if (!observed) return null;
    return observed.cost.usage === "complete"
      ? observed.cost.billable
      : Math.max(observed.cost.billable, intent.reservation);
  }
  if (!attempt?.exited) return null;
  if (!intent.tokensFrom) return 0;
  let value: unknown = attempt.exited.out;
  for (const part of intent.tokensFrom.split(".")) {
    value =
      value !== null && typeof value === "object" && Object.hasOwn(value, part)
        ? Reflect.get(value, part)
        : undefined;
  }
  return !attempt.exited.lost && typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : reservationOf(intent);
};
/** Charged billable of settled starts whose step starts with `prefix` (all when absent). */
export const spentTokens = (state: RunState, prefix?: string): number => {
  return [...state.intents.values()].reduce(
    (sum, entry) =>
      sum +
      ("step" in entry.intent && (prefix === undefined || entry.intent.step.startsWith(prefix))
        ? (chargeOf(state, entry) ?? 0)
        : 0),
    0,
  );
};

/** Reservations of starts that are recorded and not settled, under `prefix` when given. */
export const reservedTokens = (state: RunState, prefix?: string): number => {
  return [...state.intents.values()].reduce(
    (sum, entry) =>
      sum +
      ("step" in entry.intent &&
      (prefix === undefined || entry.intent.step.startsWith(prefix)) &&
      chargeOf(state, entry) === null
        ? reservationOf(entry.intent)
        : 0),
    0,
  );
};

/** The run's ceilings after the latest `amendBudget` control (each field it gives replaces one). */
export const effectiveCeilings = (state: RunState): Ceilings => {
  let ceilings: Ceilings = state.started?.budget ?? { steps: 0, wallMs: 0, tokens: 0, usd: null };
  for (const { control } of state.controls)
    if (control.control === "amendBudget" && control.budget)
      ceilings = {
        steps: control.budget.steps ?? ceilings.steps,
        wallMs: control.budget.wallMs ?? ceilings.wallMs,
        tokens: control.budget.tokens ?? ceilings.tokens,
        usd: ceilings.usd,
      };
  return ceilings;
};

/**
 * Active milliseconds in [from, now]: wall time minus every pause and every span in which some
 * gate was open and undecided. `from` defaults to the run's start.
 */
export const activeMs = (state: RunState, now: number, from?: number): number => {
  const start = from ?? (state.started ? Date.parse(state.started.at) : now);
  const intervals = [
    ...state.pauses.map((p) => [Date.parse(p.at), p.resumedAt ? Date.parse(p.resumedAt) : now]),
    ...[...state.gates.values()]
      .filter((g) => g.openedAt !== null)
      .map((g) => [Date.parse(g.openedAt!), g.decision ? Date.parse(g.decision.at) : now]),
  ]
    .map(([a, b]) => [Math.max(start, a!), Math.min(now, b!)])
    .filter(([a, b]) => b! > a!)
    .sort((a, b) => a[0]! - b[0]!);
  let inactive = 0;
  let until = start;
  for (const [a, b] of intervals) {
    inactive += Math.max(0, b! - Math.max(a!, until));
    until = Math.max(until, b!);
  }
  return Math.max(0, now - start - inactive);
};

/** The epoch ms at which active time from `from` reaches `limitMs`; null while time is not counting. */
export const activeDeadline = (
  state: RunState,
  now: number,
  limitMs: number,
  from?: number,
): number | null => {
  if (
    state.pauses.some((p) => p.resumedAt === null && Date.parse(p.at) <= now) ||
    [...state.gates.values()].some(
      (g) => g.openedAt !== null && !g.decision && Date.parse(g.openedAt) <= now,
    )
  )
    return null;
  return now + Math.max(0, limitMs - activeMs(state, now, from));
};

/**
 * Failed, lost and timed_out resolutions in a row since the last succeeded resolution or the last
 * resume, in journal order. A rejected candidate whose measurement was valid resolved succeeded.
 */
export const fatigueStreak = (state: RunState): number => {
  const resumed = Math.max(
    -Infinity,
    ...state.pauses.map((p) => (p.resumedAt ? Date.parse(p.resumedAt) : -Infinity)),
  );
  let streak = 0;
  const attempts = [...state.attempts.values()]
    .flat()
    .filter((a) => a.resolved && Date.parse(a.resolved.at) > resumed)
    .sort(
      (a, b) => Date.parse(a.resolved!.at) - Date.parse(b.resolved!.at) || a.lastSeq - b.lastSeq,
    );
  for (const a of attempts) {
    const status = a.resolved!.status;
    if (status === "succeeded") streak = 0;
    else if (status === "failed" || status === "lost" || status === "timed_out") streak++;
  }
  return streak;
};

/** The live turns whose mid-turn usage reached twice their reservation: the watchdog interrupts them. */
export const overrunTurns = (state: RunState): ReadonlyArray<IntentEntry> => {
  return [...state.intents.values()].filter(
    (e) =>
      e.intent._tag === "StartTurn" &&
      e.intent.reservation > 0 &&
      liveTarget(e, state) !== null &&
      (state.usage.get(e.intent.key) ?? 0) >= 2 * e.intent.reservation,
  );
};

/**
 * The key a sensor stores a mid-turn usage report under: `usage:<intent key>:<n>`, n the number
 * of whole reservations reached (1, 2, …), so the journal keeps one report per step up; null below one.
 */
export const usageReportKey = (
  intentKey: string,
  billable: number,
  reservation: number,
): string | null => {
  const n = Math.floor(billable / reservation);
  return reservation <= 0 || n < 1 ? null : `usage:${intentKey}:${n}`;
};

/** The workflow day holding `now`: [start, end) in epoch ms, turning at `hour`:00 in `timeZone`. */
export const workflowDay = (
  now: number,
  timeZone: string,
  hour: number,
): { readonly start: number; readonly end: number } => {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const local = (t: number) => {
    const parts = formatter.formatToParts(t);
    const get = (name: string) => Number(parts.find((p) => p.type === name)!.value);
    return Date.UTC(
      get("year"),
      get("month") - 1,
      get("day"),
      get("hour"),
      get("minute"),
      get("second"),
    );
  };
  const midnight = Math.floor(local(now) / 86400000) * 86400000 + hour * 3600000;
  const boundary = (target: number) => {
    let t = target;
    for (let i = 0; i < 6; i++) t += target - local(t);
    return t;
  };
  const today = boundary(midnight);
  return today <= now
    ? { start: today, end: boundary(midnight + 86400000) }
    : { start: boundary(midnight - 86400000), end: today };
};

/** Billable this run charged in [start, end), each start by the time its charge settled. */
export const chargedBetween = (state: RunState, start: number, end: number): number => {
  return [...state.intents.values()].reduce((sum, entry) => {
    const intent = entry.intent;
    if (intent._tag !== "StartTurn" && intent._tag !== "StartUnit") return sum;
    const attempt = state.attempts.get(intent.step)?.find((a) => a.attempt === intent.attempt);
    const at = intent.key.startsWith("nudge:") ? attempt?.nudgeSettledAt : attempt?.settledAt;
    const time = at ? Date.parse(at) : NaN;
    return sum + (time >= start && time < end ? (chargeOf(state, entry) ?? 0) : 0);
  }, 0);
};

/**
 * The fact a turn observer appends when a live turn's provider reports usage: one per whole
 * reservation reached, so repeated reports of the same level are the same key. null below one.
 */
export const usageReport = (
  runId: string,
  intent: Extract<Intent, { readonly _tag: "StartTurn" }>,
  billable: number,
  at: string,
): NewFact | null => {
  const key = usageReportKey(intent.key, billable, intent.reservation);
  return key === null
    ? null
    : {
        stream: runStream(runId),
        key,
        fact: {
          _tag: "TurnUsageReported",
          step: intent.step,
          attempt: intent.attempt,
          billable,
          at,
        },
      };
};

/**
 * A turn's run followed by the restart continuations upstream started for it, in order: what a
 * live turn has spent so far is the usage of all of them.
 */
export const continuationChain = <
  Run extends { readonly id: string; readonly restartContinuationOfRunId?: string | undefined },
>(
  runs: ReadonlyArray<Run>,
  first: Run,
): ReadonlyArray<Run> => {
  const chain = [first];
  for (let last = first; ;) {
    const next = runs.find((run) => run.restartContinuationOfRunId === last.id);
    if (next === undefined || chain.includes(next)) return chain;
    chain.push(next);
    last = next;
  }
};
