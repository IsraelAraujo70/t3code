/**
 * The engine (§3.1-§3.2): triggers become TriggerFired facts, the workflow decider turns them into
 * runs, and one actor per live run loops fold → execute pending intents → observe → decide →
 * append until the run ends and nothing it recorded waits for a result. The journal is the only
 * inbox: an actor subscribes before it reads, so no fact lands between the read and the wait.
 */
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Data from "effect/Data";
import * as DateTime from "effect/DateTime";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type { Json } from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  WorkflowsError,
  type WorkflowRunTriggerInput,
  type WorkflowRunTriggerPayload,
  type WorkflowGateDecideInput,
  type WorkflowGateView,
  type WorkflowLedgerInput,
  type WorkflowLedgerPage,
  type WorkflowMetrics,
  type WorkflowMetricsInput,
  type WorkflowRunControlInput,
  type WorkflowRunDelta,
  type WorkflowRunGetInput,
  WorkflowRunId,
  type WorkflowRunsListInput,
  type WorkflowRunsPage,
  type WorkflowRunStartInput,
  type WorkflowRunStatus,
  type WorkflowRunSubscribeInput,
  type WorkflowRunSummary,
  type WorkflowRunView,
  type WorkflowStepDetail,
  type WorkflowRunStepInput,
  WorkflowLedgerEntry,
  WorkflowMetricReading,
} from "@t3tools/contracts";
import {
  type CompiledWorkflow,
  decodeRunParams,
  triggerParams,
  DEFAULT_HOST_LIMITS,
} from "@t3tools/shared/workflows";

import { forkParked } from "../../serverActivation.ts";
// wf-engine slices 7-8: ledgers, budget context and block views.
import { foldLedger, ledgerIdsOf } from "./blocks/ledger.ts";
import { blockViews } from "./blocks/registry.ts";
import { chargeOf, workflowDay } from "./budget/budget.ts";
import { budgetContext, calledWorkflowsOf } from "./budget/context.ts";
import { WorkflowCatalog } from "./Catalog.ts";
import { decide, nextDeadline, retryRefusal } from "./decide.ts";
import { decideWorkflow } from "./decideWorkflow.ts";
import {
  type StoredFact,
  type Intent,
  ledgerStream,
  type NewFact,
  runStream,
  workflowStream,
} from "./facts.ts";
import { occurrenceKey } from "./triggers/occurrence.ts";
import { canonicalParams } from "./params.ts";
import { applyRunFact, emptyRunState, foldRun, liveTarget } from "./fold.ts";
import { runIdFor } from "./ids.ts";
import { isSubStep } from "./steps.ts";
import { WorkflowInterpreter } from "./Interpreter.ts";
import { Journal, WorkflowJournalError } from "./Journal.ts";
import type { GateDecided, IntentEntry, RunState } from "./state.ts";
import {
  gateViews,
  pendingSummary,
  runDelta,
  runSummary,
  runTriggerView,
  runWarnings,
  stepDetail,
  stepViews,
} from "./view.ts";

const encodeTriggerPayload = Schema.encodeEffect(Schema.fromJsonString(Schema.Json));

/** A request to run a workflow once; `occurrence` names it, so asking twice is one run. */
export interface TriggerRequest {
  readonly workflowId: string;
  readonly triggerId: string;
  readonly kind: string;
  readonly occurrence: string;
  readonly label: string;
  readonly params: { readonly [name: string]: Json };
  readonly payload: Json;
  readonly causalDepth: number;
  readonly parent: { readonly runId: string; readonly step: string } | null;
}

interface ControlInput {
  readonly runId: string;
  readonly control: "cancel" | "pause" | "resume" | "retry";
  readonly step: string | null;
  readonly clientRequestId: string;
  readonly by: string;
}

interface GateDecisionInput {
  readonly runId: string;
  readonly gateKey: string;
  readonly option: string;
  readonly note: string | null;
}

export interface WorkflowEngineOptions {
  /** `~/.t3/workflows/runs` on the bots host. */
  readonly runsDir: string;
  /** How often the tick promotes triggers and revives actors (default 5 s). */
  readonly tickEvery?: Duration.Input;
  /** Wait before executing an intent again after a retryable failure (default 30 s). */
  readonly retryEvery?: Duration.Input;
}

const decodeLedgerEntry = Schema.decodeEffect(WorkflowLedgerEntry);
const decodeMetricReading = Schema.decodeUnknownOption(WorkflowMetricReading);

