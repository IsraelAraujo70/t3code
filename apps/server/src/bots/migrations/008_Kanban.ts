import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The API key itself lives in the server secret store, never in this database.
  yield* sql`
    CREATE TABLE linear_accounts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      key_last4 TEXT NOT NULL,
      user_name TEXT NOT NULL,
      organization_id TEXT NOT NULL,
      organization_name TEXT NOT NULL,
      organization_url_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE kanban_project_links (
      project_id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL REFERENCES linear_accounts(id) ON DELETE CASCADE,
      team_id TEXT NOT NULL,
      team_key TEXT NOT NULL,
      team_name TEXT NOT NULL,
      linear_project_id TEXT,
      linear_project_name TEXT,
      sync_cursor TEXT,
      last_full_sync_at TEXT,
      last_synced_at TEXT,
      sync_error TEXT,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE linear_workflow_states (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      position REAL NOT NULL,
      color TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX linear_workflow_states_team_idx ON linear_workflow_states(team_id)`;
  // A Linear ticket belongs to one project's link: two projects linked to the same team each
  // keep their own row, with their own thread links. Local tickets have no account or issue.
  yield* sql`
    CREATE TABLE kanban_tickets (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      account_id TEXT REFERENCES linear_accounts(id) ON DELETE CASCADE,
      issue_id TEXT,
      team_id TEXT,
      url TEXT,
      local_number INTEGER,
      identifier TEXT NOT NULL,
      title TEXT NOT NULL,
      local_state TEXT CHECK (
        local_state IN ('backlog', 'todo', 'in_progress', 'in_review', 'done')
      ),
      linear_state_id TEXT,
      assignee_name TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK ((issue_id IS NULL) = (local_state IS NOT NULL)),
      UNIQUE (project_id, issue_id)
    )
  `;
  yield* sql`CREATE INDEX kanban_tickets_project_idx ON kanban_tickets(project_id)`;
  yield* sql`
    CREATE TABLE kanban_ticket_threads (
      ticket_id TEXT NOT NULL REFERENCES kanban_tickets(id) ON DELETE CASCADE,
      thread_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (ticket_id, thread_id)
    )
  `;
  yield* sql`
    CREATE TABLE kanban_workspace_bots (
      workspace_id TEXT NOT NULL,
      bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, bot_id)
    )
  `;
});
