import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

export const getCursor = Effect.fn("WorkflowTriggers.getCursor")(function* (source: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    position: string;
  }>`SELECT position FROM workflow_cursors WHERE source=${source}`;
  return Option.fromNullishOr(rows[0]?.position);
});
export const setCursor = Effect.fn("WorkflowTriggers.setCursor")(function* (
  source: string,
  position: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO workflow_cursors (source,position) VALUES (${source},${position}) ON CONFLICT(source) DO UPDATE SET position=excluded.position`;
});
export const deleteCursor = Effect.fn("WorkflowTriggers.deleteCursor")(function* (source: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM workflow_cursors WHERE source=${source}`;
});
