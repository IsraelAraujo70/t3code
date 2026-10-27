/**
 * Kanban rows of `bots.sqlite`: Linear accounts (never their keys), project links, the linked
 * teams' workflow states and cycles, each organization's people, labels, projects and milestones,
 * local labels, tickets with their thread links, local comments and history, saved views, and
 * each workspace's bots. The store keeps rows only; KanbanService owns every rule about them.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import {
  BotId,
  KANBAN_DEFAULT_VIEW_CONFIG,
  KanbanCycle,
  KanbanError,
  KanbanLabel,
  KanbanLinearProject,
  KanbanLocalState,
  KanbanMilestone,
  KanbanPerson,
  KanbanProjectLink,
  KanbanPullRequestRef,
  KanbanTicketId,
  KanbanView,
  KanbanViewConfig,
  KanbanViewId,
  LinearAccount,
  LinearWorkflowState,
  ProjectId,
  ThreadId,
  type KanbanTicket,
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

/** One Linear issue as a sync writes it: every synced field, none of the T3-only ones. */
export interface LinearTicketRow {
  readonly id: KanbanTicketId;
  readonly issueId: string;
  readonly teamId: string;
  readonly url: string;
  readonly identifier: string;
  readonly title: string;
  readonly stateId: string;
  readonly assigneeId: string | null;
  readonly assigneeName: string | null;
  readonly creatorId: string | null;
  readonly priority: number;
  readonly estimate: number | null;
  readonly dueDate: string | null;
  readonly labelIds: ReadonlyArray<string>;
  readonly linearProjectId: string | null;
  readonly milestoneId: string | null;
  readonly cycleId: string | null;
  readonly parent: KanbanTicket["parent"];
  readonly subIssues: KanbanTicket["subIssues"];
  readonly pullRequests: ReadonlyArray<KanbanPullRequestRef>;
  readonly sortOrder: number;
  readonly closedAt: string | null;
  readonly autoClosed: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LocalTicketRow {
  readonly id: KanbanTicketId;
  readonly projectId: ProjectId;
  readonly localNumber: number;
  readonly title: string;
  readonly state: KanbanLocalState;
  readonly priority: number;
  readonly assigneeId: string | null;
  readonly creatorId: string | null;
  readonly labelIds: ReadonlyArray<string>;
  readonly description: string | null;
  readonly sortOrder: number;
  readonly createdAt: string;
}

/** A local ticket's editable fields: an absent key keeps its value, null clears it. */
export interface LocalTicketFields {
  readonly title?: string;
  readonly description?: string | null;
  readonly priority?: number;
  readonly assigneeId?: string | null;
  readonly labelIds?: ReadonlyArray<string>;
  readonly dueDate?: string | null;
  readonly updatedAt: string;
}

export interface LocalCommentRow {
  readonly id: string;
  readonly ticketId: KanbanTicketId;
  readonly authorId: string;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One line of a local ticket's history, phrased when written. */
export interface TicketEventRow {
  readonly id: string;
  readonly ticketId: KanbanTicketId;
  readonly actorId: string | null;
  readonly text: string;
  readonly createdAt: string;
}

/** What a full sync caches of one Linear organization. */
export interface OrganizationCatalog {
  readonly people: ReadonlyArray<KanbanPerson>;
  /** Source `linear`. */
  readonly labels: ReadonlyArray<KanbanLabel>;
  readonly projects: ReadonlyArray<KanbanLinearProject>;
  /** Linear's `sortOrder` orders a project's milestones. */
  readonly milestones: ReadonlyArray<KanbanMilestone & { readonly sortOrder: number }>;
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
    /** Records the Linear user the key belongs to; `updated_at` stays. */
    readonly setAccountUser: (
      id: LinearAccountId,
      userId: string | null,
      avatarUrl: string | null,
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
    /** By team, then number. */
    readonly listCycles: Effect.Effect<ReadonlyArray<KanbanCycle>, KanbanError>;
    readonly replaceTeamCycles: (
      teamId: string,
      cycles: ReadonlyArray<KanbanCycle>,
    ) => Effect.Effect<void, KanbanError>;

    /**
     * In one transaction, replaces the organization's people, projects and milestones, and the
     * Linear labels of `workspaceId`. Milestones whose project is gone go too. Local labels and
     * other organizations stay.
     */
    readonly replaceOrganizationCatalog: (
      organizationId: string,
      workspaceId: KanbanWorkspaceId,
      catalog: OrganizationCatalog,
    ) => Effect.Effect<void, KanbanError>;
    /** By name. */
    readonly listPeople: Effect.Effect<ReadonlyArray<KanbanPerson>, KanbanError>;
    /** Linear labels by name, then local labels by name. */
    readonly listLabels: Effect.Effect<ReadonlyArray<KanbanLabel>, KanbanError>;
    /** By name. */
    readonly listLinearProjects: Effect.Effect<ReadonlyArray<KanbanLinearProject>, KanbanError>;
    /** By project, then Linear's sort order. */
    readonly listMilestones: Effect.Effect<ReadonlyArray<KanbanMilestone>, KanbanError>;
    readonly insertLocalLabel: (
      label: KanbanLabel,
      createdAt: string,
    ) => Effect.Effect<void, KanbanError>;
    /**
     * Deletes a local label (a Linear label id is a no-op) and, in the same transaction, drops
     * its id from every local ticket's labels.
     */
    readonly deleteLocalLabel: (id: string) => Effect.Effect<void, KanbanError>;

    /** Every ticket with its thread links, oldest first. */
    readonly listTickets: Effect.Effect<ReadonlyArray<KanbanTicket>, KanbanError>;
    readonly getTicket: (
      id: KanbanTicketId,
    ) => Effect.Effect<Option.Option<KanbanTicket>, KanbanError>;
    readonly nextLocalNumber: Effect.Effect<number, KanbanError>;
    readonly insertLocalTicket: (row: LocalTicketRow) => Effect.Effect<void, KanbanError>;
    /** A no-op on a Linear ticket. */
    readonly updateLocalTicket: (
      id: KanbanTicketId,
      fields: LocalTicketFields,
    ) => Effect.Effect<void, KanbanError>;
    /** Entering `done` stamps `closed_at` and leaving it clears it; a no-op on a Linear ticket. */
    readonly setLocalState: (
      id: KanbanTicketId,
      state: KanbanLocalState,
      updatedAt: string,
    ) => Effect.Effect<void, KanbanError>;
    /**
     * Sets or clears the owning bot of any ticket. `updatedAt` moves a local ticket's
     * `updated_at`; a Linear ticket keeps Linear's.
     */
    readonly setTicketBot: (
      id: KanbanTicketId,
      botId: BotId | null,
      updatedAt?: string,
    ) => Effect.Effect<void, KanbanError>;
    /** None for a Linear ticket, a missing one, or a local ticket without a description. */
    readonly getLocalDescription: (
      id: KanbanTicketId,
    ) => Effect.Effect<Option.Option<string>, KanbanError>;
    /** Its thread links, local comments and history go with it, by cascade. */
    readonly deleteTicket: (id: KanbanTicketId) => Effect.Effect<void, KanbanError>;
    /**
     * Inserts or refreshes issues of one project's link, matched by issue id; a new issue takes
     * the row id given, an existing one keeps its own. `bot_id` and `description` are never
     * written, so T3-only fields survive every sync.
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

    /** Oldest first. */
    readonly listLocalComments: (
      ticketId: KanbanTicketId,
    ) => Effect.Effect<ReadonlyArray<LocalCommentRow>, KanbanError>;
    readonly insertLocalComment: (row: LocalCommentRow) => Effect.Effect<void, KanbanError>;
    /** True when the ticket had that comment. */
    readonly deleteLocalComment: (
      ticketId: KanbanTicketId,
      commentId: string,
    ) => Effect.Effect<boolean, KanbanError>;
    /** Oldest first. */
    readonly listTicketEvents: (
      ticketId: KanbanTicketId,
    ) => Effect.Effect<ReadonlyArray<TicketEventRow>, KanbanError>;
    readonly insertTicketEvent: (row: TicketEventRow) => Effect.Effect<void, KanbanError>;

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

    /**
     * By position. A view whose stored config no longer decodes comes back with
     * `KANBAN_DEFAULT_VIEW_CONFIG` instead of failing the list.
     */
    readonly listViews: Effect.Effect<ReadonlyArray<KanbanView>, KanbanError>;
    /** Config falls back as in `listViews`. */
    readonly getView: (id: KanbanViewId) => Effect.Effect<Option.Option<KanbanView>, KanbanError>;
    /** The view imported from this Linear custom view, if any. */
    readonly findViewByLinearId: (
      linearViewId: string,
    ) => Effect.Effect<Option.Option<KanbanView>, KanbanError>;
    /** Appends it after the last view. */
    readonly insertView: (view: KanbanView) => Effect.Effect<void, KanbanError>;
    /**
     * Writes every field but the position and `createdBy`. With `onBoard`, only while the view is
     * still on that board (null: every board). False when no row matched.
     */
    readonly updateView: (
      view: KanbanView,
      onBoard?: ProjectId | null,
    ) => Effect.Effect<boolean, KanbanError>;
    /** `onBoard` as in `updateView`. False when no row matched. */
    readonly deleteView: (
      id: KanbanViewId,
      onBoard?: ProjectId | null,
    ) => Effect.Effect<boolean, KanbanError>;
    /**
     * The given views take positions 0..n-1 in that order; the others follow in their current
     * relative order. Unknown ids are ignored.
     */
    readonly reorderViews: (ids: ReadonlyArray<KanbanViewId>) => Effect.Effect<void, KanbanError>;

    readonly listWorkspaceBots: Effect.Effect<
      ReadonlyMap<KanbanWorkspaceId, ReadonlyArray<BotId>>,
      KanbanError
    >;
    readonly setWorkspaceBots: (
      workspaceId: KanbanWorkspaceId,
      botIds: ReadonlyArray<BotId>,
    ) => Effect.Effect<void, KanbanError>;
    /** Bots responsible for every workspace, in the order they were turned on. */
    readonly listAllWorkspacesBots: Effect.Effect<ReadonlyArray<BotId>, KanbanError>;
    readonly setBotAllWorkspaces: (
      botId: BotId,
      allWorkspaces: boolean,
    ) => Effect.Effect<void, KanbanError>;
  }
>()("t3/bots/kanban/KanbanStore") {}

const LabelIdsJson = Schema.fromJsonString(Schema.Array(Schema.String));
const PullRequestsJson = Schema.fromJsonString(Schema.Array(KanbanPullRequestRef));
const ViewConfigJson = Schema.fromJsonString(KanbanViewConfig);
const encodeLabelIds = Schema.encodeSync(LabelIdsJson);
const decodeLabelIds = Schema.decodeUnknownOption(LabelIdsJson);
const encodePullRequests = Schema.encodeSync(PullRequestsJson);
const decodePullRequests = Schema.decodeUnknownOption(PullRequestsJson);
const encodeViewConfig = Schema.encodeSync(ViewConfigJson);
const decodeViewConfig = Schema.decodeUnknownOption(ViewConfigJson);

/** Linear labels carry no creation time of their own. */
const SYNCED_LABEL_CREATED_AT = "1970-01-01T00:00:00.000Z";

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
  assigneeId: Schema.NullOr(Schema.String),
  assigneeName: Schema.NullOr(Schema.String),
  creatorId: Schema.NullOr(Schema.String),
  priority: Schema.Number,
  estimate: Schema.NullOr(Schema.Number),
  dueDate: Schema.NullOr(Schema.String),
  labelIds: Schema.String,
  linearProjectId: Schema.NullOr(Schema.String),
  milestoneId: Schema.NullOr(Schema.String),
  cycleId: Schema.NullOr(Schema.String),
  parentIssueId: Schema.NullOr(Schema.String),
  parentIdentifier: Schema.NullOr(Schema.String),
  parentTitle: Schema.NullOr(Schema.String),
  subTotal: Schema.NullOr(Schema.Number),
  subClosed: Schema.NullOr(Schema.Number),
  pullRequests: Schema.String,
  botId: Schema.NullOr(Schema.String),
  sortOrder: Schema.Number,
  closedAt: Schema.NullOr(Schema.String),
  autoClosed: Schema.Number,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
type TicketRow = typeof TicketRow.Type;

const PersonRow = Schema.Struct({ ...KanbanPerson.fields, active: Schema.Number });
const ViewRow = Schema.Struct({ ...KanbanView.fields, config: Schema.String });
const ViewIdRow = Schema.Struct({ id: KanbanViewId });
const LocalCommentRow = Schema.Struct({
  id: Schema.String,
  ticketId: KanbanTicketId,
  authorId: Schema.String,
  body: Schema.String,
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
const TicketEventRow = Schema.Struct({
  id: Schema.String,
  ticketId: KanbanTicketId,
  actorId: Schema.NullOr(Schema.String),
  text: Schema.String,
  createdAt: Schema.String,
});
const DescriptionRow = Schema.Struct({ description: Schema.NullOr(Schema.String) });
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
const decodeCycles = Schema.decodeUnknownEffect(Schema.Array(KanbanCycle));
const decodePeople = Schema.decodeUnknownEffect(Schema.Array(PersonRow));
const decodeLabels = Schema.decodeUnknownEffect(Schema.Array(KanbanLabel));
const decodeLinearProjects = Schema.decodeUnknownEffect(Schema.Array(KanbanLinearProject));
const decodeMilestones = Schema.decodeUnknownEffect(Schema.Array(KanbanMilestone));
const decodeTickets = Schema.decodeUnknownEffect(Schema.Array(TicketRow));
const decodeDescriptions = Schema.decodeUnknownEffect(Schema.Array(DescriptionRow));
const decodeComments = Schema.decodeUnknownEffect(Schema.Array(LocalCommentRow));
const decodeEvents = Schema.decodeUnknownEffect(Schema.Array(TicketEventRow));
const decodeViews = Schema.decodeUnknownEffect(Schema.Array(ViewRow));
const decodeViewIds = Schema.decodeUnknownEffect(Schema.Array(ViewIdRow));
const decodeThreadLinks = Schema.decodeUnknownEffect(Schema.Array(ThreadLinkRow));
const decodeWorkspaceBots = Schema.decodeUnknownEffect(Schema.Array(WorkspaceBotRow));
const decodeBotIds = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ botId: BotId })));
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
    assigneeId: row.assigneeId,
    assigneeName: row.assigneeName,
    creatorId: row.creatorId,
    priority: Math.max(0, Math.trunc(row.priority)),
    estimate: row.estimate,
    dueDate: row.dueDate,
    labelIds: Option.getOrElse(decodeLabelIds(row.labelIds), () => []),
    linearProjectId: row.linearProjectId,
    milestoneId: row.milestoneId,
    cycleId: row.cycleId,
    parent:
      row.parentIssueId !== null && row.parentIdentifier !== null && row.parentTitle !== null
        ? { issueId: row.parentIssueId, identifier: row.parentIdentifier, title: row.parentTitle }
        : null,
    subIssues:
      row.subTotal === null || row.subTotal === 0
        ? null
        : { total: row.subTotal, closed: row.subClosed ?? 0 },
    pullRequests: Option.getOrElse(decodePullRequests(row.pullRequests), () => []),
    botId: row.botId as BotId | null,
    sortOrder: row.sortOrder,
    closedAt: row.closedAt,
    autoClosed: row.autoClosed === 1,
    threadIds,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const toView = (row: typeof ViewRow.Type): KanbanView => ({
  ...row,
  config: Option.getOrElse(decodeViewConfig(row.config), () => KANBAN_DEFAULT_VIEW_CONFIG),
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const selectAccounts = sql`
    SELECT
      id,
      name,
      key_last4 AS "keyLast4",
      user_name AS "userName",
      user_id AS "userId",
      user_avatar_url AS "userAvatarUrl",
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
      assignee_id AS "assigneeId",
      assignee_name AS "assigneeName",
      creator_id AS "creatorId",
      priority,
      estimate,
      due_date AS "dueDate",
      label_ids AS "labelIds",
      linear_project_id AS "linearProjectId",
      milestone_id AS "milestoneId",
      cycle_id AS "cycleId",
      parent_issue_id AS "parentIssueId",
      parent_identifier AS "parentIdentifier",
      parent_title AS "parentTitle",
      sub_total AS "subTotal",
      sub_closed AS "subClosed",
      pull_requests AS "pullRequests",
      bot_id AS "botId",
      sort_order AS "sortOrder",
      closed_at AS "closedAt",
      auto_closed AS "autoClosed",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM kanban_tickets
  `;
  // `IS` matches a null project (every board) too.
  const onBoardClause = (onBoard: ProjectId | null | undefined) =>
    onBoard === undefined ? sql`` : sql`AND project_id IS ${onBoard}`;
  const selectViews = sql`
    SELECT
      id,
      project_id AS "projectId",
      name,
      icon,
      config,
      linear_view_id AS "linearViewId",
      created_by AS "createdBy",
      updated_by AS "updatedBy",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM kanban_views
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
    getAccount: Effect.fn("KanbanStore.getAccount")((id) =>
      sql`${selectAccounts} WHERE id = ${id}`.pipe(
        Effect.flatMap(decodeAccounts),
        Effect.map((rows) => Option.fromNullishOr(rows[0])),
        Effect.mapError(failWith(`Could not read Linear account ${id}`)),
      ),
    ),
    insertAccount: Effect.fn("KanbanStore.insertAccount")((account) =>
      sql`
        INSERT INTO linear_accounts (
          id, name, key_last4, user_name, user_id, user_avatar_url, organization_id,
          organization_name, organization_url_key, created_at, updated_at
        )
        VALUES (
          ${account.id}, ${account.name}, ${account.keyLast4}, ${account.userName},
          ${account.userId}, ${account.userAvatarUrl}, ${account.organizationId},
          ${account.organizationName}, ${account.organizationUrlKey}, ${account.createdAt},
          ${account.updatedAt}
        )
      `.pipe(Effect.asVoid, Effect.mapError(failWith("Could not save the Linear account"))),
    ),
    renameAccount: Effect.fn("KanbanStore.renameAccount")((id, name, updatedAt) =>
      sql`UPDATE linear_accounts SET name = ${name}, updated_at = ${updatedAt} WHERE id = ${id}`.pipe(
        Effect.asVoid,
        Effect.mapError(failWith(`Could not rename Linear account ${id}`)),
      ),
    ),
    setAccountUser: Effect.fn("KanbanStore.setAccountUser")((id, userId, avatarUrl) =>
      sql`
        UPDATE linear_accounts SET user_id = ${userId}, user_avatar_url = ${avatarUrl}
        WHERE id = ${id}
      `.pipe(
        Effect.asVoid,
        Effect.mapError(failWith(`Could not save the user of Linear account ${id}`)),
      ),
    ),
    deleteAccount: Effect.fn("KanbanStore.deleteAccount")((id) =>
      sql`DELETE FROM linear_accounts WHERE id = ${id}`.pipe(
        Effect.asVoid,
        Effect.mapError(failWith(`Could not delete Linear account ${id}`)),
      ),
    ),

    listLinks: sql`${selectLinks} ORDER BY created_at, project_id`.pipe(
      Effect.flatMap(decodeLinks),
      Effect.mapError(failWith("Could not read project links from bots.sqlite")),
    ),
    getLink: Effect.fn("KanbanStore.getLink")((projectId) =>
      sql`${selectLinks} WHERE project_id = ${projectId}`.pipe(
        Effect.flatMap(decodeLinks),
        Effect.map((rows) => Option.fromNullishOr(rows[0])),
        Effect.mapError(failWith(`Could not read the link of project ${projectId}`)),
      ),
    ),
    putLink: Effect.fn("KanbanStore.putLink")((link) =>
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
    ),
    deleteLink: Effect.fn("KanbanStore.deleteLink")((projectId) =>
      sql
        .withTransaction(
          dropSyncedTickets(projectId).pipe(
            Effect.andThen(sql`DELETE FROM kanban_project_links WHERE project_id = ${projectId}`),
          ),
        )
        .pipe(Effect.asVoid, Effect.mapError(failWith(`Could not unlink project ${projectId}`))),
    ),
    recordSync: Effect.fn("KanbanStore.recordSync")((projectId, result) =>
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
    ),

    listStates: sql`
      SELECT id, team_id AS "teamId", name, type, position, color
      FROM linear_workflow_states ORDER BY team_id, position, id
    `.pipe(
      Effect.flatMap(decodeStates),
      Effect.mapError(failWith("Could not read workflow states from bots.sqlite")),
    ),
    replaceTeamStates: Effect.fn("KanbanStore.replaceTeamStates")((teamId, states) =>
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
    ),
    listCycles: sql`
      SELECT id, team_id AS "teamId", number, name, starts_at AS "startsAt", ends_at AS "endsAt"
      FROM linear_cycles ORDER BY team_id, number, id
    `.pipe(
      Effect.flatMap(decodeCycles),
      Effect.mapError(failWith("Could not read cycles from bots.sqlite")),
    ),
    replaceTeamCycles: Effect.fn("KanbanStore.replaceTeamCycles")((teamId, cycles) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* sql`DELETE FROM linear_cycles WHERE team_id = ${teamId}`;
            for (const cycle of cycles) {
              yield* sql`
                INSERT INTO linear_cycles (id, team_id, number, name, starts_at, ends_at)
                VALUES (
                  ${cycle.id}, ${teamId}, ${cycle.number}, ${cycle.name}, ${cycle.startsAt},
                  ${cycle.endsAt}
                )
                ON CONFLICT (id) DO UPDATE SET
                  team_id = excluded.team_id,
                  number = excluded.number,
                  name = excluded.name,
                  starts_at = excluded.starts_at,
                  ends_at = excluded.ends_at
              `;
            }
          }),
        )
        .pipe(Effect.mapError(failWith("Could not save cycles"))),
    ),

    replaceOrganizationCatalog: Effect.fn("KanbanStore.replaceOrganizationCatalog")(
      (organizationId, workspaceId, catalog) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`DELETE FROM linear_users WHERE organization_id = ${organizationId}`;
              for (const person of catalog.people) {
                yield* sql`
                  INSERT INTO linear_users (
                    id, organization_id, name, display_name, avatar_url, active
                  )
                  VALUES (
                    ${person.id}, ${organizationId}, ${person.name}, ${person.displayName},
                    ${person.avatarUrl}, ${person.active ? 1 : 0}
                  )
                `;
              }
              yield* sql`
                DELETE FROM kanban_labels WHERE source = 'linear' AND workspace_id = ${workspaceId}
              `;
              for (const label of catalog.labels) {
                yield* sql`
                  INSERT INTO kanban_labels (
                    id, workspace_id, team_id, name, color, parent_id, source, created_at
                  )
                  VALUES (
                    ${label.id}, ${workspaceId}, ${label.teamId}, ${label.name}, ${label.color},
                    ${label.parentId}, 'linear', ${SYNCED_LABEL_CREATED_AT}
                  )
                `;
              }
              yield* sql`
                DELETE FROM linear_milestones WHERE project_id IN (
                  SELECT id FROM linear_projects WHERE organization_id = ${organizationId}
                )
              `;
              yield* sql`DELETE FROM linear_projects WHERE organization_id = ${organizationId}`;
              for (const project of catalog.projects) {
                yield* sql`
                  INSERT INTO linear_projects (id, organization_id, name, color, icon)
                  VALUES (
                    ${project.id}, ${organizationId}, ${project.name}, ${project.color},
                    ${project.icon}
                  )
                `;
              }
              for (const milestone of catalog.milestones) {
                yield* sql`
                  INSERT INTO linear_milestones (id, project_id, name, sort_order)
                  VALUES (
                    ${milestone.id}, ${milestone.projectId}, ${milestone.name},
                    ${milestone.sortOrder}
                  )
                `;
              }
              yield* sql`
                DELETE FROM linear_milestones
                WHERE project_id NOT IN (SELECT id FROM linear_projects)
              `;
            }),
          )
          .pipe(
            Effect.mapError(
              failWith(`Could not save the catalog of Linear organization ${organizationId}`),
            ),
          ),
    ),
    listPeople: sql`
      SELECT
        id,
        organization_id AS "organizationId",
        name,
        display_name AS "displayName",
        avatar_url AS "avatarUrl",
        active
      FROM linear_users ORDER BY name, id
    `.pipe(
      Effect.flatMap(decodePeople),
      Effect.map((rows) => rows.map((row) => ({ ...row, active: row.active === 1 }))),
      Effect.mapError(failWith("Could not read Linear people from bots.sqlite")),
    ),
    listLabels: sql`
      SELECT
        id,
        workspace_id AS "workspaceId",
        team_id AS "teamId",
        name,
        color,
        parent_id AS "parentId",
        source
      FROM kanban_labels ORDER BY source = 'local', name, id
    `.pipe(
      Effect.flatMap(decodeLabels),
      Effect.mapError(failWith("Could not read labels from bots.sqlite")),
    ),
    listLinearProjects: sql`
      SELECT id, organization_id AS "organizationId", name, color, icon
      FROM linear_projects ORDER BY name, id
    `.pipe(
      Effect.flatMap(decodeLinearProjects),
      Effect.mapError(failWith("Could not read Linear projects from bots.sqlite")),
    ),
    listMilestones: sql`
      SELECT id, project_id AS "projectId", name
      FROM linear_milestones ORDER BY project_id, sort_order, id
    `.pipe(
      Effect.flatMap(decodeMilestones),
      Effect.mapError(failWith("Could not read milestones from bots.sqlite")),
    ),
    insertLocalLabel: Effect.fn("KanbanStore.insertLocalLabel")((label, createdAt) =>
      sql`
        INSERT INTO kanban_labels (
          id, workspace_id, team_id, name, color, parent_id, source, created_at
        )
        VALUES (
          ${label.id}, ${label.workspaceId}, ${label.teamId}, ${label.name}, ${label.color},
          ${label.parentId}, 'local', ${createdAt}
        )
      `.pipe(Effect.asVoid, Effect.mapError(failWith("Could not save the label"))),
    ),
    deleteLocalLabel: Effect.fn("KanbanStore.deleteLocalLabel")((id) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const deleted = yield* sql`
              DELETE FROM kanban_labels WHERE id = ${id} AND source = 'local' RETURNING id
            `;
            if (deleted.length === 0) return;
            yield* sql`
              UPDATE kanban_tickets
              SET label_ids = (
                SELECT json_group_array(value) FROM json_each(kanban_tickets.label_ids)
                WHERE value <> ${id}
              )
              WHERE issue_id IS NULL
                AND EXISTS (SELECT 1 FROM json_each(kanban_tickets.label_ids) WHERE value = ${id})
            `;
          }),
        )
        .pipe(Effect.mapError(failWith(`Could not delete label ${id}`))),
    ),

    listTickets: Effect.all([
      sql`${selectTickets} ORDER BY created_at, id`.pipe(Effect.flatMap(decodeTickets)),
      threadIdsByTicket(),
    ]).pipe(
      Effect.map(([rows, threads]) => rows.map((row) => toTicket(row, threads.get(row.id) ?? []))),
      Effect.mapError(failWith("Could not read tickets from bots.sqlite")),
    ),
    getTicket: Effect.fn("KanbanStore.getTicket")((id) =>
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
    ),
    nextLocalNumber:
      sql`SELECT COALESCE(MAX(local_number), 0) + 1 AS "next" FROM kanban_tickets`.pipe(
        Effect.flatMap(decodeNextNumber),
        Effect.map((rows) => rows[0]?.next ?? 1),
        Effect.mapError(failWith("Could not number the ticket")),
      ),
    insertLocalTicket: Effect.fn("KanbanStore.insertLocalTicket")((row) =>
      sql`
        INSERT INTO kanban_tickets (
          id, project_id, local_number, identifier, title, local_state, priority, assignee_id,
          creator_id, label_ids, description, sort_order, closed_at, created_at, updated_at
        )
        VALUES (
          ${row.id}, ${row.projectId}, ${row.localNumber}, ${`T-${row.localNumber}`},
          ${row.title}, ${row.state}, ${row.priority}, ${row.assigneeId}, ${row.creatorId},
          ${encodeLabelIds(row.labelIds)}, ${row.description}, ${row.sortOrder},
          ${row.state === "done" ? row.createdAt : null}, ${row.createdAt}, ${row.createdAt}
        )
      `.pipe(Effect.asVoid, Effect.mapError(failWith("Could not save the ticket"))),
    ),
    updateLocalTicket: Effect.fn("KanbanStore.updateLocalTicket")((id, fields) => {
      const columns = Object.fromEntries(
        Object.entries({
          title: fields.title,
          description: fields.description,
          priority: fields.priority,
          assignee_id: fields.assigneeId,
          label_ids: fields.labelIds === undefined ? undefined : encodeLabelIds(fields.labelIds),
          due_date: fields.dueDate,
          updated_at: fields.updatedAt,
        }).filter(([, value]) => value !== undefined),
      );
      return sql`
        UPDATE kanban_tickets SET ${sql.update(columns)} WHERE id = ${id} AND issue_id IS NULL
      `.pipe(Effect.asVoid, Effect.mapError(failWith(`Could not update ticket ${id}`)));
    }),
    setLocalState: Effect.fn("KanbanStore.setLocalState")((id, state, updatedAt) =>
      sql`
        UPDATE kanban_tickets
        SET
          local_state = ${state},
          updated_at = ${updatedAt},
          closed_at = CASE
            WHEN ${state} <> 'done' THEN NULL
            WHEN local_state = 'done' THEN closed_at
            ELSE ${updatedAt}
          END
        WHERE id = ${id} AND issue_id IS NULL
      `.pipe(Effect.asVoid, Effect.mapError(failWith(`Could not move ticket ${id}`))),
    ),
    setTicketBot: Effect.fn("KanbanStore.setTicketBot")((id, botId, updatedAt) =>
      sql`
        UPDATE kanban_tickets
        SET
          bot_id = ${botId},
          updated_at = CASE
            WHEN issue_id IS NULL THEN COALESCE(${updatedAt ?? null}, updated_at)
            ELSE updated_at
          END
        WHERE id = ${id}
      `.pipe(Effect.asVoid, Effect.mapError(failWith(`Could not set the bot of ticket ${id}`))),
    ),
    getLocalDescription: Effect.fn("KanbanStore.getLocalDescription")((id) =>
      sql`SELECT description FROM kanban_tickets WHERE id = ${id} AND issue_id IS NULL`.pipe(
        Effect.flatMap(decodeDescriptions),
        Effect.map((rows) => Option.fromNullishOr(rows[0]?.description)),
        Effect.mapError(failWith(`Could not read the description of ticket ${id}`)),
      ),
    ),
    deleteTicket: Effect.fn("KanbanStore.deleteTicket")((id) =>
      sql`DELETE FROM kanban_tickets WHERE id = ${id}`.pipe(
        Effect.asVoid,
        Effect.mapError(failWith(`Could not delete ticket ${id}`)),
      ),
    ),
    upsertLinearTickets: Effect.fn("KanbanStore.upsertLinearTickets")(
      (projectId, accountId, rows) =>
        sql
          .withTransaction(
            Effect.forEach(
              rows,
              (row) => sql`
              INSERT INTO kanban_tickets (
                id, project_id, account_id, issue_id, team_id, url, identifier, title,
                linear_state_id, assignee_id, assignee_name, creator_id, priority, estimate,
                due_date, label_ids, linear_project_id, milestone_id, cycle_id, parent_issue_id,
                parent_identifier, parent_title, sub_total, sub_closed, pull_requests,
                sort_order, closed_at, auto_closed, created_at, updated_at
              )
              VALUES (
                ${row.id}, ${projectId}, ${accountId}, ${row.issueId}, ${row.teamId}, ${row.url},
                ${row.identifier}, ${row.title}, ${row.stateId}, ${row.assigneeId},
                ${row.assigneeName}, ${row.creatorId}, ${row.priority}, ${row.estimate},
                ${row.dueDate}, ${encodeLabelIds(row.labelIds)}, ${row.linearProjectId},
                ${row.milestoneId}, ${row.cycleId}, ${row.parent?.issueId ?? null},
                ${row.parent?.identifier ?? null}, ${row.parent?.title ?? null},
                ${row.subIssues?.total ?? null}, ${row.subIssues?.closed ?? null},
                ${encodePullRequests(row.pullRequests)}, ${row.sortOrder}, ${row.closedAt},
                ${row.autoClosed ? 1 : 0}, ${row.createdAt}, ${row.updatedAt}
              )
              ON CONFLICT (project_id, issue_id) DO UPDATE SET
                account_id = excluded.account_id,
                team_id = excluded.team_id,
                url = excluded.url,
                identifier = excluded.identifier,
                title = excluded.title,
                linear_state_id = excluded.linear_state_id,
                assignee_id = excluded.assignee_id,
                assignee_name = excluded.assignee_name,
                creator_id = excluded.creator_id,
                priority = excluded.priority,
                estimate = excluded.estimate,
                due_date = excluded.due_date,
                label_ids = excluded.label_ids,
                linear_project_id = excluded.linear_project_id,
                milestone_id = excluded.milestone_id,
                cycle_id = excluded.cycle_id,
                parent_issue_id = excluded.parent_issue_id,
                parent_identifier = excluded.parent_identifier,
                parent_title = excluded.parent_title,
                sub_total = excluded.sub_total,
                sub_closed = excluded.sub_closed,
                pull_requests = excluded.pull_requests,
                sort_order = excluded.sort_order,
                closed_at = excluded.closed_at,
                auto_closed = excluded.auto_closed,
                updated_at = excluded.updated_at
            `,
              { discard: true },
            ),
          )
          .pipe(Effect.mapError(failWith("Could not save synced tickets"))),
    ),
    deleteLinearTickets: Effect.fn("KanbanStore.deleteLinearTickets")((projectId, issueIds) =>
      issueIds.length === 0
        ? Effect.void
        : sql`
            DELETE FROM kanban_tickets
            WHERE project_id = ${projectId} AND issue_id IN ${sql.in(issueIds)}
          `.pipe(Effect.asVoid, Effect.mapError(failWith("Could not drop synced tickets"))),
    ),

    listLocalComments: Effect.fn("KanbanStore.listLocalComments")((ticketId) =>
      sql`
        SELECT
          id,
          ticket_id AS "ticketId",
          author_id AS "authorId",
          body,
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM kanban_local_comments WHERE ticket_id = ${ticketId} ORDER BY created_at, id
      `.pipe(
        Effect.flatMap(decodeComments),
        Effect.mapError(failWith(`Could not read the comments of ticket ${ticketId}`)),
      ),
    ),
    insertLocalComment: Effect.fn("KanbanStore.insertLocalComment")((row) =>
      sql`
        INSERT INTO kanban_local_comments (id, ticket_id, author_id, body, created_at, updated_at)
        VALUES (
          ${row.id}, ${row.ticketId}, ${row.authorId}, ${row.body}, ${row.createdAt},
          ${row.updatedAt}
        )
      `.pipe(Effect.asVoid, Effect.mapError(failWith("Could not save the comment"))),
    ),
    deleteLocalComment: Effect.fn("KanbanStore.deleteLocalComment")((ticketId, commentId) =>
      sql`
        DELETE FROM kanban_local_comments WHERE ticket_id = ${ticketId} AND id = ${commentId}
        RETURNING id
      `.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(failWith(`Could not delete comment ${commentId}`)),
      ),
    ),
    listTicketEvents: Effect.fn("KanbanStore.listTicketEvents")((ticketId) =>
      sql`
        SELECT id, ticket_id AS "ticketId", actor_id AS "actorId", text, created_at AS "createdAt"
        FROM kanban_ticket_events WHERE ticket_id = ${ticketId} ORDER BY created_at, id
      `.pipe(
        Effect.flatMap(decodeEvents),
        Effect.mapError(failWith(`Could not read the history of ticket ${ticketId}`)),
      ),
    ),
    insertTicketEvent: Effect.fn("KanbanStore.insertTicketEvent")((row) =>
      sql`
        INSERT INTO kanban_ticket_events (id, ticket_id, actor_id, text, created_at)
        VALUES (${row.id}, ${row.ticketId}, ${row.actorId}, ${row.text}, ${row.createdAt})
      `.pipe(Effect.asVoid, Effect.mapError(failWith("Could not save the ticket history"))),
    ),

    linkThread: Effect.fn("KanbanStore.linkThread")((ticketId, threadId, at) =>
      sql`
        INSERT INTO kanban_ticket_threads (ticket_id, thread_id, created_at)
        VALUES (${ticketId}, ${threadId}, ${at})
        ON CONFLICT DO NOTHING
      `.pipe(Effect.asVoid, Effect.mapError(failWith("Could not link the thread"))),
    ),
    unlinkThread: Effect.fn("KanbanStore.unlinkThread")((ticketId, threadId) =>
      sql`
        DELETE FROM kanban_ticket_threads WHERE ticket_id = ${ticketId} AND thread_id = ${threadId}
      `.pipe(Effect.asVoid, Effect.mapError(failWith("Could not unlink the thread"))),
    ),

    listViews: sql`${selectViews} ORDER BY position, id`.pipe(
      Effect.flatMap(decodeViews),
      Effect.map((rows) => rows.map(toView)),
      Effect.mapError(failWith("Could not read views from bots.sqlite")),
    ),
    getView: Effect.fn("KanbanStore.getView")((id) =>
      sql`${selectViews} WHERE id = ${id}`.pipe(
        Effect.flatMap(decodeViews),
        Effect.map((rows) => Option.fromNullishOr(rows[0]).pipe(Option.map(toView))),
        Effect.mapError(failWith(`Could not read view ${id}`)),
      ),
    ),
    findViewByLinearId: Effect.fn("KanbanStore.findViewByLinearId")((linearViewId) =>
      sql`${selectViews} WHERE linear_view_id = ${linearViewId} ORDER BY position, id LIMIT 1`.pipe(
        Effect.flatMap(decodeViews),
        Effect.map((rows) => Option.fromNullishOr(rows[0]).pipe(Option.map(toView))),
        Effect.mapError(failWith(`Could not read the view imported from ${linearViewId}`)),
      ),
    ),
    insertView: Effect.fn("KanbanStore.insertView")((view) =>
      sql`
        INSERT INTO kanban_views (
          id, project_id, name, icon, config, linear_view_id, created_by, updated_by, position,
          created_at, updated_at
        )
        VALUES (
          ${view.id}, ${view.projectId}, ${view.name}, ${view.icon},
          ${encodeViewConfig(view.config)}, ${view.linearViewId}, ${view.createdBy},
          ${view.updatedBy},
          (SELECT COALESCE(MAX(position), -1) + 1 FROM kanban_views),
          ${view.createdAt}, ${view.updatedAt}
        )
      `.pipe(Effect.asVoid, Effect.mapError(failWith("Could not save the view"))),
    ),
    updateView: Effect.fn("KanbanStore.updateView")((view, onBoard) =>
      sql`
        UPDATE kanban_views
        SET
          project_id = ${view.projectId},
          name = ${view.name},
          icon = ${view.icon},
          config = ${encodeViewConfig(view.config)},
          linear_view_id = ${view.linearViewId},
          updated_by = ${view.updatedBy},
          created_at = ${view.createdAt},
          updated_at = ${view.updatedAt}
        WHERE id = ${view.id} ${onBoardClause(onBoard)}
        RETURNING id
      `.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(failWith(`Could not save view ${view.id}`)),
      ),
    ),
    deleteView: Effect.fn("KanbanStore.deleteView")((id, onBoard) =>
      sql`DELETE FROM kanban_views WHERE id = ${id} ${onBoardClause(onBoard)} RETURNING id`.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.mapError(failWith(`Could not delete view ${id}`)),
      ),
    ),
    reorderViews: Effect.fn("KanbanStore.reorderViews")((ids) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const current = (yield* sql`SELECT id FROM kanban_views ORDER BY position, id`.pipe(
              Effect.flatMap(decodeViewIds),
            )).map((row) => row.id);
            const known = new Set(current);
            const first = new Set(ids.filter((id) => known.has(id)));
            const order = [...first, ...current.filter((id) => !first.has(id))];
            for (const [position, id] of order.entries()) {
              yield* sql`UPDATE kanban_views SET position = ${position} WHERE id = ${id}`;
            }
          }),
        )
        .pipe(Effect.mapError(failWith("Could not reorder views"))),
    ),

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
    setWorkspaceBots: Effect.fn("KanbanStore.setWorkspaceBots")((workspaceId, botIds) =>
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
    ),
    listAllWorkspacesBots:
      sql`SELECT bot_id AS "botId" FROM kanban_all_workspace_bots ORDER BY rowid`.pipe(
        Effect.flatMap(decodeBotIds),
        Effect.map((rows) => rows.map((row) => row.botId)),
        Effect.mapError(failWith("Could not read the bots responsible for every workspace")),
      ),
    setBotAllWorkspaces: Effect.fn("KanbanStore.setBotAllWorkspaces")((botId, allWorkspaces) =>
      (allWorkspaces
        ? sql`INSERT INTO kanban_all_workspace_bots (bot_id) VALUES (${botId}) ON CONFLICT DO NOTHING`
        : sql`DELETE FROM kanban_all_workspace_bots WHERE bot_id = ${botId}`
      ).pipe(
        Effect.asVoid,
        Effect.mapError(failWith(`Could not change whether bot ${botId} covers every workspace`)),
      ),
    ),
  });
});

/** Over `bots.sqlite` in the server state directory. */
export const layer = Layer.effect(KanbanStore, make).pipe(Layer.provide(BotsDb.layer));

/** A migrated in-memory database, for tests. */
export const layerMemory = Layer.effect(KanbanStore, make).pipe(Layer.provide(BotsDb.layerMemory));

/** Over an existing bots database, for tests that share one with BotsStore. */
export const layerFromDb = Layer.effect(KanbanStore, make);
