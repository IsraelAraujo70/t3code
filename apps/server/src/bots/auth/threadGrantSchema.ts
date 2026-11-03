import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

const GRANTED_TABLES = ["auth_sessions", "auth_pairing_links"] as const;

/**
 * Adds the nullable `thread_grant` column to the auth tables when it is missing. It is not a
 * numbered migration: the migrator skips every id up to the highest recorded one, so a fork id
 * would either collide with a future upstream migration or make upstream's next ones never run.
 * Existing rows keep NULL, which means "no grant".
 */
export const ensureThreadGrantColumns = Effect.fn("ensureThreadGrantColumns")(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const table of GRANTED_TABLES) {
    const columns = yield* sql<{ readonly name: string }>`
      SELECT name FROM pragma_table_info(${table})
    `;
    if (columns.length === 0 || columns.some((column) => column.name === "thread_grant")) continue;
    yield* sql.unsafe(`ALTER TABLE ${table} ADD COLUMN thread_grant TEXT`);
  }
});
