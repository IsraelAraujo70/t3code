import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Local tickets got `closed_at` only from this release; a done one closed no later than its last edit.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE kanban_tickets SET closed_at = updated_at
    WHERE issue_id IS NULL AND local_state = 'done' AND closed_at IS NULL
  `;
});
