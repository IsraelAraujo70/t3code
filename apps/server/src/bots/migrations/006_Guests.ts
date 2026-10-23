import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE guests (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT,
      token_created_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE UNIQUE INDEX guests_token_hash_idx ON guests(token_hash) WHERE token_hash IS NOT NULL`;
  yield* sql`
    CREATE TABLE guest_bots (
      bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE,
      guest_id TEXT NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX guest_bots_guest_id_idx ON guest_bots(guest_id)`;
  yield* sql`
    CREATE TABLE guest_push_devices (
      token TEXT PRIMARY KEY,
      guest_id TEXT NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
      label TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX guest_push_devices_guest_id_idx ON guest_push_devices(guest_id)`;
});
