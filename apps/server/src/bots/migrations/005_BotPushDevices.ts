import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // FCM tokens of the phones that get a push when a bot replies or waits on the user.
  yield* sql`
    CREATE TABLE bot_push_devices (
      token TEXT PRIMARY KEY,
      label TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
});
