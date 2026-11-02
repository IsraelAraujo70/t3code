// @effect-diagnostics preferSchemaOverJson:off globalDateInEffect:off - Journal storage explicitly uses encoded JSON and ISO timestamps from Clock.
/**
 * The only writer of workflow facts. Each append is one `BEGIN IMMEDIATE` transaction over every
 * stream in the batch; a fact whose (stream, key) is already stored is not written again, and the
 * caller gets the stored one. One process writes (the bots host), so seq is `MAX(seq) + 1` inside it.
 */
import { WorkflowRunSummary, type WorkflowRunStatus } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
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

import { Fact, type NewFact, type StoredFact } from "./facts.ts";

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
    readonly putRun: (row: RunRow) => Effect.Effect<void, WorkflowJournalError>;
    readonly runs: (query: {
      readonly workflowId: string | null;
      readonly status: WorkflowRunStatus | null;
      readonly offset: number;
      readonly limit: number;
    }) => Effect.Effect<
      { readonly runs: ReadonlyArray<WorkflowRunSummary>; readonly more: boolean },
      WorkflowJournalError
    >;
    readonly lastRuns: Effect.Effect<ReadonlyMap<string, WorkflowRunSummary>, WorkflowJournalError>;
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
    /** Run ids that started and did not end, plus ended runs with an intent still waiting for its result. */
    readonly ledgerIds: Effect.Effect<ReadonlyArray<string>, WorkflowJournalError>;
    readonly liveRuns: Effect.Effect<ReadonlyArray<string>, WorkflowJournalError>;
    /** Workflow ids with a TriggerFired that has neither RunCreated nor TriggerSkipped. */
    readonly pendingTriggers: Effect.Effect<ReadonlyArray<string>, WorkflowJournalError>;
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
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const pubsub = yield* PubSub.unbounded<StoredFact>();
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
        active_ms: 0,
        open_gates: s.openGates,
        pending_intents: row.pendingIntents,
        last_seq: row.lastSeq,
        parent_run_id: row.parentRunId,
        card_ticket_id: null,
        pull_request_url: s.pullRequest,
        summary_json: summary,
      };
      yield* sql`INSERT INTO workflow_runs ${sql.insert(values)} ON CONFLICT(run_id) DO UPDATE SET ${sql.update(values)} WHERE excluded.last_seq >= workflow_runs.last_seq`;
    }, Effect.mapError(fail)),
    runs: Effect.fn("Journal.runs")(function* (query) {
      const rows = yield* sql<{
        readonly summary_json: string;
      }>`SELECT summary_json FROM workflow_runs
        WHERE summary_json != '' AND (${query.workflowId} IS NULL OR workflow_id = ${query.workflowId})
        AND (${query.status} IS NULL OR status = ${query.status})
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
        WHERE r.summary_json != '' AND NOT EXISTS (SELECT 1 FROM workflow_runs n
          WHERE n.summary_json != '' AND n.workflow_id = r.workflow_id AND
          (n.started_at > r.started_at OR (n.started_at = r.started_at AND n.run_id < r.run_id)))`;
      const summaries = yield* Effect.forEach(rows, decodeSummary);
      return new Map(summaries.map((s) => [s.workflowId, s]));
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
    liveRuns: sql<{
      readonly id: string;
    }>`SELECT substr(stream, 5) AS id FROM workflow_facts f WHERE stream LIKE 'run:%' AND
      ((kind = 'RunStarted' AND (SELECT COUNT(*) FROM workflow_facts e WHERE e.stream = f.stream AND e.kind = 'RunEnded') <= (SELECT COUNT(*) FROM workflow_facts e WHERE e.stream = f.stream AND e.kind = 'RunReopened'))
      OR (kind = 'IntentRecorded' AND NOT EXISTS (SELECT 1 FROM workflow_facts r WHERE r.stream = f.stream AND r.key = 'result:' || f.key)))
      GROUP BY stream ORDER BY id`.pipe(
      Effect.map((rows) => rows.map((row) => row.id)),
      Effect.mapError(fail),
    ),
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
  });
});
export const layer = Layer.effect(Journal, make).pipe(Layer.provide(BotsDb.layer));
/** A journal over a migrated in-memory database. */
export const layerMemory = Layer.effect(Journal, make).pipe(Layer.provide(BotsDb.layerMemory));
/** A journal over the caller's database. */
export const layerFromDb = Layer.effect(Journal, make);
