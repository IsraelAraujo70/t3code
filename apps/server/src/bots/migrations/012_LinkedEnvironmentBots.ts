import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The bots the user lets reach linked environments. Its own table, so no bot field the bot tools
 * edit can grant it. Starts empty: no bot reaches another machine until the user turns it on.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE linked_environment_bots (
      bot_id TEXT PRIMARY KEY REFERENCES bots(id) ON DELETE CASCADE
    )
  `;
});
