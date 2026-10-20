import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE thread_watches (
      watcher_thread_id TEXT NOT NULL,
      target_thread_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (watcher_thread_id, target_thread_id)
    )
  `;

  yield* sql`CREATE INDEX thread_watches_target_idx ON thread_watches(target_thread_id)`;
});
