import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export interface VersionRow {
  readonly workflow_id: string;
  readonly commit_sha: string;
  readonly revision: string;
  readonly semantic_hash: string;
  readonly source: string;
  readonly definition_json: string;
  readonly author: string;
  readonly created_at: string;
}
export interface IndexRow {
  readonly workflow_id: string;
  readonly path: string;
  readonly head_commit: string | null;
  readonly revision: string | null;
  readonly title: string;
  readonly valid: number;
  readonly dirty: number;
  readonly diagnostics_json: string;
  readonly triggers_json: string;
  readonly scanned_at: string;
}
export const insertVersion = Effect.fn("definitionsStore.insertVersion")(function* (
  row: VersionRow,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO workflow_versions ${sql.insert({ ...row })} ON CONFLICT DO NOTHING`;
});
export const getVersion = Effect.fn("definitionsStore.getVersion")(function* (
  id: string,
  commit: string,
) {
  const sql = yield* SqlClient.SqlClient;
  return (yield* sql<VersionRow>`SELECT * FROM workflow_versions WHERE workflow_id=${id} AND commit_sha=${commit}`)[0];
});
export const findVersionByRevision = Effect.fn("definitionsStore.findVersionByRevision")(function* (
  id: string,
  revision: string,
) {
  const sql = yield* SqlClient.SqlClient;
  return (yield* sql<VersionRow>`SELECT * FROM workflow_versions WHERE workflow_id=${id} AND revision=${revision} LIMIT 1`)[0];
});
export const upsertIndex = Effect.fn("definitionsStore.upsertIndex")(function* (row: IndexRow) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO workflow_index ${sql.insert({ ...row })} ON CONFLICT(workflow_id) DO UPDATE SET ${sql.update({ ...row })}`;
});
export const deleteIndex = Effect.fn("definitionsStore.deleteIndex")(function* (id: string) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DELETE FROM workflow_index WHERE workflow_id=${id}`;
});
export const listIndex = Effect.fn("definitionsStore.listIndex")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<IndexRow>`SELECT * FROM workflow_index ORDER BY workflow_id`;
});
