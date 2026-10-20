import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Only the user grants this, in Settings → Bots; existing bots start without it.
  yield* sql`ALTER TABLE bots ADD COLUMN can_manage_bots INTEGER NOT NULL DEFAULT 0`;
});
