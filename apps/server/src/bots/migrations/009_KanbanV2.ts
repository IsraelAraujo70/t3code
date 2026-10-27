import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { KANBAN_SEED_VIEWS, KanbanViewConfig } from "@t3tools/contracts";

const encodeConfig = Schema.encodeSync(Schema.fromJsonString(KanbanViewConfig));

/**
 * Kanban v2: the issue fields cards and filters need, Linear's people, labels, projects,
 * milestones and cycles, saved views, and local comments and history.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE linear_accounts ADD COLUMN user_id TEXT`;
  yield* sql`ALTER TABLE linear_accounts ADD COLUMN user_avatar_url TEXT`;

  // Lists are JSON arrays: label ids, and the GitHub PRs attached to the issue.
  for (const column of [
    sql`ALTER TABLE kanban_tickets ADD COLUMN assignee_id TEXT`,
    sql`ALTER TABLE kanban_tickets ADD COLUMN creator_id TEXT`,
    sql`ALTER TABLE kanban_tickets ADD COLUMN estimate REAL`,
    sql`ALTER TABLE kanban_tickets ADD COLUMN due_date TEXT`,
    sql`ALTER TABLE kanban_tickets ADD COLUMN label_ids TEXT NOT NULL DEFAULT '[]'`,
    sql`ALTER TABLE kanban_tickets ADD COLUMN linear_project_id TEXT`,
    sql`ALTER TABLE kanban_tickets ADD COLUMN milestone_id TEXT`,
    sql`ALTER TABLE kanban_tickets ADD COLUMN cycle_id TEXT`,
    sql`ALTER TABLE kanban_tickets ADD COLUMN parent_issue_id TEXT`,
    sql`ALTER TABLE kanban_tickets ADD COLUMN parent_identifier TEXT`,
    sql`ALTER TABLE kanban_tickets ADD COLUMN parent_title TEXT`,
    sql`ALTER TABLE kanban_tickets ADD COLUMN sub_total INTEGER`,
    sql`ALTER TABLE kanban_tickets ADD COLUMN sub_closed INTEGER`,
    sql`ALTER TABLE kanban_tickets ADD COLUMN pull_requests TEXT NOT NULL DEFAULT '[]'`,
    sql`ALTER TABLE kanban_tickets ADD COLUMN bot_id TEXT REFERENCES bots(id) ON DELETE SET NULL`,
    sql`ALTER TABLE kanban_tickets ADD COLUMN sort_order REAL NOT NULL DEFAULT 0`,
    sql`ALTER TABLE kanban_tickets ADD COLUMN closed_at TEXT`,
    sql`ALTER TABLE kanban_tickets ADD COLUMN auto_closed INTEGER NOT NULL DEFAULT 0`,
    // Local tickets only; a Linear issue's description is read when it opens.
    sql`ALTER TABLE kanban_tickets ADD COLUMN description TEXT`,
  ]) {
    yield* column;
  }
  // Synced tickets lack the new fields until their next full sync: make it the next poll.
  yield* sql`UPDATE kanban_project_links SET last_full_sync_at = NULL`;

  yield* sql`
    CREATE TABLE linear_users (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      name TEXT NOT NULL,
      display_name TEXT NOT NULL,
      avatar_url TEXT,
      active INTEGER NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE kanban_labels (
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      team_id TEXT,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      parent_id TEXT,
      source TEXT NOT NULL CHECK (source IN ('linear', 'local')),
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE linear_projects (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      icon TEXT
    )
  `;
  yield* sql`
    CREATE TABLE linear_milestones (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      sort_order REAL NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE linear_cycles (
      id TEXT PRIMARY KEY,
      team_id TEXT NOT NULL,
      number INTEGER NOT NULL,
      name TEXT,
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE kanban_views (
      id TEXT PRIMARY KEY,
      project_id TEXT,
      name TEXT NOT NULL,
      icon TEXT,
      config TEXT NOT NULL,
      linear_view_id TEXT,
      position INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  const now = "1970-01-01T00:00:00.000Z";
  for (const [position, view] of KANBAN_SEED_VIEWS.entries()) {
    yield* sql`
      INSERT INTO kanban_views (id, project_id, name, icon, config, position, created_at, updated_at)
      VALUES (
        ${view.id}, NULL, ${view.name}, ${view.icon}, ${encodeConfig(view.config)}, ${position},
        ${now}, ${now}
      )
    `;
  }
  yield* sql`
    CREATE TABLE kanban_local_comments (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL REFERENCES kanban_tickets(id) ON DELETE CASCADE,
      author_id TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX kanban_local_comments_ticket_idx ON kanban_local_comments(ticket_id)`;
  // History of local tickets, phrased when written ("moved from Todo to In progress").
  yield* sql`
    CREATE TABLE kanban_ticket_events (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL REFERENCES kanban_tickets(id) ON DELETE CASCADE,
      actor_id TEXT,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`CREATE INDEX kanban_ticket_events_ticket_idx ON kanban_ticket_events(ticket_id)`;
});
