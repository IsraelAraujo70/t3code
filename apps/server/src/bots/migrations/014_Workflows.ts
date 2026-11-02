import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Workflow journal, version snapshots, projections, and recovery cursors. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE workflow_facts (
  stream TEXT NOT NULL, seq INTEGER NOT NULL, key TEXT NOT NULL, kind TEXT NOT NULL,
  payload_json TEXT NOT NULL, at TEXT NOT NULL,
  PRIMARY KEY (stream, seq), UNIQUE (stream, key)
)`;
  yield* sql`CREATE INDEX workflow_facts_kind ON workflow_facts (kind, stream)`;
  yield* sql`CREATE TABLE workflow_versions (
  workflow_id TEXT NOT NULL, commit_sha TEXT NOT NULL, revision TEXT NOT NULL,   
  semantic_hash TEXT NOT NULL, source TEXT NOT NULL, definition_json TEXT NOT NULL,
  author TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY (workflow_id, commit_sha)
)`;
  yield* sql`CREATE INDEX workflow_versions_hash ON workflow_versions (semantic_hash)`;
  yield* sql`CREATE TABLE workflow_index (workflow_id TEXT PRIMARY KEY, path TEXT NOT NULL, head_commit TEXT, revision TEXT,
  title TEXT NOT NULL, valid INTEGER NOT NULL, dirty INTEGER NOT NULL, diagnostics_json TEXT NOT NULL,
  triggers_json TEXT NOT NULL, scanned_at TEXT NOT NULL)`;
  yield* sql`CREATE TABLE workflow_runs (run_id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL, commit_sha TEXT NOT NULL, hash TEXT NOT NULL,
  status TEXT NOT NULL, trigger_kind TEXT NOT NULL, started_at TEXT NOT NULL, ended_at TEXT, output_status TEXT,
  steps_used INTEGER NOT NULL, tokens_billable INTEGER NOT NULL, tokens_cache_read INTEGER NOT NULL,
  tokens_reserved INTEGER NOT NULL, usd_estimate REAL, active_ms INTEGER NOT NULL, open_gates INTEGER NOT NULL,
  pending_intents INTEGER NOT NULL, last_seq INTEGER NOT NULL, parent_run_id TEXT, card_ticket_id TEXT,
  pull_request_url TEXT)`;
  yield* sql`CREATE INDEX workflow_runs_live ON workflow_runs (status, pending_intents)`;
  yield* sql`CREATE INDEX workflow_runs_by_workflow ON workflow_runs (workflow_id, started_at DESC)`;
  yield* sql`CREATE TABLE workflow_step_threads (thread_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_key TEXT NOT NULL, attempt INTEGER NOT NULL)`;
  yield* sql`CREATE TABLE workflow_cursors (source TEXT PRIMARY KEY, position TEXT NOT NULL)`;
});