export class WorkflowEngine extends Context.Service<
  WorkflowEngine,
  {
    /** Records the TriggerFired and answers at once; the run starts when the decider promotes it. */
    readonly start: (
      request: TriggerRequest,
    ) => Effect.Effect<{ readonly runId: WorkflowRunId }, WorkflowJournalError>;
    readonly control: (input: ControlInput) => Effect.Effect<void, WorkflowJournalError>;
    /** The first decision of a gate wins; a later one gets the stored decision back. */
    readonly decideGate: (
      input: GateDecisionInput,
    ) => Effect.Effect<GateDecided, WorkflowJournalError>;
    readonly runState: (runId: string) => Effect.Effect<RunState, WorkflowJournalError>;
    /** Promotes pending triggers and starts an actor for every live run without one. */
    readonly tick: Effect.Effect<void, WorkflowJournalError>;
    /** Folds again every run whose projection row is missing or behind its stream. */
    readonly rebuildProjection: Effect.Effect<void, WorkflowJournalError>;

    // The RPC surface (packages/contracts/src/workflowsRpc.ts); `by` names who asked.
    readonly startRun: (
      input: WorkflowRunStartInput,
      by: string,
    ) => Effect.Effect<WorkflowRunSummary, WorkflowJournalError | WorkflowsError>;
    /** Reads the starting trigger payload on demand. */
    readonly runTrigger: (
      input: WorkflowRunTriggerInput,
    ) => Effect.Effect<WorkflowRunTriggerPayload, WorkflowJournalError>;
    readonly runView: (
      input: WorkflowRunGetInput,
    ) => Effect.Effect<WorkflowRunView, WorkflowJournalError>;
    /** Deltas after `afterSeq`, then one per change, until the subscriber leaves. */
    readonly subscribeRun: (
      input: WorkflowRunSubscribeInput,
    ) => Stream.Stream<WorkflowRunDelta, WorkflowJournalError>;
    readonly stepDetail: (
      input: WorkflowRunStepInput,
    ) => Effect.Effect<WorkflowStepDetail, WorkflowJournalError>;
    readonly controlRun: (
      input: WorkflowRunControlInput,
      by: string,
    ) => Effect.Effect<WorkflowRunSummary, WorkflowJournalError>;
    /** Only a user session reaches this (the RPC's scope); no MCP tool decides a gate. */
    readonly gateDecide: (
      input: WorkflowGateDecideInput,
    ) => Effect.Effect<WorkflowGateView, WorkflowJournalError>;
    readonly listRuns: (
      input: WorkflowRunsListInput,
    ) => Effect.Effect<WorkflowRunsPage, WorkflowJournalError>;
    readonly metrics: (
      input: WorkflowMetricsInput,
    ) => Effect.Effect<WorkflowMetrics, WorkflowJournalError>;
    /** Empty until the ledgers arrive with the blocks (slice 7). */
    readonly ledger: (
      input: WorkflowLedgerInput,
    ) => Effect.Effect<WorkflowLedgerPage, WorkflowJournalError>;
  }
>()("t3/bots/workflows/WorkflowEngine") {}

/** A retryable IntentFailed: the actor runs the same intent again, its key still free. */
class RetryLater extends Data.TaggedError("RetryLater")<{
  readonly facts: ReadonlyArray<NewFact>;
}> {}

/** How often a retryable failure is tried before its error is stored as final. */
const MAX_INTENT_TRIES = 10;

const DEFAULT_TICK = Duration.seconds(5);
const DURATION_UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000 } as const;
const durationMs = (text: string): number =>
  Number(text.slice(0, -1)) * DURATION_UNIT_MS[text.slice(-1) as keyof typeof DURATION_UNIT_MS];
const DEFAULT_RETRY = Duration.seconds(30);
const nowIso = Clock.currentTimeMillis.pipe(
  Effect.map((millis) => DateTime.formatIso(DateTime.makeUnsafe(millis))),
);

/** Earlier runs of a workflow that teach its nodes' reservations. */
const HISTORY_RUNS = 10;
const CONTEXT_TTL_MS = 5_000;
/** Longer than any workflow day, so a run that settled a charge today stored a fact inside it. */
const DAY_WINDOW_MS = 48 * 3_600_000;

const isStart = (intent: Intent) =>
  intent._tag === "StartTurn" || intent._tag === "StartUnit" || intent._tag === "StartChildRun";

