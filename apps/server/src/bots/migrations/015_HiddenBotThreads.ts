import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Side threads the user keeps out of the sidebars. A row of its own, not a thread column, so the
 * thread itself (messages, turns, subscriptions) never learns it is hidden.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE hidden_bot_threads (
      thread_id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE
    )
  `;
});
