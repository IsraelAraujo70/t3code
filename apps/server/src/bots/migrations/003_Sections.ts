import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE sections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      position INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  // Deleting a section sends its bots back to the default list.
  yield* sql`
    ALTER TABLE bots ADD COLUMN section_id TEXT REFERENCES sections(id) ON DELETE SET NULL
  `;

  // Bots get generated faces instead of emojis.
  yield* sql`ALTER TABLE bots DROP COLUMN emoji`;
});
