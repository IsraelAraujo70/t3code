// @effect-diagnostics preferSchemaOverJson:off globalDateInEffect:off - Journal storage explicitly uses encoded JSON and ISO timestamps from Clock.
/**
 * The only writer of workflow facts. Each append is one `BEGIN IMMEDIATE` transaction over every
 * stream in the batch; a fact whose (stream, key) is already stored is not written again, and the
 * caller gets the stored one. One process writes (the bots host), so seq is `MAX(seq) + 1` inside it.
 */
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

export class Journal extends Context.Service<
  Journal,
  {
    /** Results in batch order. An empty batch is a no-op. */
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
    readonly liveRuns: Effect.Effect<ReadonlyArray<string>, WorkflowJournalError>;
    /** Workflow ids with a TriggerFired that has neither RunCreated nor TriggerSkipped. */
    readonly pendingTriggers: Effect.Effect<ReadonlyArray<string>, WorkflowJournalError>;
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
  return Journal.of({
    append: Effect.fn("Journal.append")(function* (batch) {
      if (batch.length === 0) return [];
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const results = yield* sql.withTransaction(
            Effect.gen(function* () {
              const results: AppendResult[] = [];
              for (const item of batch) {
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
    liveRuns: sql<{
      readonly id: string;
    }>`SELECT substr(stream, 5) AS id FROM workflow_facts f WHERE stream LIKE 'run:%' AND
      ((kind = 'RunStarted' AND NOT EXISTS (SELECT 1 FROM workflow_facts e WHERE e.stream = f.stream AND e.kind = 'RunEnded'))
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
    subscribe: PubSub.subscribe(pubsub),
  });
});
export const layer = Layer.effect(Journal, make).pipe(Layer.provide(BotsDb.layer));
/** A journal over a migrated in-memory database. */
export const layerMemory = Layer.effect(Journal, make).pipe(Layer.provide(BotsDb.layerMemory));
/** A journal over the caller's database. */
export const layerFromDb = Layer.effect(Journal, make);
