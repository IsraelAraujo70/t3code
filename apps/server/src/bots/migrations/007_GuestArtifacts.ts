import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE guest_artifacts (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('image', 'html')),
      name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      height INTEGER,
      size_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX guest_artifacts_thread_idx ON guest_artifacts(thread_id, created_at)`;
  yield* sql`CREATE INDEX guest_artifacts_bot_idx ON guest_artifacts(bot_id, kind, created_at)`;
});
