import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE bots (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      emoji TEXT NOT NULL,
      role TEXT NOT NULL,
      model_json TEXT NOT NULL,
      home_generation INTEGER NOT NULL CHECK (home_generation >= 1),
      position INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE TABLE memories (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('user', 'bot', 'import')),
      enabled INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (bot_id, text)
    )
  `;

  yield* sql`CREATE INDEX memories_bot_id_idx ON memories(bot_id)`;

  yield* sql`
    CREATE TABLE owner_profile (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      about_me TEXT NOT NULL
    )
  `;
});
