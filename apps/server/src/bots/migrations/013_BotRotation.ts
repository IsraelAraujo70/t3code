import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Each bot's rotation policy (BotRotation), on for every bot at first, and the handoff a bot wrote
 * at the end of each generation, which the next generation's instructions carry.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE bots ADD COLUMN rotation TEXT NOT NULL DEFAULT 'daily'`;
  yield* sql`
    CREATE TABLE bot_handoffs (
      bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
      generation INTEGER NOT NULL CHECK (generation >= 1),
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (bot_id, generation)
    )
  `;
});
