// @effect-diagnostics preferSchemaOverJson:off globalDateInEffect:off - Journal storage explicitly uses encoded JSON and ISO timestamps from Clock.
/**
 * The only writer of workflow facts. Each append is one `BEGIN IMMEDIATE` transaction over every
 * stream in the batch; a fact whose (stream, key) is already stored is not written again, and the
 * caller gets the stored one. One process writes (the bots host), so seq is `MAX(seq) + 1` inside it.
 */
import {
  WorkflowRunSummary,
  type WorkflowRunsListInput,
  type WorkflowRunStatus,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as BotsDb from "../BotsDb.ts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";

import { Fact, type NewFact, type StoredFact, workflowStream } from "./facts.ts";
import { type WorkflowStatus, workflowStatus } from "./workflowStatus.ts";

export class WorkflowJournalError extends Data.TaggedError("WorkflowJournalError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface AppendResult {
  /** The fact as stored: the new one, or the one that already held its key. */
  readonly fact: StoredFact;
  readonly inserted: boolean;
}

/** One run's row in the projection read by run lists. */
export interface RunRow {
  readonly summary: WorkflowRunSummary;
  readonly lastSeq: number;
  readonly pendingIntents: number;
  readonly parentRunId: string | null;
}

export class Journal extends Context.Service<
  Journal,
  {
    readonly triggerSample: (
      workflowId: string,
      triggerId: string,
    ) => Effect.Effect<
      Option.Option<{
        readonly at: string;
        readonly occurrence: string;
        readonly runId: string | null;
        readonly test: boolean;
        readonly payload: Schema.Json;
      }>,
      WorkflowJournalError
    >;
    readonly triggerLastFired: Effect.Effect<
      ReadonlyArray<{
        readonly workflowId: string;
        readonly triggerId: string;
        readonly at: string;
      }>,
      WorkflowJournalError
    >;
    readonly captureTestDelivery: (input: {
      readonly workflowId: string;
      readonly triggerId: string;
      readonly deliveryId: string;
      readonly payload: Schema.Json;
    }) => Effect.Effect<"captured" | "replayed", WorkflowJournalError>;
    readonly isTestDelivery: (deliveryId: string) => Effect.Effect<boolean, WorkflowJournalError>;
    readonly putRun: (row: RunRow) => Effect.Effect<void, WorkflowJournalError>;
    readonly runs: (
      query: {
        readonly workflowId: string | null;
        readonly status: WorkflowRunStatus | null;
        readonly offset: number;
        readonly limit: number;
      } & Pick<
        WorkflowRunsListInput,
        "workflowIds" | "states" | "triggerKinds" | "startedAfter" | "query"
      >,
    ) => Effect.Effect<
      { readonly runs: ReadonlyArray<WorkflowRunSummary>; readonly more: boolean },
      WorkflowJournalError
    >;
    readonly lastRuns: Effect.Effect<ReadonlyMap<string, WorkflowRunSummary>, WorkflowJournalError>;
    /** Runs that have not ended, newest first; waiting and paused ones are never cut by the limit. */
    readonly activeRuns: Effect.Effect<ReadonlyArray<WorkflowRunSummary>, WorkflowJournalError>;
    readonly projectionLag: Effect.Effect<
      ReadonlyArray<{
        readonly runId: string;
        readonly projected: number | null;
        readonly stream: number;
      }>,
      WorkflowJournalError
    >;
    /** Results in batch order. An empty batch is a no-op. */
    /** One result per stored fact, in order; a guarded fact whose guard fails is skipped. */
    readonly append: (
      batch: ReadonlyArray<NewFact>,
    ) => Effect.Effect<ReadonlyArray<AppendResult>, WorkflowJournalError>;
    /** The stream's facts with seq > afterSeq (default 0), ascending. */
    readonly read: (
      stream: string,
      afterSeq?: number,
    ) => Effect.Effect<ReadonlyArray<StoredFact>, WorkflowJournalError>;
    readonly get: (
      stream: string,
      key: string,
    ) => Effect.Effect<Option.Option<StoredFact>, WorkflowJournalError>;
    readonly ledgerIds: Effect.Effect<ReadonlyArray<string>, WorkflowJournalError>;
    /**
     * Run ids that started and did not end, plus ended runs with an intent still waiting for its
     * result or a sharing child's end not yet reported to its caller (`reportPending`).
     */
    readonly liveRuns: Effect.Effect<ReadonlyArray<string>, WorkflowJournalError>;
    /** Each skipped call's TriggerFired and TriggerSkipped whose run has no row yet. */
    readonly unlistedSkippedCalls: Effect.Effect<
      ReadonlyArray<{ readonly fired: StoredFact; readonly skipped: StoredFact }>,
      WorkflowJournalError
    >;
    /** Workflow ids with a TriggerFired that has neither RunCreated nor TriggerSkipped. */
    readonly pendingTriggers: Effect.Effect<ReadonlyArray<string>, WorkflowJournalError>;
    /** The live runs, as `liveRuns` counts them, whose RunStarted names this workflow. */
    readonly liveRunsOf: (
      workflowId: string,
    ) => Effect.Effect<ReadonlyArray<string>, WorkflowJournalError>;
    /** Runs with a fact stored at or after `at` (ISO), by id. */
    readonly runsTouchedSince: (
      at: string,
    ) => Effect.Effect<ReadonlyArray<string>, WorkflowJournalError>;
    /** The workflow's switch, read from its last Toggled and its last Suspended or Unsuspended. */
    readonly workflowStatus: (
      workflowId: string,
    ) => Effect.Effect<WorkflowStatus, WorkflowJournalError>;
    /**
     * What the workflow decider reads, in seq order: the TriggerFired facts with neither
     * RunCreated nor TriggerSkipped, and the last `outcomes` RunOutcomes since the last Suspended
     * or Unsuspended.
     */
    readonly workflowBacklog: (
      workflowId: string,
      outcomes: number,
    ) => Effect.Effect<ReadonlyArray<StoredFact>, WorkflowJournalError>;
    /** The workflow a run id belongs to, from its TriggerFired; none when no trigger names it. */
    readonly workflowOfRun: (
      runId: string,
    ) => Effect.Effect<Option.Option<string>, WorkflowJournalError>;
    /** Runs created, newest first, of one workflow or of all. */
    readonly createdRuns: (
      workflowId: string | null,
    ) => Effect.Effect<
      ReadonlyArray<{ readonly workflowId: string; readonly runId: string; readonly at: string }>,
      WorkflowJournalError
    >;
    /**
     * Every fact inserted after this subscription opens, once its transaction commits, in commit
     * order. Subscribe before reading a stream so no fact lands between the read and the wait.
     */
    readonly subscribe: Effect.Effect<PubSub.Subscription<StoredFact>, never, Scope.Scope>;
    /**
     * The workflow id of each run whose row `putRun` created or moved in what a run list shows:
     * status, open gates or end. Published after the row is written.
     */
    readonly subscribeRunChanges: Effect.Effect<PubSub.Subscription<string>, never, Scope.Scope>;
    /** Moves whenever any run row is written: a change to any run, not only a workflow's last. */
    readonly runsRevision: Effect.Effect<string, WorkflowJournalError>;
  }
>()("t3/bots/workflows/Journal") {}

interface Row {
  readonly stream: string;
  readonly seq: number;
  readonly key: string;
  readonly payload_json: string;
  readonly at: string;
}
const fail = (cause: unknown) =>
  new WorkflowJournalError({ message: "Workflow journal operation failed", cause });
const decodeRunSummary = Schema.decodeUnknownEffect(WorkflowRunSummary);
const encodeRunSummary = Schema.encodeSync(WorkflowRunSummary);
const decodePayload = Schema.decodeEffect(Schema.fromJsonString(Schema.Json));
const decodeFact = Schema.decodeUnknownEffect(Fact);
const encodeFact = Schema.encodeSync(Fact);
const decode = Effect.fn("Journal.decode")(function* (row: Row) {
  const json = yield* Effect.try({
    try: () => JSON.parse(row.payload_json) as unknown,
    catch: fail,
  });
  const fact = yield* decodeFact(json).pipe(Effect.mapError(fail));
  return { stream: row.stream, seq: row.seq, key: row.key, at: row.at, fact };
});
/** What `runNeedsYou` (client-runtime) shows as "needs you": an open gate or a pause only the user lifts. */
const RUN_LIST_STATE = `CASE WHEN status IN ('queued', 'running', 'paused') AND (open_gates > 0
  OR (status = 'paused' AND json_extract(summary_json, '$.pausedFor') IN ('fatigue', 'ambiguous')))
  THEN 'needs_you' ELSE status END`;

/** The run list's optional filters; `runMatchesListInput` (client-runtime) applies the same rules. */
const runFilters = (
  sql: SqlClient.SqlClient,
  query: Pick<
    WorkflowRunsListInput,
    "workflowIds" | "states" | "triggerKinds" | "startedAfter" | "query"
  >,
) => {
  const anyOf = (column: string, values: ReadonlyArray<string> | undefined) =>
    values === undefined
      ? []
      : [values.length === 0 ? sql`0` : sql`${sql.literal(column)} IN ${sql.in(values)}`];
  const text = query.query?.trim() ?? "";
  // Stored starts are `toISOString` text, so the bound is normalized before comparing strings.
  const after =
    query.startedAfter === undefined ? Option.none() : DateTime.make(query.startedAfter);
  return [
    ...anyOf("workflow_id", query.workflowIds),
    ...anyOf(RUN_LIST_STATE, query.states),
    ...anyOf("trigger_kind", query.triggerKinds),
    ...Option.match(after, {
      onNone: () => [],
      onSome: (start) => [sql`started_at >= ${DateTime.formatIso(start)}`],
    }),
    ...(text === ""
      ? []
      : [
          sql`(instr(lower(json_extract(summary_json, '$.title')), lower(${text})) > 0
            OR instr(lower(json_extract(summary_json, '$.trigger.label')), lower(${text})) > 0)`,
        ]),
  ];
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const pubsub = yield* PubSub.unbounded<StoredFact>();
  const runChanges = yield* PubSub.unbounded<string>();
  const liveRuns = sql<{
    readonly id: string;
  }>`SELECT substr(stream, 5) AS id FROM workflow_facts f WHERE stream LIKE 'run:%' AND
      ((kind = 'RunStarted' AND (SELECT COUNT(*) FROM workflow_facts e WHERE e.stream = f.stream AND e.kind = 'RunEnded') <= (SELECT COUNT(*) FROM workflow_facts e WHERE e.stream = f.stream AND e.kind = 'RunReopened'))
      OR (kind = 'IntentRecorded' AND NOT EXISTS (SELECT 1 FROM workflow_facts r WHERE r.stream = f.stream AND r.key = 'result:' || f.key))
      OR (kind = 'RunStarted' AND json_extract(payload_json, '$.inherit') IS NOT NULL AND json_extract(payload_json, '$.parent') IS NOT NULL AND NOT EXISTS (SELECT 1 FROM workflow_facts r WHERE r.stream = f.stream AND r.key = 'reported')))
      GROUP BY stream ORDER BY id`.pipe(Effect.map((rows) => rows.map((row) => row.id)));
  const get = Effect.fn("Journal.get")(function* (stream: string, key: string) {
    const rows =
      yield* sql<Row>`SELECT * FROM workflow_facts WHERE stream = ${stream} AND key = ${key}`;
    return rows[0] ? Option.some(yield* decode(rows[0])) : Option.none();
  }, Effect.mapError(fail));
  const decodeSummary = Effect.fn("Journal.decodeSummary")(function* (row: {
    readonly summary_json: string;
  }) {
    const json = yield* Effect.try({
      try: () => JSON.parse(row.summary_json) as unknown,
      catch: fail,
    });
    return yield* decodeRunSummary(json).pipe(Effect.mapError(fail));
  });
  return Journal.of({
    triggerSample: Effect.fn("Journal.triggerSample")(function* (workflowId, triggerId) {
      const rows = yield* sql<{
        at: string;
        occurrence: string;
        runId: string | null;
        test: number;
        payload_json: string;
      }>`SELECT at, occurrence, run_id AS runId, test, payload_json FROM workflow_trigger_samples WHERE workflow_id = ${workflowId} AND trigger_id = ${triggerId}`;
      if (!rows[0]) return Option.none();
      const row = rows[0];
      const payload = yield* decodePayload(row.payload_json);
      return Option.some({
        at: row.at,
        occurrence: row.occurrence,
        runId: row.runId,
        test: row.test === 1,
        payload,
      });
    }, Effect.mapError(fail)),
    triggerLastFired: sql<{
      workflowId: string;
      triggerId: string;
      at: string;
    }>`SELECT workflow_id AS workflowId, trigger_id AS triggerId, at FROM workflow_trigger_samples ORDER BY workflow_id, trigger_id`.pipe(
      Effect.mapError(fail),
    ),
    isTestDelivery: Effect.fn("Journal.isTestDelivery")(function* (deliveryId) {
      const rows =
        yield* sql`SELECT 1 FROM workflow_test_deliveries WHERE delivery_id = ${deliveryId}`;
      return rows.length > 0;
    }, Effect.mapError(fail)),
    captureTestDelivery: Effect.fn("Journal.captureTestDelivery")(function* (input) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const at = new Date(yield* Clock.currentTimeMillis).toISOString();
          const rows =
            yield* sql`INSERT INTO workflow_test_deliveries (delivery_id, workflow_id, trigger_id, at) VALUES (${input.deliveryId}, ${input.workflowId}, ${input.triggerId}, ${at}) ON CONFLICT DO NOTHING RETURNING delivery_id`;
          if (rows.length === 0) return "replayed" as const;
          yield* sql`INSERT INTO workflow_trigger_samples (workflow_id, trigger_id, at, occurrence, run_id, test, payload_json) VALUES (${input.workflowId}, ${input.triggerId}, ${at}, ${"test-capture:" + input.deliveryId}, NULL, 1, ${JSON.stringify(input.payload)}) ON CONFLICT(workflow_id, trigger_id) DO UPDATE SET at=excluded.at, occurrence=excluded.occurrence, run_id=excluded.run_id, test=excluded.test, payload_json=excluded.payload_json`;
          return "captured" as const;
        }),
      );
    }, Effect.mapError(fail)),
    putRun: Effect.fn("Journal.putRun")(function* (row) {
      const s = row.summary;
      const summary = yield* Effect.try({
        try: () => JSON.stringify(encodeRunSummary(s)),
        catch: fail,
      });
      const values = {
        run_id: s.runId,
        workflow_id: s.workflowId,
        commit_sha: s.commit ?? "",
        hash: s.hash ?? "",
        status: s.status,
        trigger_kind: s.trigger.kind,
        started_at: s.startedAt,
        ended_at: s.endedAt,
        output_status: s.outputStatus,
        steps_used: s.stepsUsed,
        tokens_billable: s.cost.billable,
        tokens_cache_read: s.cost.cacheRead,
        tokens_reserved: s.reservedTokens,
        usd_estimate: s.cost.usdEstimate,
        active_ms: s.activeMs ?? 0,
        open_gates: s.openGates,
        pending_intents: row.pendingIntents,
        last_seq: row.lastSeq,
        parent_run_id: row.parentRunId,
        card_ticket_id: null,
        pull_request_url: s.pullRequest,
        summary_json: summary,
      };
      // The waiting gate is listed too: one gate can close as the next opens, same count, and
      // its openedAt arrives after it is first projected.
      const listed = (row: {
        readonly status: string;
        readonly open_gates: number;
        readonly ended_at: string | null;
        readonly gate_key: string | null;
        readonly gate_at: string | null;
      }) => `${row.status}|${row.open_gates}|${row.ended_at}|${row.gate_key}|${row.gate_at}`;
      const before = yield* sql<{
        readonly status: string;
        readonly open_gates: number;
        readonly ended_at: string | null;
        readonly gate_key: string | null;
        readonly gate_at: string | null;
      }>`SELECT status, open_gates, ended_at, json_extract(summary_json, '$.gate.key') AS gate_key, json_extract(summary_json, '$.gate.openedAt') AS gate_at FROM workflow_runs WHERE run_id = ${s.runId}`;
      const written =
        yield* sql`INSERT INTO workflow_runs ${sql.insert(values)} ON CONFLICT(run_id) DO UPDATE SET ${sql.update(values)} WHERE excluded.last_seq >= workflow_runs.last_seq RETURNING run_id`;
      const after = { ...values, gate_key: s.gate?.key ?? null, gate_at: s.gate?.openedAt ?? null };
      if (written.length > 0 && (before[0] === undefined || listed(before[0]) !== listed(after)))
        yield* PubSub.publish(runChanges, s.workflowId);
    }, Effect.mapError(fail)),
    runs: Effect.fn("Journal.runs")(function* (query) {
      const rows = yield* sql<{
        readonly summary_json: string;
      }>`SELECT summary_json FROM workflow_runs
        WHERE summary_json != '' AND (${query.workflowId} IS NULL OR workflow_id = ${query.workflowId})
        AND (${query.status} IS NULL OR status = ${query.status})
        AND ${sql.and(runFilters(sql, query))}
        ORDER BY started_at DESC, run_id ASC LIMIT ${query.limit + 1} OFFSET ${query.offset}`;
      return {
        runs: yield* Effect.forEach(rows.slice(0, query.limit), decodeSummary),
        more: rows.length > query.limit,
      };
    }, Effect.mapError(fail)),
    lastRuns: Effect.gen(function* () {
      const rows = yield* sql<{
        readonly summary_json: string;
      }>`SELECT r.summary_json FROM workflow_runs r
        WHERE r.summary_json != '' AND r.status != 'skipped' AND NOT EXISTS (SELECT 1 FROM workflow_runs n
          WHERE n.summary_json != '' AND n.status != 'skipped' AND n.workflow_id = r.workflow_id AND
          (n.started_at > r.started_at OR (n.started_at = r.started_at AND n.run_id < r.run_id)))`;
      const summaries = yield* Effect.forEach(rows, decodeSummary);
      return new Map(summaries.map((s) => [s.workflowId, s]));
    }).pipe(Effect.mapError(fail)),
    activeRuns: Effect.gen(function* () {
      const rows = yield* sql<{
        readonly summary_json: string;
      }>`SELECT summary_json FROM workflow_runs WHERE summary_json != '' AND ended_at IS NULL
        ORDER BY (open_gates > 0 OR status = 'paused') DESC, started_at DESC, run_id ASC LIMIT 50`;
      return yield* Effect.forEach(rows, decodeSummary);
    }).pipe(Effect.mapError(fail)),
    projectionLag: sql<{
      readonly runId: string;
      readonly projected: number | null;
      readonly stream: number;
    }>`
      SELECT substr(f.stream, 5) AS runId, CASE WHEN r.summary_json != '' THEN r.last_seq ELSE NULL END AS projected,
        MAX(f.seq) AS stream FROM workflow_facts f
      LEFT JOIN workflow_runs r ON r.run_id = substr(f.stream, 5)
      WHERE f.stream LIKE 'run:%' AND EXISTS (SELECT 1 FROM workflow_facts s WHERE s.stream = f.stream AND s.kind = 'RunStarted')
      GROUP BY f.stream ORDER BY runId`.pipe(Effect.mapError(fail)),
    append: Effect.fn("Journal.append")(function* (batch) {
      if (batch.length === 0) return [];
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const results = yield* sql.withTransaction(
            Effect.gen(function* () {
              const results: AppendResult[] = [];
              for (const item of batch) {
                if (item.guard !== undefined && Option.isNone(yield* get(item.stream, item.key))) {
                  const kinds = JSON.stringify(item.guard.absent);
                  const newer = yield* sql<{ readonly one: number }>`
                    SELECT 1 AS one FROM workflow_facts WHERE stream = ${item.stream}
                    AND seq > ${item.guard.after} AND kind IN (SELECT value FROM json_each(${kinds})) LIMIT 1`;
                  // A refused fact is not stored and has no result.
                  if (newer.length > 0) continue;
                }
                const at = new Date(yield* Clock.currentTimeMillis).toISOString();
                const payload = yield* Effect.try({
                  try: () => JSON.stringify(encodeFact(item.fact)),
                  catch: fail,
                });
                const rows = yield* sql<{
                  readonly seq: number;
                }>`INSERT INTO workflow_facts (stream, seq, key, kind, payload_json, at)
              VALUES (${item.stream}, (SELECT COALESCE(MAX(seq), 0) + 1 FROM workflow_facts WHERE stream = ${item.stream}), ${item.key}, ${item.fact._tag}, ${payload}, ${at})
              ON CONFLICT (stream, key) DO NOTHING RETURNING seq`;
                const fact = rows[0]
                  ? { ...item, seq: rows[0].seq, at }
                  : Option.getOrThrow(yield* get(item.stream, item.key));
                if (
                  rows.length > 0 &&
                  item.stream.startsWith("workflow:") &&
                  item.fact._tag === "TriggerFired"
                ) {
                  const fired = item.fact;
                  yield* sql`INSERT INTO workflow_trigger_samples (workflow_id, trigger_id, at, occurrence, run_id, test, payload_json) VALUES (${item.stream.slice("workflow:".length)}, ${fired.triggerId}, ${fired.at}, ${fired.occurrence}, ${fired.runId}, ${fired.occurrence.startsWith("test:") ? 1 : 0}, ${JSON.stringify(fired.payload)}) ON CONFLICT(workflow_id, trigger_id) DO UPDATE SET at=excluded.at, occurrence=excluded.occurrence, run_id=excluded.run_id, test=excluded.test, payload_json=excluded.payload_json`;
                }
                results.push({ fact, inserted: rows.length > 0 });
              }
              return results;
            }),
          );
          for (const result of results)
            if (result.inserted) yield* PubSub.publish(pubsub, result.fact);
          return results;
        }),
      );
    }, Effect.mapError(fail)),
    get,
    read: Effect.fn("Journal.read")(function* (stream, afterSeq = 0) {
      const rows =
        yield* sql<Row>`SELECT * FROM workflow_facts WHERE stream = ${stream} AND seq > ${afterSeq} ORDER BY seq`;
      return yield* Effect.forEach(rows, decode);
    }, Effect.mapError(fail)),
    ledgerIds: sql<{
      readonly id: string;
    }>`SELECT DISTINCT substr(stream, 8) AS id FROM workflow_facts WHERE stream LIKE 'ledger:%' ORDER BY id`.pipe(
      Effect.map((rows) => rows.map((row) => row.id)),
      Effect.mapError(fail),
    ),
    liveRuns: liveRuns.pipe(Effect.mapError(fail)),
    liveRunsOf: Effect.fn("Journal.liveRunsOf")(function* (workflowId: string) {
      const live = yield* liveRuns;
      if (live.length === 0) return [];
      const rows = yield* sql<{ readonly id: string }>`
        SELECT substr(stream, 5) AS id FROM workflow_facts
        WHERE kind = 'RunStarted' AND stream IN (SELECT 'run:' || value FROM json_each(${JSON.stringify(live)}))
        AND json_extract(payload_json, '$.workflowId') = ${workflowId} ORDER BY id`;
      return rows.map((row) => row.id);
    }, Effect.mapError(fail)),
    runsTouchedSince: Effect.fn("Journal.runsTouchedSince")(function* (at: string) {
      const rows = yield* sql<{ readonly id: string }>`
        SELECT DISTINCT substr(stream, 5) AS id FROM workflow_facts
        WHERE stream LIKE 'run:%' AND at >= ${at} ORDER BY id`;
      return rows.map((row) => row.id);
    }, Effect.mapError(fail)),
    workflowStatus: Effect.fn("Journal.workflowStatus")(function* (workflowId: string) {
      const stream = workflowStream(workflowId);
      // Without table stats SQLite takes the primary key and walks the whole stream for MAX(seq).
      const rows =
        yield* sql<Row>`SELECT * FROM workflow_facts WHERE stream = ${stream} AND (seq IN (SELECT MAX(seq) FROM workflow_facts INDEXED BY workflow_facts_kind WHERE stream = ${stream} AND kind = 'TriggerToggled' GROUP BY json_extract(payload_json, '$.triggerId')) OR seq IN (
        (SELECT MAX(seq) FROM workflow_facts INDEXED BY workflow_facts_kind WHERE stream = ${stream} AND kind = 'Toggled'),
        (SELECT MAX(seq) FROM workflow_facts INDEXED BY workflow_facts_kind WHERE stream = ${stream} AND kind IN ('Suspended', 'Unsuspended'))))
        ORDER BY seq`;
      return workflowStatus(yield* Effect.forEach(rows, decode));
    }, Effect.mapError(fail)),
    workflowBacklog: Effect.fn("Journal.workflowBacklog")(function* (
      workflowId: string,
      outcomes: number,
    ) {
      const stream = workflowStream(workflowId);
      const pending = yield* sql<Row>`SELECT * FROM workflow_facts f
        WHERE kind = 'TriggerFired' AND stream = ${stream} AND NOT EXISTS (SELECT 1 FROM workflow_facts r
        WHERE r.stream = f.stream AND (r.key = 'created:' || f.key OR r.key = 'skipped:' || f.key))`;
      const recent = yield* sql<Row>`SELECT * FROM workflow_facts
        WHERE kind = 'RunOutcome' AND stream = ${stream} AND seq > COALESCE((SELECT MAX(seq) FROM workflow_facts
        INDEXED BY workflow_facts_kind WHERE stream = ${stream} AND kind IN ('Suspended', 'Unsuspended')), 0)
        ORDER BY seq DESC LIMIT ${outcomes}`;
      return yield* Effect.forEach(
        [...pending, ...recent].sort((a, b) => a.seq - b.seq),
        decode,
      );
    }, Effect.mapError(fail)),
    unlistedSkippedCalls: Effect.gen(function* () {
      const rows = yield* sql<
        Row & {
          readonly skipped_seq: number;
          readonly skipped_payload: string;
          readonly skipped_at: string;
        }
      >`
        SELECT f.*, s.seq AS skipped_seq, s.payload_json AS skipped_payload, s.at AS skipped_at
        FROM workflow_facts s INDEXED BY workflow_facts_kind
        JOIN workflow_facts f ON f.stream = s.stream AND f.key = substr(s.key, 9)
        WHERE s.kind = 'TriggerSkipped' AND json_extract(f.payload_json, '$.parent') IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM workflow_runs r WHERE r.run_id = json_extract(f.payload_json, '$.runId'))
        ORDER BY s.stream, s.seq`;
      return yield* Effect.forEach(rows, (row) =>
        Effect.all({
          fired: decode(row),
          skipped: decode({
            stream: row.stream,
            seq: row.skipped_seq,
            key: `skipped:${row.key}`,
            payload_json: row.skipped_payload,
            at: row.skipped_at,
          }),
        }),
      );
    }).pipe(Effect.mapError(fail)),
    pendingTriggers: sql<{
      readonly id: string;
    }>`SELECT DISTINCT substr(stream, 10) AS id FROM workflow_facts f
      WHERE stream LIKE 'workflow:%' AND kind = 'TriggerFired' AND NOT EXISTS
      (SELECT 1 FROM workflow_facts r WHERE r.stream = f.stream AND (r.key = 'created:' || f.key OR r.key = 'skipped:' || f.key)) ORDER BY id`.pipe(
      Effect.map((rows) => rows.map((row) => row.id)),
      Effect.mapError(fail),
    ),
    workflowOfRun: Effect.fn("Journal.workflowOfRun")(function* (runId: string) {
      const rows = yield* sql<{ readonly stream: string }>`
        SELECT stream FROM workflow_facts
        WHERE kind = 'TriggerFired' AND json_extract(payload_json, '$.runId') = ${runId}
        LIMIT 1`;
      const stream = rows[0]?.stream;
      return stream === undefined ? Option.none() : Option.some(stream.slice("workflow:".length));
    }, Effect.mapError(fail)),
    createdRuns: Effect.fn("Journal.createdRuns")(function* (workflowId: string | null) {
      const rows = yield* sql<{
        readonly stream: string;
        readonly key: string;
        readonly at: string;
        readonly payload: string;
      }>`
        SELECT stream, key, at, payload_json AS payload FROM workflow_facts
        WHERE kind = 'RunCreated' AND (${workflowId} IS NULL OR stream = ${`workflow:${workflowId ?? ""}`})
        ORDER BY at DESC, seq DESC`;
      return rows.flatMap((row) => {
        const parsed: unknown = JSON.parse(row.payload);
        const runId =
          typeof parsed === "object" &&
          parsed !== null &&
          "runId" in parsed &&
          typeof parsed.runId === "string"
            ? parsed.runId
            : null;
        return runId === null
          ? []
          : [{ workflowId: row.stream.slice("workflow:".length), runId, at: row.at }];
      });
    }, Effect.mapError(fail)),
    subscribe: PubSub.subscribe(pubsub),
    subscribeRunChanges: PubSub.subscribe(runChanges),
    runsRevision: sql<{
      readonly revision: string;
    }>`SELECT COUNT(*) || ':' || COALESCE(SUM(last_seq), 0) AS revision FROM workflow_runs`.pipe(
      Effect.map((rows) => rows[0]?.revision ?? "0:0"),
      Effect.mapError(fail),
    ),
  });
});
export const layer = Layer.effect(Journal, make).pipe(Layer.provide(BotsDb.layer));
/** A journal over a migrated in-memory database. */
export const layerMemory = Layer.effect(Journal, make).pipe(Layer.provide(BotsDb.layerMemory));
/** A journal over the caller's database. */
export const layerFromDb = Layer.effect(Journal, make);
