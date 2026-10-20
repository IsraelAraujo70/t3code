/**
 * Which threads watch which, in `bots.sqlite`. A watch lasts until its watcher removes it, so a
 * thread that runs and stops again wakes its watchers again.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { BotsError, ThreadId } from "@t3tools/contracts";

import * as BotsDb from "../BotsDb.ts";

export interface ThreadWatch {
  readonly watcherThreadId: ThreadId;
  readonly targetThreadId: ThreadId;
  /** ISO time the watch started; runs that finished before it never wake the watcher. */
  readonly createdAt: string;
}

export class ThreadWatchStore extends Context.Service<
  ThreadWatchStore,
  {
    /** Idempotent: watching again keeps the original start time. */
    readonly watch: (watch: ThreadWatch) => Effect.Effect<void, BotsError>;
    /** Idempotent; true when a watch was removed. */
    readonly unwatch: (
      watcherThreadId: ThreadId,
      targetThreadId: ThreadId,
    ) => Effect.Effect<boolean, BotsError>;
    readonly watchersOf: (
      targetThreadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<ThreadWatch>, BotsError>;
    readonly list: Effect.Effect<ReadonlyArray<ThreadWatch>, BotsError>;
  }
>()("t3/bots/threadWatch/ThreadWatchStore") {}

interface Row {
  readonly watcher_thread_id: string;
  readonly target_thread_id: string;
  readonly created_at: string;
}

const toWatch = (row: Row): ThreadWatch => ({
  watcherThreadId: ThreadId.make(row.watcher_thread_id),
  targetThreadId: ThreadId.make(row.target_thread_id),
  createdAt: row.created_at,
});

const failWith = (message: string) => (cause: unknown) => new BotsError({ message, cause });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const select = sql`SELECT watcher_thread_id, target_thread_id, created_at FROM thread_watches`;

  return ThreadWatchStore.of({
    watch: (watch) =>
      sql`
        INSERT INTO thread_watches (watcher_thread_id, target_thread_id, created_at)
        VALUES (${watch.watcherThreadId}, ${watch.targetThreadId}, ${watch.createdAt})
        ON CONFLICT DO NOTHING
      `.pipe(Effect.asVoid, Effect.mapError(failWith("Could not save the thread watch"))),
    unwatch: (watcherThreadId, targetThreadId) =>
      sql<{ readonly watcher_thread_id: string }>`
        DELETE FROM thread_watches
        WHERE watcher_thread_id = ${watcherThreadId} AND target_thread_id = ${targetThreadId}
        RETURNING watcher_thread_id
      `.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(failWith("Could not remove the thread watch")),
      ),
    watchersOf: (targetThreadId) =>
      sql<Row>`${select} WHERE target_thread_id = ${targetThreadId} ORDER BY created_at`.pipe(
        Effect.map((rows) => rows.map(toWatch)),
        Effect.mapError(failWith("Could not read thread watches")),
      ),
    list: sql<Row>`${select} ORDER BY created_at`.pipe(
      Effect.map((rows) => rows.map(toWatch)),
      Effect.mapError(failWith("Could not read thread watches")),
    ),
  });
});

export const layer = Layer.effect(ThreadWatchStore, make).pipe(Layer.provide(BotsDb.layer));

/** Over a migrated in-memory database, for tests. */
export const layerMemory = Layer.effect(ThreadWatchStore, make).pipe(
  Layer.provide(BotsDb.layerMemory),
);
