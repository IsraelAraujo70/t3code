import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Who created and who last saved each view (`owner`, or `bot:<id>` through the kanban tools;
 * earlier views are the owner's), and the bots responsible for every workspace, present and future.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE kanban_views ADD COLUMN created_by TEXT NOT NULL DEFAULT 'owner'`;
  yield* sql`ALTER TABLE kanban_views ADD COLUMN updated_by TEXT NOT NULL DEFAULT 'owner'`;
  yield* sql`
    CREATE TABLE kanban_all_workspace_bots (
      bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE
    )
  `;
});
