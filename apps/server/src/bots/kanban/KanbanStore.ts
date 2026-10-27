/**
 * Kanban rows of `bots.sqlite`: Linear accounts (never their keys), project links, the linked
 * teams' workflow states, tickets with their thread links, and each workspace's bots. The store
 * keeps rows only; KanbanService owns every rule about them.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import {
  KanbanError,
  KanbanLocalState,
  KanbanProjectLink,
  LinearAccount,
  LinearWorkflowState,
  ProjectId,
  ThreadId,
  type BotId,
  type KanbanTicket,
  type KanbanTicketId,
  type KanbanWorkspaceId,
  type LinearAccountId,
} from "@t3tools/contracts";

import * as BotsDb from "../BotsDb.ts";

/** A link with the sync bookkeeping clients never see. */
export interface StoredProjectLink extends KanbanProjectLink {
  /** Greatest Linear `updatedAt` synced so far; the next poll asks only for newer issues. */
  readonly syncCursor: string | null;
  readonly lastFullSyncAt: string | null;
}

/** One Linear issue as a sync writes it. */
export interface LinearTicketRow {
  readonly id: KanbanTicketId;
  readonly issueId: string;
  readonly teamId: string;
  readonly url: string;
  readonly identifier: string;
  readonly title: string;
  readonly stateId: string;
  readonly assigneeName: string | null;
  readonly priority: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LocalTicketRow {
  readonly id: KanbanTicketId;
  readonly projectId: ProjectId;
  readonly localNumber: number;
  readonly title: string;
  readonly state: KanbanLocalState;
  readonly createdAt: string;
}

export class KanbanStore extends Context.Service<
  KanbanStore,
  {
    /** Oldest first. */
    readonly listAccounts: Effect.Effect<ReadonlyArray<LinearAccount>, KanbanError>;
    readonly getAccount: (
      id: LinearAccountId,
    ) => Effect.Effect<Option.Option<LinearAccount>, KanbanError>;
    readonly insertAccount: (account: LinearAccount) => Effect.Effect<void, KanbanError>;
    readonly renameAccount: (
      id: LinearAccountId,
      name: string,
      updatedAt: string,
    ) => Effect.Effect<void, KanbanError>;
    /** Its links and synced tickets go with it, by cascade. */
    readonly deleteAccount: (id: LinearAccountId) => Effect.Effect<void, KanbanError>;

    readonly listLinks: Effect.Effect<ReadonlyArray<StoredProjectLink>, KanbanError>;
    readonly getLink: (
      projectId: ProjectId,
    ) => Effect.Effect<Option.Option<StoredProjectLink>, KanbanError>;
    /**
     * Replaces the project's link. When the account, team or Linear project changes, the
     * project's synced tickets are dropped in the same transaction, since they belong to the
     * old scope.
     */
    readonly putLink: (link: StoredProjectLink) => Effect.Effect<void, KanbanError>;
    /** Drops the link and the project's synced tickets; local tickets stay. */
    readonly deleteLink: (projectId: ProjectId) => Effect.Effect<void, KanbanError>;
    readonly recordSync: (
      projectId: ProjectId,
      result:
        | {
            readonly ok: true;
            readonly at: string;
            readonly cursor: string | null;
            readonly full: boolean;
          }
        | { readonly ok: false; readonly at: string; readonly error: string },
    ) => Effect.Effect<void, KanbanError>;

    readonly listStates: Effect.Effect<ReadonlyArray<LinearWorkflowState>, KanbanError>;
    readonly replaceTeamStates: (
      teamId: string,
      states: ReadonlyArray<LinearWorkflowState>,
    ) => Effect.Effect<void, KanbanError>;

    /** Every ticket with its thread links, oldest first. */
    readonly listTickets: Effect.Effect<ReadonlyArray<KanbanTicket>, KanbanError>;
    readonly getTicket: (
      id: KanbanTicketId,
    ) => Effect.Effect<Option.Option<KanbanTicket>, KanbanError>;
    readonly nextLocalNumber: Effect.Effect<number, KanbanError>;
    readonly insertLocalTicket: (row: LocalTicketRow) => Effect.Effect<void, KanbanError>;
    readonly setLocalState: (
      id: KanbanTicketId,
      state: KanbanLocalState,
      updatedAt: string,
    ) => Effect.Effect<void, KanbanError>;
    readonly deleteTicket: (id: KanbanTicketId) => Effect.Effect<void, KanbanError>;
    /**
     * Inserts or refreshes issues of one project's link, matched by issue id; a new issue takes
     * the row id given, an existing one keeps its own.
     */
    readonly upsertLinearTickets: (
      projectId: ProjectId,
      accountId: LinearAccountId,
      rows: ReadonlyArray<LinearTicketRow>,
    ) => Effect.Effect<void, KanbanError>;
    /** Deletes the project's synced tickets for these issue ids. */
    readonly deleteLinearTickets: (
      projectId: ProjectId,
      issueIds: ReadonlyArray<string>,
    ) => Effect.Effect<void, KanbanError>;

    /** Linking twice is a no-op. */
    readonly linkThread: (
      ticketId: KanbanTicketId,
      threadId: ThreadId,
      at: string,
    ) => Effect.Effect<void, KanbanError>;
    readonly unlinkThread: (
      ticketId: KanbanTicketId,
      threadId: ThreadId,
    ) => Effect.Effect<void, KanbanError>;

    readonly listWorkspaceBots: Effect.Effect<
      ReadonlyMap<KanbanWorkspaceId, ReadonlyArray<BotId>>,
      KanbanError
    >;
    readonly setWorkspaceBots: (
      workspaceId: KanbanWorkspaceId,
      botIds: ReadonlyArray<BotId>,
    ) => Effect.Effect<void, KanbanError>;
  }
>()("t3/bots/kanban/KanbanStore") {}

const LinkRow = Schema.Struct({
  ...KanbanProjectLink.fields,
  syncCursor: Schema.NullOr(Schema.String),
  lastFullSyncAt: Schema.NullOr(Schema.String),
});

const TicketRow = Schema.Struct({
  id: Schema.String,
  projectId: ProjectId,
  accountId: Schema.NullOr(Schema.String),
  issueId: Schema.NullOr(Schema.String),
  teamId: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  identifier: Schema.String,
  title: Schema.String,
  localState: Schema.NullOr(KanbanLocalState),
  linearStateId: Schema.NullOr(Schema.String),
  assigneeName: Schema.NullOr(Schema.String),
  priority: Schema.Number,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
type TicketRow = typeof TicketRow.Type;

const ThreadLinkRow = Schema.Struct({ ticketId: Schema.String, threadId: ThreadId });
const WorkspaceBotRow = Schema.Struct({ workspaceId: Schema.String, botId: Schema.String });
const PreviousScopeRow = Schema.Struct({
  accountId: Schema.String,
  teamId: Schema.String,
  linearProjectId: Schema.NullOr(Schema.String),
});
const NextNumberRow = Schema.Struct({ next: Schema.Number });

const decodeAccounts = Schema.decodeUnknownEffect(Schema.Array(LinearAccount));
const decodeLinks = Schema.decodeUnknownEffect(Schema.Array(LinkRow));
const decodeStates = Schema.decodeUnknownEffect(Schema.Array(LinearWorkflowState));
const decodeTickets = Schema.decodeUnknownEffect(Schema.Array(TicketRow));
const decodeThreadLinks = Schema.decodeUnknownEffect(Schema.Array(ThreadLinkRow));
const decodeWorkspaceBots = Schema.decodeUnknownEffect(Schema.Array(WorkspaceBotRow));
const decodePreviousScope = Schema.decodeUnknownEffect(Schema.Array(PreviousScopeRow));
const decodeNextNumber = Schema.decodeUnknownEffect(Schema.Array(NextNumberRow));

const failWith = (message: string) => (cause: unknown) => new KanbanError({ message, cause });

function toTicket(row: TicketRow, threadIds: ReadonlyArray<ThreadId>): KanbanTicket {
  const linear =
    row.issueId !== null && row.accountId !== null && row.teamId !== null
      ? {
          accountId: row.accountId as LinearAccountId,
          issueId: row.issueId,
          teamId: row.teamId,
          url: row.url ?? "",
        }
      : null;
  return {
    id: row.id as KanbanTicketId,
    projectId: row.projectId,
    linear,
    identifier: row.identifier,
    title: row.title,
    status:
      row.localState !== null
        ? { kind: "local", state: row.localState }
        : { kind: "linear", stateId: row.linearStateId ?? "" },
    assigneeName: row.assigneeName,
    priority: Math.max(0, Math.trunc(row.priority)),
    threadIds,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const selectAccounts = sql`
    SELECT
      id,
      name,
      key_last4 AS "keyLast4",
      user_name AS "userName",
      organization_id AS "organizationId",
      organization_name AS "organizationName",
      organization_url_key AS "organizationUrlKey",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM linear_accounts
  `;
  const selectLinks = sql`
    SELECT
      project_id AS "projectId",
      account_id AS "accountId",
      team_id AS "teamId",
      team_key AS "teamKey",
      team_name AS "teamName",
      linear_project_id AS "linearProjectId",
      linear_project_name AS "linearProjectName",
      last_synced_at AS "lastSyncedAt",
      sync_error AS "syncError",
      sync_cursor AS "syncCursor",
      last_full_sync_at AS "lastFullSyncAt",
      created_at AS "createdAt"
    FROM kanban_project_links
  `;
  const selectTickets = sql`
    SELECT
      id,
      project_id AS "projectId",
      account_id AS "accountId",
      issue_id AS "issueId",
      team_id AS "teamId",
      url,
      identifier,
      title,
      local_state AS "localState",
      linear_state_id AS "linearStateId",
      assignee_name AS "assigneeName",
      priority,
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM kanban_tickets
  `;

  const threadIdsByTicket = (ticketId?: KanbanTicketId) =>
    (ticketId === undefined
      ? sql`
          SELECT ticket_id AS "ticketId", thread_id AS "threadId"
          FROM kanban_ticket_threads ORDER BY created_at, thread_id
        `
      : sql`
          SELECT ticket_id AS "ticketId", thread_id AS "threadId"
          FROM kanban_ticket_threads WHERE ticket_id = ${ticketId} ORDER BY created_at, thread_id
        `
    ).pipe(
      Effect.flatMap(decodeThreadLinks),
      Effect.map((rows) => {
        const byTicket = new Map<string, ThreadId[]>();
        for (const row of rows) {
          const list = byTicket.get(row.ticketId);
          if (list === undefined) byTicket.set(row.ticketId, [row.threadId]);
          else list.push(row.threadId);
        }
        return byTicket;
      }),
    );

  const dropSyncedTickets = (projectId: ProjectId) =>
    sql`DELETE FROM kanban_tickets WHERE project_id = ${projectId} AND issue_id IS NOT NULL`;

  return KanbanStore.of({
    listAccounts: sql`${selectAccounts} ORDER BY created_at, id`.pipe(
      Effect.flatMap(decodeAccounts),
      Effect.mapError(failWith("Could not read Linear accounts from bots.sqlite")),
    ),
    getAccount: (id) =>
      sql`${selectAccounts} WHERE id = ${id}`.pipe(
        Effect.flatMap(decodeAccounts),
        Effect.map((rows) => Option.fromNullishOr(rows[0])),
        Effect.mapError(failWith(`Could not read Linear account ${id}`)),
      ),
    insertAccount: (account) =>
      sql`
        INSERT INTO linear_accounts (
          id, name, key_last4, user_name, organization_id, organization_name,
          organization_url_key, created_at, updated_at
        )
        VALUES (
          ${account.id}, ${account.name}, ${account.keyLast4}, ${account.userName},
          ${account.organizationId}, ${account.organizationName}, ${account.organizationUrlKey},
          ${account.createdAt}, ${account.updatedAt}
        )
      `.pipe(Effect.asVoid, Effect.mapError(failWith("Could not save the Linear account"))),
    renameAccount: (id, name, updatedAt) =>
      sql`UPDATE linear_accounts SET name = ${name}, updated_at = ${updatedAt} WHERE id = ${id}`.pipe(
        Effect.asVoid,
        Effect.mapError(failWith(`Could not rename Linear account ${id}`)),
      ),
    deleteAccount: (id) =>
      sql`DELETE FROM linear_accounts WHERE id = ${id}`.pipe(
        Effect.asVoid,
        Effect.mapError(failWith(`Could not delete Linear account ${id}`)),
      ),

    listLinks: sql`${selectLinks} ORDER BY created_at, project_id`.pipe(
      Effect.flatMap(decodeLinks),
      Effect.mapError(failWith("Could not read project links from bots.sqlite")),
    ),
    getLink: (projectId) =>
      sql`${selectLinks} WHERE project_id = ${projectId}`.pipe(
        Effect.flatMap(decodeLinks),
        Effect.map((rows) => Option.fromNullishOr(rows[0])),
        Effect.mapError(failWith(`Could not read the link of project ${projectId}`)),
      ),
    putLink: (link) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const previous = yield* sql`
              SELECT account_id AS "accountId", team_id AS "teamId",
                linear_project_id AS "linearProjectId"
              FROM kanban_project_links WHERE project_id = ${link.projectId}
            `.pipe(Effect.flatMap(decodePreviousScope));
            const old = previous[0];
            const sameScope =
              old !== undefined &&
              old.accountId === link.accountId &&
              old.teamId === link.teamId &&
              old.linearProjectId === link.linearProjectId;
            if (!sameScope) yield* dropSyncedTickets(link.projectId);
            yield* sql`
              INSERT INTO kanban_project_links (
                project_id, account_id, team_id, team_key, team_name, linear_project_id,
                linear_project_name, sync_cursor, last_full_sync_at, last_synced_at, sync_error,
                created_at
              )
              VALUES (
                ${link.projectId}, ${link.accountId}, ${link.teamId}, ${link.teamKey},
                ${link.teamName}, ${link.linearProjectId}, ${link.linearProjectName},
                ${link.syncCursor}, ${link.lastFullSyncAt}, ${link.lastSyncedAt},
                ${link.syncError}, ${link.createdAt}
              )
              ON CONFLICT (project_id) DO UPDATE SET
                account_id = excluded.account_id,
                team_id = excluded.team_id,
                team_key = excluded.team_key,
                team_name = excluded.team_name,
                linear_project_id = excluded.linear_project_id,
                linear_project_name = excluded.linear_project_name,
                sync_cursor = ${sameScope ? sql`kanban_project_links.sync_cursor` : sql`NULL`},
                last_full_sync_at = ${
                  sameScope ? sql`kanban_project_links.last_full_sync_at` : sql`NULL`
                },
                sync_error = NULL
            `;
          }),
        )
        .pipe(Effect.mapError(failWith(`Could not link project ${link.projectId}`))),
    deleteLink: (projectId) =>
      sql
        .withTransaction(
          dropSyncedTickets(projectId).pipe(
            Effect.andThen(sql`DELETE FROM kanban_project_links WHERE project_id = ${projectId}`),
          ),
        )
        .pipe(Effect.asVoid, Effect.mapError(failWith(`Could not unlink project ${projectId}`))),
    recordSync: (projectId, result) =>
      (result.ok
        ? sql`
            UPDATE kanban_project_links
            SET
              last_synced_at = ${result.at},
              sync_error = NULL,
              sync_cursor = COALESCE(${result.cursor}, sync_cursor),
              last_full_sync_at = ${result.full ? result.at : sql`last_full_sync_at`}
            WHERE project_id = ${projectId}
          `
        : sql`
            UPDATE kanban_project_links
            SET last_synced_at = ${result.at}, sync_error = ${result.error}
            WHERE project_id = ${projectId}
          `
      ).pipe(Effect.asVoid, Effect.mapError(failWith("Could not record the sync"))),

    listStates: sql`
      SELECT id, team_id AS "teamId", name, type, position, color
      FROM linear_workflow_states ORDER BY team_id, position, id
    `.pipe(
      Effect.flatMap(decodeStates),
      Effect.mapError(failWith("Could not read workflow states from bots.sqlite")),
    ),
    replaceTeamStates: (teamId, states) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM linear_workflow_states WHERE team_id = ${teamId}`;
            for (const state of states) {
              yield* sql`
                INSERT INTO linear_workflow_states (id, team_id, name, type, position, color)
                VALUES (
                  ${state.id}, ${teamId}, ${state.name}, ${state.type}, ${state.position},
                  ${state.color}
                )
                ON CONFLICT (id) DO UPDATE SET
                  team_id = excluded.team_id,
                  name = excluded.name,
                  type = excluded.type,
                  position = excluded.position,
                  color = excluded.color
              `;
            }
          }),
        )
        .pipe(Effect.mapError(failWith("Could not save workflow states"))),

    listTickets: Effect.all([
      sql`${selectTickets} ORDER BY created_at, id`.pipe(Effect.flatMap(decodeTickets)),
      threadIdsByTicket(),
    ]).pipe(
      Effect.map(([rows, threads]) => rows.map((row) => toTicket(row, threads.get(row.id) ?? []))),
      Effect.mapError(failWith("Could not read tickets from bots.sqlite")),
    ),
    getTicket: (id) =>
      Effect.all([
        sql`${selectTickets} WHERE id = ${id}`.pipe(Effect.flatMap(decodeTickets)),
        threadIdsByTicket(id),
      ]).pipe(
        Effect.map(([rows, threads]) =>
          Option.fromNullishOr(rows[0]).pipe(
            Option.map((row) => toTicket(row, threads.get(row.id) ?? [])),
          ),
        ),
        Effect.mapError(failWith(`Could not read ticket ${id}`)),
      ),
    nextLocalNumber:
      sql`SELECT COALESCE(MAX(local_number), 0) + 1 AS "next" FROM kanban_tickets`.pipe(
        Effect.flatMap(decodeNextNumber),
        Effect.map((rows) => rows[0]?.next ?? 1),
        Effect.mapError(failWith("Could not number the ticket")),
      ),
    insertLocalTicket: (row) =>
      sql`
        INSERT INTO kanban_tickets (
          id, project_id, local_number, identifier, title, local_state, priority, created_at,
          updated_at
        )
        VALUES (
          ${row.id}, ${row.projectId}, ${row.localNumber}, ${`T-${row.localNumber}`},
          ${row.title}, ${row.state}, 0, ${row.createdAt}, ${row.createdAt}
        )
      `.pipe(Effect.asVoid, Effect.mapError(failWith("Could not save the ticket"))),
    setLocalState: (id, state, updatedAt) =>
      sql`
        UPDATE kanban_tickets SET local_state = ${state}, updated_at = ${updatedAt}
        WHERE id = ${id} AND issue_id IS NULL
      `.pipe(Effect.asVoid, Effect.mapError(failWith(`Could not move ticket ${id}`))),
    deleteTicket: (id) =>
      sql`DELETE FROM kanban_tickets WHERE id = ${id}`.pipe(
        Effect.asVoid,
        Effect.mapError(failWith(`Could not delete ticket ${id}`)),
      ),
    upsertLinearTickets: (projectId, accountId, rows) =>
      sql
        .withTransaction(
          Effect.forEach(
            rows,
            (row) => sql`
              INSERT INTO kanban_tickets (
                id, project_id, account_id, issue_id, team_id, url, identifier, title,
                linear_state_id, assignee_name, priority, created_at, updated_at
              )
              VALUES (
                ${row.id}, ${projectId}, ${accountId}, ${row.issueId}, ${row.teamId}, ${row.url},
                ${row.identifier}, ${row.title}, ${row.stateId}, ${row.assigneeName},
                ${row.priority}, ${row.createdAt}, ${row.updatedAt}
              )
              ON CONFLICT (project_id, issue_id) DO UPDATE SET
                account_id = excluded.account_id,
                team_id = excluded.team_id,
                url = excluded.url,
                identifier = excluded.identifier,
                title = excluded.title,
                linear_state_id = excluded.linear_state_id,
                assignee_name = excluded.assignee_name,
                priority = excluded.priority,
                updated_at = excluded.updated_at
            `,
            { discard: true },
          ),
        )
        .pipe(Effect.mapError(failWith("Could not save synced tickets"))),
    deleteLinearTickets: (projectId, issueIds) =>
      issueIds.length === 0
        ? Effect.void
        : sql`
            DELETE FROM kanban_tickets
            WHERE project_id = ${projectId} AND issue_id IN ${sql.in(issueIds)}
          `.pipe(Effect.asVoid, Effect.mapError(failWith("Could not drop synced tickets"))),

    linkThread: (ticketId, threadId, at) =>
      sql`
        INSERT INTO kanban_ticket_threads (ticket_id, thread_id, created_at)
        VALUES (${ticketId}, ${threadId}, ${at})
        ON CONFLICT DO NOTHING
      `.pipe(Effect.asVoid, Effect.mapError(failWith("Could not link the thread"))),
    unlinkThread: (ticketId, threadId) =>
      sql`
        DELETE FROM kanban_ticket_threads WHERE ticket_id = ${ticketId} AND thread_id = ${threadId}
      `.pipe(Effect.asVoid, Effect.mapError(failWith("Could not unlink the thread"))),

    listWorkspaceBots: sql`
      SELECT workspace_id AS "workspaceId", bot_id AS "botId"
      FROM kanban_workspace_bots ORDER BY workspace_id, position
    `.pipe(
      Effect.flatMap(decodeWorkspaceBots),
      Effect.map((rows) => {
        const byWorkspace = new Map<KanbanWorkspaceId, BotId[]>();
        for (const row of rows) {
          const key = row.workspaceId as KanbanWorkspaceId;
          const list = byWorkspace.get(key);
          if (list === undefined) byWorkspace.set(key, [row.botId as BotId]);
          else list.push(row.botId as BotId);
        }
        return byWorkspace;
      }),
      Effect.mapError(failWith("Could not read workspace bots from bots.sqlite")),
    ),
    setWorkspaceBots: (workspaceId, botIds) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM kanban_workspace_bots WHERE workspace_id = ${workspaceId}`;
            for (const [position, botId] of botIds.entries()) {
              yield* sql`
                INSERT INTO kanban_workspace_bots (workspace_id, bot_id, position)
                VALUES (${workspaceId}, ${botId}, ${position})
              `;
            }
          }),
        )
        .pipe(Effect.mapError(failWith("Could not set the workspace's bots"))),
  });
});

/** Over `bots.sqlite` in the server state directory. */
export const layer = Layer.effect(KanbanStore, make).pipe(Layer.provide(BotsDb.layer));

/** A migrated in-memory database, for tests. */
export const layerMemory = Layer.effect(KanbanStore, make).pipe(Layer.provide(BotsDb.layerMemory));

/** Over an existing bots database, for tests that share one with BotsStore. */
export const layerFromDb = Layer.effect(KanbanStore, make);