export const make = Effect.fn("WorkflowEngine.make")(function* (options: WorkflowEngineOptions) {
  const journal = yield* Journal;
  const interpreter = yield* WorkflowInterpreter;
  const catalog = yield* WorkflowCatalog;
  const actors = yield* FiberMap.make<string, void, WorkflowJournalError>();
  const promoting = yield* Semaphore.make(1);
  /** Actors start and stop under this gate; `running` holds every run with a live actor. */
  const actorGate = yield* Semaphore.make(1);
  const running = new Set<string>();
  // wf-engine slice 8: the workflow day's spend, shared by every actor. The runs that may still
  // charge are kept folded; a fact appended to a run stream marks that run to advance (a dropped
  // run that reopens is folded again from its start), so no refresh rescans every run.
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const dayRuns = new Map<string, RunState>();
  const dirtyRuns = new Set<string>();
  let dayLoaded = false;
  let daySnapshot: { readonly at: number; readonly runs: ReadonlyArray<RunState> } | null = null;
  const dayGate = yield* Semaphore.make(1);
  const runFacts = yield* journal.subscribe;
  yield* Effect.forkScoped(
    Effect.forever(
      PubSub.take(runFacts).pipe(
        Effect.map((fact) => {
          if (fact.stream.startsWith("run:")) dirtyRuns.add(fact.stream.slice("run:".length));
        }),
      ),
    ),
  );
  /** Runs that may have charged in the current workflow day, refreshed at most every CONTEXT_TTL_MS. */
  const dayRunsAt = (now: number) =>
    dayGate.withPermits(1)(
      Effect.gen(function* () {
        if (daySnapshot !== null && now - daySnapshot.at < CONTEXT_TTL_MS) return daySnapshot.runs;
        // The first load reads only runs that are live or stored a fact inside DAY_WINDOW_MS.
        const ids = dayLoaded
          ? [...dirtyRuns]
          : new Set([
              ...(yield* journal.runsTouchedSince(
                DateTime.formatIso(DateTime.makeUnsafe(now - DAY_WINDOW_MS)),
              )),
              ...(yield* journal.liveRuns),
            ]);
        dayLoaded = true;
        dirtyRuns.clear();
        for (const id of ids) {
          const known = dayRuns.get(id) ?? emptyRunState(id);
          const facts = yield* journal.read(runStream(id), known.lastSeq);
          dayRuns.set(id, facts.reduce(applyRunFact, known));
        }
        const day = workflowDay(now, timeZone, DEFAULT_HOST_LIMITS.dayStartsAtHour);
        for (const [id, state] of dayRuns) {
          // An ended run whose charges all settled before today cannot charge today.
          const settled = [...state.intents.values()].every((e) => chargeOf(state, e) !== null);
          const latest = Math.max(
            -Infinity,
            ...[...state.attempts.values()]
              .flat()
              .flatMap((a) => [a.settledAt, a.nudgeSettledAt])
              .flatMap((at) => (at == null ? [] : [Date.parse(at)])),
          );
          if (state.ended !== null && settled && latest < day.start) dayRuns.delete(id);
        }
        daySnapshot = { at: now, runs: [...dayRuns.values()] };
        return daySnapshot.runs;
      }),
    );
  /**
   * Under the gate, an actor with nothing left re-reads its stream and exits only if nothing new
   * arrived; `ensureActor` starts one unless one runs. A fact written before `ensureActor` (a
   * retry on an ended run) is therefore always seen by some actor.
   */
  const tryExit = (runId: string, afterSeq: number) =>
    actorGate.withPermits(1)(
      Effect.gen(function* () {
        if ((yield* journal.read(runStream(runId), afterSeq)).length > 0) return false;
        running.delete(runId);
        return true;
      }),
    );
  const retryEvery = options.retryEvery ?? DEFAULT_RETRY;

  /**
   * Executes one intent until it has a result. A retryable failure is tried again every
   * `retryEvery`, MAX_INTENT_TRIES times in all; then its error is stored as final, so the step
   * fails with the reason instead of waiting out the wall budget.
   */
  const execute = (runId: string, intent: Intent): Effect.Effect<void, WorkflowJournalError> =>
    interpreter.execute(runId, intent).pipe(
      Effect.flatMap((facts): Effect.Effect<void, RetryLater | WorkflowJournalError> => {
        const failed = facts.find((f) => f.fact._tag === "IntentFailed");
        return failed?.fact._tag === "IntentFailed" && failed.fact.retryable
          ? Effect.fail(new RetryLater({ facts }))
          : Effect.asVoid(journal.append(facts));
      }),
      Effect.retry({
        while: (error) => error._tag === "RetryLater",
        schedule: Schedule.spaced(retryEvery),
        times: MAX_INTENT_TRIES - 1,
      }),
      Effect.catchTags({
        RetryLater: ({ facts }) =>
          Effect.asVoid(
            journal.append(
              facts.map((f) =>
                f.fact._tag === "IntentFailed"
                  ? { ...f, fact: { ...f.fact, retryable: false } }
                  : f,
              ),
            ),
          ),
      }),
    );

  const observe = (runId: string, entry: IntentEntry) =>
    entry.result === null
      ? Effect.void
      : interpreter
          .observe(runId, entry.intent, entry.result)
          .pipe(Stream.runForEach((fact) => journal.append([fact])));

  const runActor = Effect.fn("WorkflowEngine.runActor")(function* (runId: string) {
    const stream = runStream(runId);
    const subscription = yield* journal.subscribe;
    const work = yield* FiberMap.make<string, void, WorkflowJournalError>();
    const wake = yield* Queue.unbounded<void>();
    let state = foldRun(runId, yield* journal.read(stream));
    const started = state.started;
    if (started === null) {
      yield* tryExit(runId, state.lastSeq);
      return;
    }
    const version = yield* catalog.pinned(started.workflowId, started.commit);
    const failureSubscribers = yield* catalog.failureSubscribers(started.workflowId);
    const runDir = `${options.runsDir}/${runId}`;
    // wf-engine slices 7-8: the ledgers the definition reads, earlier runs for reservations, the host's day.
    const ledgerIds = ledgerIdsOf(version.compiled);
    const history = yield* Effect.forEach(
      (yield* journal.createdRuns(started.workflowId))
        .filter((run) => run.runId !== runId)
        .slice(0, HISTORY_RUNS),
      (run) => journal.read(runStream(run.runId)).pipe(Effect.map((f) => foldRun(run.runId, f))),
    );
    const calledWorkflows = calledWorkflowsOf(version.compiled);
    const contextAt = Effect.fn("WorkflowEngine.contextAt")(function* (now: number) {
      const ledgers = new Map(
        yield* Effect.forEach(ledgerIds, (id) =>
          journal.read(ledgerStream(id)).pipe(Effect.map((f) => [id, foldLedger(id, f)] as const)),
        ),
      );
      const runs = yield* dayRunsAt(now);
      // Re-read with the context, so a child whose budget changed is reserved at its new budget.
      const childTokens = new Map<string, number>();
      for (const id of calledWorkflows) {
        const current = yield* catalog.current(id);
        if (current._tag === "Ready")
          childTokens.set(id, current.version.compiled.definition.budget.tokens);
      }
      const budget = {
        ...budgetContext({
          now,
          timeZone,
          dayStartsAtHour: DEFAULT_HOST_LIMITS.dayStartsAtHour,
          cap: DEFAULT_HOST_LIMITS.workflowTokensPerDay,
          runs,
          history,
        }),
        childTokens: (workflowId: string) => childTokens.get(workflowId),
      };
      return { ledgers, budget };
    });
    // Reread at most every CONTEXT_TTL_MS, at once after a pass wrote to a ledger, and when the day turned.
    let context: {
      readonly at: number;
      readonly value: Effect.Success<ReturnType<typeof contextAt>>;
    } | null = null;

    // Work that fails is logged and relaunched by the next pass only after `retryEvery`, so a
    // failure that repeats (an append that cannot succeed) never spins.
    const launch = (key: string, effect: Effect.Effect<void, WorkflowJournalError>) =>
      FiberMap.run(
        work,
        key,
        effect.pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) =>
              Effect.logError("workflow work failed", { runId, key, cause }).pipe(
                Effect.andThen(Effect.sleep(retryEvery)),
              ),
          ),
          Effect.ensuring(Queue.offer(wake, undefined)),
        ),
        { onlyIfMissing: true },
      );

    let projected = -1;
    while (true) {
      for (const fact of yield* journal.read(stream, state.lastSeq))
        state = applyRunFact(state, fact);
      if (state.lastSeq > projected) {
        yield* project(state);
        projected = state.lastSeq;
      }
      // Decide until quiet before executing anything: a cancel that arrived while the server was
      // down ends the run first, so a stale start is abandoned instead of executed.
      // One instant for the decision and the next deadline, so none falls between two reads.
      const now = yield* Clock.currentTimeMillis;
      if (
        context === null ||
        now - context.at >= CONTEXT_TTL_MS ||
        now >= (context.value.budget.day?.endsAt ?? Infinity)
      )
        context = { at: now, value: yield* contextAt(now) };
      const decided = decide(version.compiled, state, {
        now,
        runDir,
        failureSubscribers,
        ...context.value,
      });
      const wroteLedger = decided.some((f) => f.stream.startsWith("ledger:"));
      if (wroteLedger) context = null;
      // Only a pass that stored something moves the run; a pass of duplicates must not spin.
      // A ledger key another run won is a change too: decide again against the winner.
      const appended = decided.length > 0 ? yield* journal.append(decided) : [];
      if (appended.some((r) => r.inserted || (wroteLedger && r.fact.stream.startsWith("ledger:"))))
        continue;
      for (const [key, entry] of state.intents) {
        if (entry.result === null && state.ended !== null && isStart(entry.intent)) {
          // A start still executing (or retrying) when the run ended is stopped; abandon settles it.
          yield* FiberMap.remove(work, `execute:${key}`);
          yield* launch(
            `abandon:${key}`,
            interpreter
              .abandon(runId, entry.intent)
              .pipe(Effect.flatMap(journal.append), Effect.asVoid),
          );
        } else if (entry.result === null) {
          yield* launch(`execute:${key}`, execute(runId, entry.intent));
        } else if (
          (entry.intent._tag === "StartTurn" || entry.intent._tag === "StartUnit") &&
          liveTarget(entry, state) !== null
        ) {
          yield* launch(`observe:${key}`, observe(runId, entry));
        }
      }
      if (
        state.ended !== null &&
        [...state.intents.values()].every((e) => e.result !== null) &&
        (yield* FiberMap.size(work)) === 0
      ) {
        if (yield* tryExit(runId, state.lastSeq)) return;
        continue;
      }
      const deadline = nextDeadline(version.compiled, state, now, context?.value.budget);
      const waitFrom = yield* Clock.currentTimeMillis;
      const mine = PubSub.take(subscription).pipe(
        Effect.repeat({ until: (fact) => fact.stream === stream }),
        Effect.asVoid,
      );
      yield* Effect.raceAll([
        mine,
        Queue.take(wake),
        deadline === null
          ? Effect.never
          : Effect.sleep(Duration.millis(Math.max(0, deadline - waitFrom))),
      ]);
    }
  });

  const ensureActor = (runId: string) =>
    actorGate.withPermits(1)(
      Effect.suspend(() => {
        if (running.has(runId)) return Effect.void;
        running.add(runId);
        // Replaces an actor that already decided to exit but has not left the map yet.
        return FiberMap.run(
          actors,
          runId,
          Effect.scoped(runActor(runId)).pipe(
            Effect.tapCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.void
                : Effect.logError("workflow run actor failed; the tick revives it", {
                    runId,
                    cause,
                  }),
            ),
            Effect.onError(() =>
              actorGate.withPermits(1)(Effect.sync(() => running.delete(runId))),
            ),
          ),
        ).pipe(Effect.asVoid);
      }),
    );

  /** The run's row in the projection lists read; a failure to write it never stops the run. */
  const project = (state: RunState) =>
    state.started === null
      ? Effect.void
      : Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) =>
            journal.putRun({
              summary: runSummary(state, now),
              lastSeq: state.lastSeq,
              pendingIntents: [...state.intents.values()].filter((e) => e.result === null).length,
              parentRunId: state.started!.parent?.runId ?? null,
            }),
          ),
          Effect.catch((error) =>
            Effect.logWarning("workflow run projection failed", { runId: state.runId, error }),
          ),
        );

  /** At boot: rows missing or behind their stream are folded again (a crash between append and row). */
  const rebuildProjection = Effect.gen(function* () {
    for (const { runId, projected, stream } of yield* journal.projectionLag) {
      if (projected !== null && projected >= stream) continue;
      yield* project(foldRun(runId, yield* journal.read(runStream(runId))));
    }
  }).pipe(Effect.withSpan("WorkflowEngine.rebuildProjection"));

  /** Turns the workflow's pending TriggerFired facts into runs, skips or waits; one at a time. */
  const promote = Effect.fn("WorkflowEngine.promote")(function* (workflowId: string) {
    const results = yield* promoting.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* catalog.current(workflowId);
        const facts = yield* journal.workflowBacklog(
          workflowId,
          current._tag === "Ready"
            ? current.version.compiled.definition.fatigue.consecutiveFailures
            : 0,
        );
        // The journal's live runs count a reopened run, which already has an outcome.
        // wf-engine slice 8: an ended run still delivering its end notice or card is not busy.
        const running = yield* Effect.filter(yield* journal.liveRunsOf(workflowId), (id) =>
          journal.read(runStream(id)).pipe(Effect.map((f) => foldRun(id, f).ended === null)),
        );
        const decided = decideWorkflow({
          workflowId,
          facts,
          current,
          liveRuns: running.length,
          now: yield* Clock.currentTimeMillis,
        });
        return yield* journal.append(decided);
      }),
    );
    for (const { fact } of results) {
      if (fact.fact._tag !== "RunCreated") continue;
      // Listed at once, before its actor's first pass.
      yield* project(foldRun(fact.fact.runId, yield* journal.read(runStream(fact.fact.runId))));
      yield* ensureActor(fact.fact.runId);
    }
  });

  const tick = Effect.gen(function* () {
    for (const workflowId of yield* journal.pendingTriggers) yield* promote(workflowId);
    for (const runId of yield* journal.liveRuns) yield* ensureActor(runId);
  }).pipe(Effect.withSpan("WorkflowEngine.tick"));

  const unknownRun = (runId: string) =>
    new WorkflowJournalError({ message: `There is no workflow run ${runId}.` });

  /** A run's folded state and pinned version, or none while it waits in its workflow's stream. */
  const loadRun = Effect.fn("WorkflowEngine.loadRun")(function* (runId: string, upTo?: number) {
    const facts = yield* journal.read(runStream(runId));
    const state = foldRun(
      runId,
      upTo === undefined ? facts : facts.filter((fact) => fact.seq <= upTo),
    );
    if (state.started === null) return { state, compiled: null };
    const version = yield* catalog.pinned(state.started.workflowId, state.started.commit);
    return { state, compiled: version.compiled };
  });

  const summaryOf = Effect.fn("WorkflowEngine.summaryOf")(function* (runId: string) {
    const { state } = yield* loadRun(runId);
    if (state.started !== null) return runSummary(state, yield* Clock.currentTimeMillis);
    const workflowId = yield* journal.workflowOfRun(runId);
    if (workflowId._tag === "None") return yield* unknownRun(runId);
    const current = yield* catalog.current(workflowId.value);
    const title =
      current._tag === "Ready" ? current.version.compiled.definition.title : workflowId.value;
    const summary = pendingSummary(
      yield* journal.read(workflowStream(workflowId.value)),
      runId,
      title,
    );
    return summary ?? (yield* unknownRun(runId));
  });

  const startedRun = (runId: string) =>
    loadRun(runId).pipe(
      Effect.flatMap(({ state, compiled }) =>
        compiled === null ? Effect.fail(unknownRun(runId)) : Effect.succeed({ state, compiled }),
      ),
    );

  const STEPS_PAGE = 200;
  const pageOf = <A>(items: ReadonlyArray<A>, cursor: string | undefined, limit: number) => {
    const offset = cursor === undefined ? 0 : Number(cursor);
    const page = items.slice(offset, offset + limit);
    return {
      page,
      next: offset + limit < items.length ? String(offset + limit) : null,
    };
  };

  const summariesOf = Effect.fn("WorkflowEngine.summariesOf")(function* (
    workflowId: string | null,
  ) {
    const created = yield* journal.createdRuns(workflowId);
    const summaries: Array<{
      readonly summary: WorkflowRunSummary;
      readonly state: RunState;
      readonly compiled: CompiledWorkflow | null;
    }> = [];
    for (const { runId } of created) {
      // One run that cannot load (its pinned version no longer compiles) must not hide the rest.
      const loaded = yield* loadRun(runId).pipe(
        Effect.catchCause((cause) =>
          Effect.logError("workflow run could not be loaded", { runId, cause }).pipe(
            Effect.as(null),
          ),
        ),
      );
      if (loaded === null || loaded.state.started === null) continue;
      summaries.push({
        summary: runSummary(loaded.state, yield* Clock.currentTimeMillis),
        ...loaded,
      });
    }
    return summaries;
  });

  const rpc = {
    startRun: Effect.fn("WorkflowEngine.startRun")(function* (
      input: WorkflowRunStartInput,
      by: string,
    ) {
      const current = yield* catalog.current(input.workflowId);
      const invalid = (message: string) => new WorkflowsError({ code: "invalid-request", message });
      if (current._tag !== "Ready")
        return yield* invalid("This workflow is not valid; fix it before running it.");
      const definition = current.version.compiled.definition;
      const trigger = input.testTrigger
        ? Object.entries(definition.triggers ?? {}).find(([id]) => id === input.testTrigger)
        : Object.entries(definition.triggers ?? {}).find(([, value]) => value.kind === "manual");
      if (input.testTrigger && trigger?.[1].kind !== "webhook")
        return yield* invalid("Test runs need a webhook trigger.");
      if (!trigger)
        return yield* invalid(
          "This workflow has no manual trigger. Add one in the editor to run it from here.",
        );
      const label = `${input.testTrigger ? "Test event" : "Run now"} by ${by}`;
      let payload: Json = { by };
      let params;
      if (input.testTrigger && trigger[1].kind === "webhook") {
        const sample = yield* journal.triggerSample(input.workflowId, input.testTrigger);
        if (Option.isNone(sample))
          return yield* invalid(
            "This trigger has no captured event yet: listen for a test event first.",
          );
        payload = sample.value.payload;
        const root = {
          ...(payload !== null && typeof payload === "object" && !Array.isArray(payload)
            ? Object.fromEntries(Object.entries(payload))
            : {}),
          id: trigger[0],
          kind: "webhook",
          label,
        };
        params = triggerParams(trigger[1].params, root);
      } else {
        const decoded = decodeRunParams(definition.params, input.params ?? {});
        if (!decoded.ok)
          return yield* invalid(decoded.errors.map((error) => error.message).join("; "));
        params = decoded.params;
      }
      const occurrence = input.testTrigger
        ? occurrenceKey.test(input.testTrigger, input.clientRequestId)
        : occurrenceKey.manual(input.clientRequestId);
      const existing = yield* journal.get(workflowStream(input.workflowId), occurrence);
      if (
        existing._tag === "Some" &&
        existing.value.fact._tag === "TriggerFired" &&
        canonicalParams(existing.value.fact.params) !== canonicalParams(params)
      ) {
        return yield* new WorkflowJournalError({
          message: `clientRequestId ${input.clientRequestId} already started a run with other params.`,
        });
      }
      const { runId } = yield* engine.start({
        workflowId: input.workflowId,
        triggerId: trigger[0],
        kind: trigger[1].kind,
        occurrence,
        label,
        params,
        payload,
        causalDepth: 0,
        parent: null,
      });
      return yield* summaryOf(runId);
    }),
    runTrigger: Effect.fn("WorkflowEngine.runTrigger")(function* (input: WorkflowRunTriggerInput) {
      const { state } = yield* loadRun(input.runId);
      let payload = state.started?.trigger.payload;
      if (payload === undefined) {
        const owner = yield* journal.workflowOfRun(input.runId);
        const fired = Option.isSome(owner)
          ? (yield* journal.read(workflowStream(owner.value))).find(
              (entry) => entry.fact._tag === "TriggerFired" && entry.fact.runId === input.runId,
            )?.fact
          : undefined;
        if (fired?._tag !== "TriggerFired") return yield* unknownRun(input.runId);
        payload = fired.payload;
      }
      const serialized = yield* encodeTriggerPayload(payload).pipe(Effect.orDie);
      const truncated =
        input.maxBytes !== undefined && Buffer.byteLength(serialized) > input.maxBytes;
      return { payload: truncated ? null : payload, truncated };
    }),
    runView: Effect.fn("WorkflowEngine.runView")(function* (input: WorkflowRunGetInput) {
      const [pin, offset] = input.stepsCursor?.includes(":") ? input.stepsCursor.split(":") : [];
      const parsedPin = Number(pin);
      const upTo =
        pin !== undefined && Number.isSafeInteger(parsedPin) && parsedPin >= 0
          ? parsedPin
          : undefined;
      const { state, compiled } = yield* loadRun(input.runId, upTo);
      if (compiled === null) {
        const owner = yield* journal.workflowOfRun(input.runId);
        const fired = Option.isSome(owner)
          ? (yield* journal.read(workflowStream(owner.value)))
              .map((entry) => entry.fact)
              .find((fact) => fact._tag === "TriggerFired" && fact.runId === input.runId)
          : undefined;
        if (fired?._tag !== "TriggerFired") return yield* unknownRun(input.runId);
        return {
          summary: yield* summaryOf(input.runId),
          trigger: runTriggerView({ ...fired, id: fired.triggerId }),
          definition: null,
          seq: state.lastSeq,
          steps: [],
          nextStepsCursor: null,
          blocks: [],
          gates: [],
        };
      }
      if (state.started === null) return yield* unknownRun(input.runId);
      const steps = pageOf(stepViews(compiled, state), offset ?? input.stepsCursor, STEPS_PAGE);
      return {
        summary: runSummary(state, yield* Clock.currentTimeMillis),
        trigger: runTriggerView(state.started.trigger),
        definition: compiled.definition,
        seq: state.lastSeq,
        steps: steps.page,
        nextStepsCursor: steps.next === null ? null : `${state.lastSeq}:${steps.next}`,
        blocks: blockViews(compiled, state),
        gates: gateViews(state),
        ...(state.warnings.length === 0 ? {} : { warnings: runWarnings(state) }),
      };
    }),
    subscribeRun: (input: WorkflowRunSubscribeInput) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* journal.subscribe;
          let { state, compiled } = yield* loadRun(input.runId);
          const owner = yield* journal.workflowOfRun(input.runId);
          const current =
            state.started === null && Option.isSome(owner)
              ? yield* catalog.current(owner.value)
              : null;
          const title =
            current?._tag === "Ready"
              ? current.version.compiled.definition.title
              : Option.isSome(owner)
                ? owner.value
                : "";
          const queuedFacts =
            state.started === null && Option.isSome(owner)
              ? yield* journal.read(workflowStream(owner.value))
              : [];
          const trigger = queuedFacts.find(
            (entry) => entry.fact._tag === "TriggerFired" && entry.fact.runId === input.runId,
          );
          let queued = pendingSummary(queuedFacts, input.runId, title);
          const occurrence = trigger?.fact._tag === "TriggerFired" ? trigger.fact.occurrence : null;
          let sent = input.afterSeq;
          const deltaNow = (now: number): ReadonlyArray<WorkflowRunDelta> => {
            if (compiled === null || state.lastSeq <= sent) return [];
            const delta = runDelta(compiled, state, sent, now);
            sent = state.lastSeq;
            return [delta];
          };
          const stream = runStream(input.runId);
          const changes = Stream.fromSubscription(subscription).pipe(
            Stream.filter(
              (fact) =>
                fact.stream === stream ||
                (state.started === null &&
                  Option.isSome(owner) &&
                  fact.stream === workflowStream(owner.value) &&
                  (fact.key === `created:${occurrence}` || fact.key === `skipped:${occurrence}`)),
            ),
            // Publish order is not commit order: a published fact only says the stream moved,
            // so the subscriber reads what committed after its last fact, as the actor does.
            Stream.mapEffect((published) =>
              Effect.gen(function* () {
                if (published.stream !== stream && Option.isSome(owner) && trigger !== undefined) {
                  const found: StoredFact[] = [];
                  for (const key of [`created:${occurrence}`, `skipped:${occurrence}`]) {
                    const entry = yield* journal.get(workflowStream(owner.value), key);
                    if (Option.isSome(entry)) found.push(entry.value);
                  }
                  const summary = pendingSummary([trigger, ...found], input.runId, title);
                  if (summary === null || summary.status === queued?.status) return [];
                  queued = summary;
                  return [
                    {
                      runId: input.runId,
                      seq: state.lastSeq,
                      summary,
                      steps: [],
                      gates: [],
                      blocks: [],
                    },
                  ];
                }
                for (const fact of yield* journal.read(stream, state.lastSeq)) {
                  state = applyRunFact(state, fact);
                }
                if (compiled === null && state.started !== null) {
                  compiled = (yield* catalog.pinned(state.started.workflowId, state.started.commit))
                    .compiled;
                }
                if (state.started === null) {
                  const summary = yield* summaryOf(input.runId);
                  return [
                    {
                      runId: input.runId,
                      seq: state.lastSeq,
                      summary,
                      steps: [],
                      gates: [],
                      blocks: [],
                    },
                  ];
                }
                return deltaNow(yield* Clock.currentTimeMillis);
              }),
            ),
            Stream.flatMap((deltas) => Stream.fromIterable(deltas)),
          );
          const initial =
            state.started === null
              ? [
                  {
                    runId: input.runId,
                    seq: state.lastSeq,
                    summary: queued ?? (yield* summaryOf(input.runId)),
                    steps: [],
                    gates: [],
                    blocks: [],
                  },
                ]
              : deltaNow(yield* Clock.currentTimeMillis);
          return Stream.concat(Stream.fromIterable(initial), changes).pipe(
            Stream.takeUntil((delta) => delta.summary.status === "skipped"),
          );
        }),
      ),
    stepDetail: Effect.fn("WorkflowEngine.stepDetail")(function* (input: WorkflowRunStepInput) {
      const { state, compiled } = yield* startedRun(input.runId);
      const detail = stepDetail(compiled, state, input.step, input.attempt);
      if (detail === null) {
        return yield* new WorkflowJournalError({
          message: `Run ${input.runId} has no attempt ${input.attempt} of ${input.step}.`,
        });
      }
      return detail;
    }),
    controlRun: Effect.fn("WorkflowEngine.controlRun")(function* (
      input: WorkflowRunControlInput,
      by: string,
    ) {
      const control = input.control;
      // An unknown run fails here, before a control could open a stream for it.
      yield* summaryOf(input.runId);
      if (control._tag === "retry") {
        const { state, compiled } = yield* startedRun(input.runId);
        const refusal = retryRefusal(compiled, state, control.step);
        if (refusal !== null) {
          return yield* new WorkflowJournalError({ message: `Cannot retry: ${refusal}.` });
        }
      }
      yield* journal.append([
        {
          stream: runStream(input.runId),
          key: `control:${input.clientRequestId}`,
          fact: {
            _tag: "ControlRequested",
            control: control._tag,
            step: control._tag === "retry" ? control.step : null,
            ...(control._tag === "amendBudget"
              ? {
                  budget: {
                    ...(control.steps === undefined ? {} : { steps: control.steps }),
                    ...(control.wall === undefined ? {} : { wallMs: durationMs(control.wall) }),
                    ...(control.tokens === undefined ? {} : { tokens: control.tokens }),
                  },
                }
              : {}),
            by,
            at: yield* nowIso,
          },
        },
      ]);
      // An ended run's actor is gone; a retry that reopens it needs one.
      yield* ensureActor(input.runId);
      return yield* summaryOf(input.runId);
    }),
    gateDecide: Effect.fn("WorkflowEngine.gateDecide")(function* (input: WorkflowGateDecideInput) {
      yield* engine.decideGate({
        runId: input.runId,
        gateKey: input.gateKey,
        option: input.option,
        note: input.note ?? null,
      });
      const { state } = yield* loadRun(input.runId);
      const view = gateViews(state).find((gate) => gate.key === input.gateKey);
      return (
        view ?? (yield* new WorkflowJournalError({ message: `There is no gate ${input.gateKey}.` }))
      );
    }),
    listRuns: Effect.fn("WorkflowEngine.listRuns")(function* (input: WorkflowRunsListInput) {
      const { workflowId, status, cursor, limit: pageLimit, ...filters } = input;
      const offset = cursor === undefined ? 0 : Number(cursor);
      const limit = pageLimit ?? 50;
      const page = yield* journal.runs({
        ...filters,
        workflowId: workflowId ?? null,
        status: status ?? null,
        offset,
        limit,
      });
      return { runs: page.runs, nextCursor: page.more ? String(offset + limit) : null };
    }),
    metrics: Effect.fn("WorkflowEngine.metrics")(function* (input: WorkflowMetricsInput) {
      const since = input.since === undefined ? null : Date.parse(input.since);
      const runs = (yield* summariesOf(input.workflowId)).filter(
        ({ summary }) => since === null || Date.parse(summary.startedAt) >= since,
      );
      const counts = new Map<WorkflowRunStatus, number>();
      const nodes = new Map<
        string,
        { attempts: number; failures: number; billable: number; costed: number }
      >();
      for (const { summary, state, compiled } of runs) {
        counts.set(summary.status, (counts.get(summary.status) ?? 0) + 1);
        if (compiled === null) continue;
        for (const view of stepViews(compiled, state)) {
          if (view.status === "skipped") continue;
          const entry = nodes.get(view.node) ?? {
            attempts: 0,
            failures: 0,
            billable: 0,
            costed: 0,
          };
          // An accept or judge sub-step spends for its step but is not another attempt of it.
          if (!isSubStep(view.key)) {
            entry.attempts += 1;
            if (view.status !== "succeeded" && view.endedAt !== null) entry.failures += 1;
          }
          if (view.cost !== null) {
            entry.billable += view.cost.billable;
            entry.costed += 1;
          }
          nodes.set(view.node, entry);
        }
      }
      return {
        workflowId: input.workflowId,
        since: input.since ?? null,
        runsByStatus: [...counts].map(([status, count]) => ({ status, count })),
        runs: runs
          .map(({ summary }) => ({
            runId: summary.runId,
            status: summary.status,
            startedAt: summary.startedAt,
            activeMs: null,
            billable: summary.cost.billable,
            usdEstimate: summary.cost.usdEstimate,
          }))
          .reverse(),
        nodes: [...nodes].map(([node, entry]) => ({
          node,
          attempts: entry.attempts,
          failures: entry.failures,
          averageBillable: entry.costed === 0 ? null : entry.billable / entry.costed,
        })),
        series: [],
      };
    }),
    ledger: Effect.fn("WorkflowEngine.ledger")(function* (input: WorkflowLedgerInput) {
      const entries: WorkflowLedgerEntry[] = [];
      for (const id of input.ledger ? [input.ledger] : yield* journal.ledgerIds) {
        const ledger = foldLedger(id, yield* journal.read(ledgerStream(id)));
        for (const entry of ledger.entries.values()) {
          if (input.workflowId && entry.workflowId !== input.workflowId) continue;
          if (input.verdict && entry.verdict !== input.verdict) continue;
          entries.push(
            yield* decodeLedgerEntry({
              ...entry,
              ledger: id,
              before: Option.getOrNull(decodeMetricReading(entry.before)),
              after: Option.getOrNull(decodeMetricReading(entry.after)),
            }).pipe(Effect.orDie),
          );
        }
      }
      const result = pageOf(entries, input.cursor, input.limit ?? 100);
      return { entries: result.page, nextCursor: result.next };
    }),
  };

  const engine = {
    start: Effect.fn("WorkflowEngine.start")(function* (request: TriggerRequest) {
      const at = yield* nowIso;
      const fired: NewFact = {
        stream: workflowStream(request.workflowId),
        key: request.occurrence,
        fact: {
          _tag: "TriggerFired",
          runId: runIdFor(request.workflowId, request.occurrence),
          triggerId: request.triggerId,
          kind: request.kind,
          occurrence: request.occurrence,
          label: request.label,
          params: request.params,
          payload: request.payload,
          causalDepth: request.causalDepth,
          parent: request.parent,
          at,
        },
      };
      yield* journal.append([fired]);
      yield* promote(request.workflowId);
      return { runId: runIdFor(request.workflowId, request.occurrence) };
    }),
    control: Effect.fn("WorkflowEngine.control")(function* (input: ControlInput) {
      yield* journal.append([
        {
          stream: runStream(input.runId),
          key: `control:${input.clientRequestId}`,
          fact: {
            _tag: "ControlRequested",
            control: input.control,
            step: input.step,
            by: input.by,
            at: yield* nowIso,
          },
        },
      ]);
    }),
    decideGate: Effect.fn("WorkflowEngine.decideGate")(function* (input: GateDecisionInput) {
      const state = foldRun(input.runId, yield* journal.read(runStream(input.runId)));
      const gate = state.gates.get(input.gateKey);
      if (gate === undefined) {
        return yield* new WorkflowJournalError({ message: `There is no gate ${input.gateKey}.` });
      }
      if (gate.decision !== null) return gate.decision;
      if (!gate.intent.options.includes(input.option)) {
        return yield* new WorkflowJournalError({
          message: `"${input.option}" is not one of ${gate.intent.options.join(", ")}.`,
        });
      }
      const [stored] = yield* journal.append([
        {
          stream: runStream(input.runId),
          key: `gate:${input.gateKey}`,
          fact: {
            _tag: "GateDecided",
            gateKey: input.gateKey,
            option: input.option,
            note: input.note,
            by: "user",
            at: yield* nowIso,
          },
        },
      ]);
      const fact = stored?.fact.fact;
      if (fact?._tag !== "GateDecided") {
        return yield* new WorkflowJournalError({ message: "The gate decision was not stored." });
      }
      return fact;
    }),
    runState: Effect.fn("WorkflowEngine.runState")(function* (runId: string) {
      return foldRun(runId, yield* journal.read(runStream(runId)));
    }),
    tick,
    rebuildProjection,
  };
  return WorkflowEngine.of({ ...engine, ...rpc });
});

/** The engine plus its tick loop, which starts once the server finished startup recovery. */
export const layer = (options: WorkflowEngineOptions) =>
  Layer.effect(
    WorkflowEngine,
    Effect.gen(function* () {
      const engine = yield* make(options);
      yield* forkParked(
        engine.rebuildProjection.pipe(
          Effect.catch((error) => Effect.logWarning("workflow projection rebuild failed", error)),
          Effect.andThen(
            engine.tick.pipe(
              Effect.catch((error) => Effect.logWarning("workflow tick failed", error)),
              Effect.repeat(Schedule.spaced(options.tickEvery ?? DEFAULT_TICK)),
            ),
          ),
        ),
      );
      return engine;
    }),
  );
