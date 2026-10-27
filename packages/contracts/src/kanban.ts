/**
 * Kanban of agent work (friend fork), optionally synced with Linear, kept on the bots host in
 * `bots.sqlite`. A Linear key never leaves the server; clients see only its last 4 characters.
 * `bots.ts` re-exports this module, so this file must not import from `bots.ts`.
 * Design: docs/friend/linear-kanban.md.
 */
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** The same schema as `bots.ts`'s BotId (same brand), declared here to keep the import acyclic. */
const BotId = Schema.String.check(Schema.isPattern(ID_PATTERN)).pipe(Schema.brand("BotId"));

export const LinearAccountId = Schema.String.check(Schema.isPattern(ID_PATTERN)).pipe(
  Schema.brand("LinearAccountId"),
);
export type LinearAccountId = typeof LinearAccountId.Type;

export const KanbanTicketId = Schema.String.check(Schema.isPattern(ID_PATTERN)).pipe(
  Schema.brand("KanbanTicketId"),
);
export type KanbanTicketId = typeof KanbanTicketId.Type;

/** Linear's own ids (UUIDs); bounded only against abuse. */
export const LinearId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

export const KANBAN_LIMITS = {
  accountName: 60,
  apiKey: 256,
  title: 255,
  description: 20_000,
  comment: 20_000,
  viewName: 60,
  labelName: 60,
  filterClauses: 30,
  filterValues: 50,
  aiFilterText: 500,
} as const;

export class KanbanError extends Schema.TaggedError<KanbanError>()("KanbanError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

/** The columns of a board that is not synced with Linear, in board order. */
export const KANBAN_LOCAL_STATES = ["backlog", "todo", "in_progress", "in_review", "done"] as const;
export const KanbanLocalState = Schema.Literals(KANBAN_LOCAL_STATES);
export type KanbanLocalState = typeof KanbanLocalState.Type;

export const KANBAN_LOCAL_STATE_LABELS: Record<KanbanLocalState, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
};

/** Linear's workflow state categories. */
export const LinearStateType = Schema.Literals([
  "triage",
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
  "duplicate",
]);
export type LinearStateType = typeof LinearStateType.Type;

/** Board order of Linear's categories; Linear orders states by `position` within one. */
export const LINEAR_STATE_TYPE_ORDER: readonly LinearStateType[] = [
  "triage",
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
  "duplicate",
];

export const LinearWorkflowState = Schema.Struct({
  id: LinearId,
  teamId: LinearId,
  name: Schema.String,
  type: LinearStateType,
  position: Schema.Number,
  color: Schema.String,
});
export type LinearWorkflowState = typeof LinearWorkflowState.Type;

export const LinearAccountName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(KANBAN_LIMITS.accountName),
);

/** What clients see of an account: never the key itself. */
export const LinearAccount = Schema.Struct({
  id: LinearAccountId,
  name: LinearAccountName,
  keyLast4: Schema.String,
  /** The Linear user the key belongs to. */
  userName: Schema.String,
  /** That user's Linear id ("me" in filters); null until the first sync after the v2 upgrade. */
  userId: Schema.NullOr(Schema.String),
  userAvatarUrl: Schema.NullOr(Schema.String),
  organizationId: LinearId,
  organizationName: Schema.String,
  organizationUrlKey: Schema.String,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type LinearAccount = typeof LinearAccount.Type;

/** `local`, or `linear:<organization id>`. */
export const KanbanWorkspaceId = Schema.String.check(
  Schema.isPattern(/^(local|linear:[A-Za-z0-9_-]{1,128})$/),
).pipe(Schema.brand("KanbanWorkspaceId"));
export type KanbanWorkspaceId = typeof KanbanWorkspaceId.Type;

export const LOCAL_KANBAN_WORKSPACE_ID = KanbanWorkspaceId.make("local");

export function linearWorkspaceId(organizationId: string): KanbanWorkspaceId {
  return KanbanWorkspaceId.make(`linear:${organizationId}`);
}

/** The local workspace, and every Linear organization some account reaches. */
export const KanbanWorkspace = Schema.Struct({
  id: KanbanWorkspaceId,
  name: Schema.String,
  /** Bots responsible for the workspace's tickets, in the order the user chose. */
  botIds: Schema.Array(BotId),
});
export type KanbanWorkspace = typeof KanbanWorkspace.Type;

export const KanbanProjectLink = Schema.Struct({
  projectId: ProjectId,
  accountId: LinearAccountId,
  teamId: LinearId,
  teamKey: Schema.String,
  teamName: Schema.String,
  /** Narrows the board to one Linear project of the team; null takes the whole team. */
  linearProjectId: Schema.NullOr(LinearId),
  linearProjectName: Schema.NullOr(Schema.String),
  lastSyncedAt: Schema.NullOr(IsoDateTime),
  /** The last sync's failure, cleared by the next success. */
  syncError: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
});
export type KanbanProjectLink = typeof KanbanProjectLink.Type;

export const KanbanTicketStatus = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("local"), state: KanbanLocalState }),
  Schema.Struct({ kind: Schema.Literal("linear"), stateId: LinearId }),
]);
export type KanbanTicketStatus = typeof KanbanTicketStatus.Type;

/**
 * Who a ticket is assigned to or was created by: a Linear user id, `owner` (the T3 user, on local
 * tickets), or `bot:<botId>` (a bot, on local tickets).
 */
export const KanbanPersonId = Schema.String.check(Schema.isMaxLength(140));
export type KanbanPersonId = typeof KanbanPersonId.Type;
export const KANBAN_OWNER_PERSON_ID = "owner";
export const kanbanBotPersonId = (botId: string): KanbanPersonId => `bot:${botId}`;

/** A GitHub pull request attached to a Linear issue (Linear's GitHub integration). */
export const KanbanPullRequestRef = Schema.Struct({
  attachmentId: Schema.String,
  url: Schema.String,
  /** `owner/name`. */
  repository: Schema.String,
  number: NonNegativeInt,
  title: Schema.String,
  state: Schema.Literals(["open", "draft", "merged", "closed"]),
});
export type KanbanPullRequestRef = typeof KanbanPullRequestRef.Type;

export const KanbanTicket = Schema.Struct({
  id: KanbanTicketId,
  projectId: ProjectId,
  /** Null for a local ticket. */
  linear: Schema.NullOr(
    Schema.Struct({
      accountId: LinearAccountId,
      issueId: LinearId,
      teamId: LinearId,
      url: Schema.String,
    }),
  ),
  /** `MON-123` for a Linear issue, `T-7` for a local ticket. */
  identifier: Schema.String,
  title: Schema.String,
  status: KanbanTicketStatus,
  assigneeId: Schema.NullOr(KanbanPersonId),
  /** Denormalized for readers without the people list (bots, older clients). */
  assigneeName: Schema.NullOr(Schema.String),
  creatorId: Schema.NullOr(KanbanPersonId),
  /** Linear's scale: 0 none, 1 urgent … 4 low. */
  priority: NonNegativeInt,
  estimate: Schema.NullOr(Schema.Number),
  /** `YYYY-MM-DD`. */
  dueDate: Schema.NullOr(Schema.String),
  /** Linear label ids, or local label ids on a local ticket. */
  labelIds: Schema.Array(Schema.String),
  linearProjectId: Schema.NullOr(Schema.String),
  milestoneId: Schema.NullOr(Schema.String),
  cycleId: Schema.NullOr(Schema.String),
  /** The parent issue of a sub-issue; `ticketId` when the parent is on the board too. */
  parent: Schema.NullOr(
    Schema.Struct({
      issueId: Schema.String,
      identifier: Schema.String,
      title: Schema.String,
    }),
  ),
  /** Sub-issue progress; null when the issue has none. Closed counts completed and canceled. */
  subIssues: Schema.NullOr(Schema.Struct({ total: NonNegativeInt, closed: NonNegativeInt })),
  pullRequests: Schema.Array(KanbanPullRequestRef),
  /** The T3 bot that owns this ticket, set in T3 only (never written to Linear). */
  botId: Schema.NullOr(BotId),
  /** Linear's `sortOrder` (manual order), or a local ticket's own. Lower first. */
  sortOrder: Schema.Number,
  /** When it entered a completed or canceled state; null while open. */
  closedAt: Schema.NullOr(IsoDateTime),
  /** Closed by Linear's auto-close, not by a person. */
  autoClosed: Schema.Boolean,
  /** Linked threads, oldest link first. */
  threadIds: Schema.Array(ThreadId),
  createdAt: IsoDateTime,
  /** Linear's `updatedAt` for an issue; the last local write for a local ticket. */
  updatedAt: IsoDateTime,
});
export type KanbanTicket = typeof KanbanTicket.Type;

/** A Linear user of a workspace some account reaches (cached on full syncs). */
export const KanbanPerson = Schema.Struct({
  id: KanbanPersonId,
  organizationId: Schema.String,
  name: Schema.String,
  displayName: Schema.String,
  avatarUrl: Schema.NullOr(Schema.String),
  active: Schema.Boolean,
});
export type KanbanPerson = typeof KanbanPerson.Type;

/** A Linear label (team or workspace-wide), or a local label of the local workspace. */
export const KanbanLabel = Schema.Struct({
  id: Schema.String,
  workspaceId: KanbanWorkspaceId,
  /** Null for a workspace-wide Linear label and for local labels. */
  teamId: Schema.NullOr(Schema.String),
  name: Schema.String,
  /** `#rrggbb`. */
  color: Schema.String,
  /** Label groups: the group's id. */
  parentId: Schema.NullOr(Schema.String),
  source: Schema.Literals(["linear", "local"]),
});
export type KanbanLabel = typeof KanbanLabel.Type;

export const KanbanLinearProject = Schema.Struct({
  id: Schema.String,
  organizationId: Schema.String,
  name: Schema.String,
  color: Schema.String,
  /** Linear's icon name (e.g. "Bug"), when set. */
  icon: Schema.NullOr(Schema.String),
});
export type KanbanLinearProject = typeof KanbanLinearProject.Type;

export const KanbanMilestone = Schema.Struct({
  id: Schema.String,
  projectId: Schema.String,
  name: Schema.String,
});
export type KanbanMilestone = typeof KanbanMilestone.Type;

export const KanbanCycle = Schema.Struct({
  id: Schema.String,
  teamId: Schema.String,
  number: NonNegativeInt,
  name: Schema.NullOr(Schema.String),
  startsAt: IsoDateTime,
  endsAt: IsoDateTime,
});
export type KanbanCycle = typeof KanbanCycle.Type;

/**
 * Fields matched against a set of values. `assignee`/`creator` take person ids plus `me` and
 * `none`; `cycle` also takes `current`; `threadStatus`/`pullRequest` take states plus `none`.
 * Every encoding: docs/friend/linear-kanban.md, "Filters".
 */
export const KANBAN_SET_FILTER_FIELDS = [
  "status",
  "statusType",
  "assignee",
  "creator",
  "priority",
  "label",
  "project",
  "milestone",
  "cycle",
  "bot",
  "threadStatus",
  "pullRequest",
  "workspace",
  "account",
  "t3Project",
] as const;
export const KanbanSetFilterField = Schema.Literals(KANBAN_SET_FILTER_FIELDS);
export type KanbanSetFilterField = typeof KanbanSetFilterField.Type;

export const KANBAN_DATE_FILTER_FIELDS = ["createdAt", "updatedAt", "dueDate", "closedAt"] as const;
export const KanbanDateFilterField = Schema.Literals(KANBAN_DATE_FILTER_FIELDS);
export type KanbanDateFilterField = typeof KanbanDateFilterField.Type;

/** Yes/no facts: sub-issue relations, linked threads, PR links, auto-close, a due date. */
export const KANBAN_FLAG_FILTER_FIELDS = [
  "isSubIssue",
  "hasSubIssues",
  "hasThreads",
  "hasPullRequests",
  "autoClosed",
  "hasDueDate",
] as const;
export const KanbanFlagFilterField = Schema.Literals(KANBAN_FLAG_FILTER_FIELDS);
export type KanbanFlagFilterField = typeof KanbanFlagFilterField.Type;

const FilterValue = Schema.String.check(Schema.isMaxLength(140));

/** One condition; a view keeps the tickets that match every clause. */
export const KanbanFilterClause = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("set"),
    field: KanbanSetFilterField,
    /** `in`: is / is any of. `notIn`: is not / is none of. */
    op: Schema.Literals(["in", "notIn"]),
    values: Schema.Array(FilterValue).check(Schema.isMaxLength(KANBAN_LIMITS.filterValues)),
  }),
  Schema.Struct({
    kind: Schema.Literal("date"),
    field: KanbanDateFilterField,
    /** `before`/`after` take an ISO date; `pastDays`/`nextDays` a day count; the rest nothing. */
    op: Schema.Literals(["before", "after", "pastDays", "nextDays", "isSet", "isEmpty"]),
    value: Schema.NullOr(Schema.Union([Schema.String, Schema.Number])),
  }),
  Schema.Struct({
    kind: Schema.Literal("flag"),
    field: KanbanFlagFilterField,
    value: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("text"),
    field: Schema.Literal("content"),
    /** Matched case-insensitively against identifier, title and labels' names. */
    value: Schema.String.check(Schema.isMaxLength(200)),
  }),
]);
export type KanbanFilterClause = typeof KanbanFilterClause.Type;

/** Board columns, list sections and swimlanes group by one of these. */
export const KANBAN_GROUPINGS = [
  "status",
  "assignee",
  "priority",
  "label",
  "project",
  "cycle",
  "none",
] as const;
export const KanbanGrouping = Schema.Literals(KANBAN_GROUPINGS);
export type KanbanGrouping = typeof KanbanGrouping.Type;

export const KANBAN_ORDERINGS = ["priority", "updated", "created", "manual", "dueDate"] as const;
export const KanbanOrdering = Schema.Literals(KANBAN_ORDERINGS);
export type KanbanOrdering = typeof KanbanOrdering.Type;

/** Card and row properties a view shows. */
export const KANBAN_DISPLAY_PROPERTIES = [
  "id",
  "status",
  "assignee",
  "priority",
  "project",
  "dueDate",
  "milestone",
  "cycle",
  "labels",
  "estimate",
  "subIssues",
  "pullRequests",
  "threads",
  "bot",
  "created",
  "updated",
] as const;
export const KanbanDisplayProperty = Schema.Literals(KANBAN_DISPLAY_PROPERTIES);
export type KanbanDisplayProperty = typeof KanbanDisplayProperty.Type;

export const KanbanViewConfig = Schema.Struct({
  filters: Schema.Array(KanbanFilterClause).check(Schema.isMaxLength(KANBAN_LIMITS.filterClauses)),
  layout: Schema.Literals(["board", "list"]),
  /** Board columns, or list sections. */
  groupBy: KanbanGrouping,
  /** Swimlanes (board rows); `none` for one row. */
  subGroupBy: KanbanGrouping,
  orderBy: KanbanOrdering,
  /** Closed tickets sort by when they closed, newest first, whatever the ordering. */
  completedByRecency: Schema.Boolean,
  /** Which closed (completed or canceled) tickets show. */
  completed: Schema.Literals(["all", "pastWeek", "pastMonth", "none"]),
  showSubIssues: Schema.Boolean,
  /** Empty columns stay on the board; otherwise they fold into "Hidden columns". */
  showEmptyColumns: Schema.Boolean,
  /** Column ids the user hid (they fold into "Hidden columns" even when not empty). */
  hiddenColumns: Schema.Array(Schema.String).check(Schema.isMaxLength(100)),
  properties: Schema.Array(KanbanDisplayProperty),
});
export type KanbanViewConfig = typeof KanbanViewConfig.Type;

export const KanbanViewId = Schema.String.check(Schema.isPattern(ID_PATTERN)).pipe(
  Schema.brand("KanbanViewId"),
);
export type KanbanViewId = typeof KanbanViewId.Type;

export const KanbanViewName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(KANBAN_LIMITS.viewName),
);

/**
 * A saved view, shown as a tab. `projectId` null: on every board (the board of all projects and
 * each project's board); otherwise only on that project's board. The server owns one ordered list.
 */
export const KanbanView = Schema.Struct({
  id: KanbanViewId,
  projectId: Schema.NullOr(ProjectId),
  name: KanbanViewName,
  /** Lucide-style icon name for the tab; null shows none. */
  icon: Schema.NullOr(Schema.String),
  config: KanbanViewConfig,
  /** The Linear custom view it was imported from, so a second import skips it. */
  linearViewId: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type KanbanView = typeof KanbanView.Type;

export const KANBAN_DEFAULT_PROPERTIES: ReadonlyArray<KanbanDisplayProperty> = [
  "id",
  "status",
  "assignee",
  "priority",
  "project",
  "dueDate",
  "labels",
  "subIssues",
  "pullRequests",
  "threads",
  "bot",
  "created",
];

/** A view's settings before anyone changes them: a board by status, every ticket. */
export const KANBAN_DEFAULT_VIEW_CONFIG: KanbanViewConfig = {
  filters: [],
  layout: "board",
  groupBy: "status",
  subGroupBy: "none",
  orderBy: "priority",
  completedByRecency: true,
  completed: "pastMonth",
  showSubIssues: true,
  showEmptyColumns: false,
  hiddenColumns: [],
  properties: KANBAN_DEFAULT_PROPERTIES,
};

/** The views a fresh database starts with, on every board (migration 9 inserts them). */
export const KANBAN_SEED_VIEWS: ReadonlyArray<{
  readonly id: string;
  readonly name: string;
  readonly icon: string | null;
  readonly config: KanbanViewConfig;
}> = [
  {
    id: "v_active",
    name: "Active",
    icon: null,
    config: {
      ...KANBAN_DEFAULT_VIEW_CONFIG,
      filters: [{ kind: "set", field: "statusType", op: "in", values: ["unstarted", "started"] }],
    },
  },
  {
    id: "v_backlog",
    name: "Backlog",
    icon: null,
    config: {
      ...KANBAN_DEFAULT_VIEW_CONFIG,
      filters: [{ kind: "set", field: "statusType", op: "in", values: ["triage", "backlog"] }],
    },
  },
  { id: "v_all", name: "All issues", icon: null, config: KANBAN_DEFAULT_VIEW_CONFIG },
  {
    id: "v_mine",
    name: "Meus issues",
    icon: "Zap",
    config: {
      ...KANBAN_DEFAULT_VIEW_CONFIG,
      filters: [{ kind: "set", field: "assignee", op: "in", values: ["me"] }],
    },
  },
  {
    id: "v_done",
    name: "Concluídas",
    icon: "Layers",
    config: {
      ...KANBAN_DEFAULT_VIEW_CONFIG,
      completed: "all",
      filters: [
        {
          kind: "set",
          field: "statusType",
          op: "in",
          values: ["completed", "canceled", "duplicate"],
        },
      ],
    },
  },
];

/** Everything the board renders, republished after every change. */
export const KanbanSnapshot = Schema.Struct({
  accounts: Schema.Array(LinearAccount),
  workspaces: Schema.Array(KanbanWorkspace),
  links: Schema.Array(KanbanProjectLink),
  /** Workflow states of every linked team. */
  states: Schema.Array(LinearWorkflowState),
  tickets: Schema.Array(KanbanTicket),
  /** Linear users of every linked workspace. */
  people: Schema.Array(KanbanPerson),
  /** Labels of every linked team (and their workspaces), then local labels. */
  labels: Schema.Array(KanbanLabel),
  linearProjects: Schema.Array(KanbanLinearProject),
  milestones: Schema.Array(KanbanMilestone),
  /** Cycles of every linked team. */
  cycles: Schema.Array(KanbanCycle),
  /** Saved views in tab order. */
  views: Schema.Array(KanbanView),
});
export type KanbanSnapshot = typeof KanbanSnapshot.Type;

export const LinearTeamSummary = Schema.Struct({
  id: LinearId,
  key: Schema.String,
  name: Schema.String,
  projects: Schema.Array(Schema.Struct({ id: LinearId, name: Schema.String })),
});
export type LinearTeamSummary = typeof LinearTeamSummary.Type;

export const LinearAccountAddInput = Schema.Struct({
  name: LinearAccountName,
  apiKey: TrimmedNonEmptyString.check(Schema.isMaxLength(KANBAN_LIMITS.apiKey)),
});
export type LinearAccountAddInput = typeof LinearAccountAddInput.Type;

export const LinearAccountRenameInput = Schema.Struct({
  accountId: LinearAccountId,
  name: LinearAccountName,
});
export type LinearAccountRenameInput = typeof LinearAccountRenameInput.Type;

export const LinearAccountRef = Schema.Struct({ accountId: LinearAccountId });
export type LinearAccountRef = typeof LinearAccountRef.Type;

export const LinearTeamsResult = Schema.Struct({ teams: Schema.Array(LinearTeamSummary) });
export type LinearTeamsResult = typeof LinearTeamsResult.Type;

export const KanbanProjectLinkInput = Schema.Struct({
  projectId: ProjectId,
  accountId: LinearAccountId,
  teamId: LinearId,
  linearProjectId: Schema.NullOr(LinearId),
});
export type KanbanProjectLinkInput = typeof KanbanProjectLinkInput.Type;

export const KanbanProjectRef = Schema.Struct({ projectId: ProjectId });
export type KanbanProjectRef = typeof KanbanProjectRef.Type;

export const KanbanWorkspaceBotsInput = Schema.Struct({
  workspaceId: KanbanWorkspaceId,
  botIds: Schema.Array(BotId).check(Schema.isMaxLength(32)),
});
export type KanbanWorkspaceBotsInput = typeof KanbanWorkspaceBotsInput.Type;

export const KanbanTicketTitle = TrimmedNonEmptyString.check(
  Schema.isMaxLength(KANBAN_LIMITS.title),
);

/** In a linked project the ticket is created in Linear, in the team's default state. */
export const KanbanTicketCreateInput = Schema.Struct({
  projectId: ProjectId,
  title: KanbanTicketTitle,
  description: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(KANBAN_LIMITS.description)),
  ),
  /** A local ticket's column; Linear picks the column of a new issue. */
  state: Schema.optionalKey(KanbanLocalState),
  priority: Schema.optionalKey(NonNegativeInt.check(Schema.isLessThanOrEqualTo(4))),
  assigneeId: Schema.optionalKey(Schema.NullOr(KanbanPersonId)),
  labelIds: Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMaxLength(50))),
});
export type KanbanTicketCreateInput = typeof KanbanTicketCreateInput.Type;

export const KanbanTicketRef = Schema.Struct({ ticketId: KanbanTicketId });
export type KanbanTicketRef = typeof KanbanTicketRef.Type;

/** A local ticket takes a local state; a Linear ticket a workflow state of its own team. */
export const KanbanTicketMoveInput = Schema.Struct({
  ticketId: KanbanTicketId,
  to: KanbanTicketStatus,
});
export type KanbanTicketMoveInput = typeof KanbanTicketMoveInput.Type;

export const KanbanTicketThreadInput = Schema.Struct({
  ticketId: KanbanTicketId,
  threadId: ThreadId,
});
export type KanbanTicketThreadInput = typeof KanbanTicketThreadInput.Type;

export const KanbanSyncInput = Schema.Struct({
  /** One linked project; every linked project when absent. */
  projectId: Schema.optionalKey(ProjectId),
});
export type KanbanSyncInput = typeof KanbanSyncInput.Type;

/**
 * A change to a ticket's properties; absent keys stay. On a Linear ticket every key but `botId`
 * goes to Linear first (`issueUpdate`), and the board keeps Linear's answer. On a local ticket
 * `linearProjectId`, `milestoneId`, `cycleId` and `estimate` are refused.
 */
export const KanbanTicketPatch = Schema.Struct({
  title: Schema.optionalKey(KanbanTicketTitle),
  description: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(KANBAN_LIMITS.description)),
  ),
  priority: Schema.optionalKey(NonNegativeInt.check(Schema.isLessThanOrEqualTo(4))),
  assigneeId: Schema.optionalKey(Schema.NullOr(KanbanPersonId)),
  labelIds: Schema.optionalKey(Schema.Array(Schema.String).check(Schema.isMaxLength(50))),
  dueDate: Schema.optionalKey(
    Schema.NullOr(Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/))),
  ),
  estimate: Schema.optionalKey(Schema.NullOr(Schema.Number)),
  linearProjectId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  milestoneId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  cycleId: Schema.optionalKey(Schema.NullOr(Schema.String)),
  botId: Schema.optionalKey(Schema.NullOr(BotId)),
});
export type KanbanTicketPatch = typeof KanbanTicketPatch.Type;

export const KanbanTicketUpdateInput = Schema.Struct({
  ticketId: KanbanTicketId,
  patch: KanbanTicketPatch,
});
export type KanbanTicketUpdateInput = typeof KanbanTicketUpdateInput.Type;

export const KanbanComment = Schema.Struct({
  id: Schema.String,
  /** A Linear user id, `owner`, `bot:<botId>`, or null for an integration (see `authorName`). */
  authorId: Schema.NullOr(KanbanPersonId),
  authorName: Schema.String,
  authorAvatarUrl: Schema.NullOr(Schema.String),
  /** Markdown. */
  body: Schema.String,
  /** Replies point at the comment they answer. */
  parentId: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  editedAt: Schema.NullOr(IsoDateTime),
  /** The caller may delete it: a local comment, or a Linear comment by an account's own user. */
  deletable: Schema.Boolean,
});
export type KanbanComment = typeof KanbanComment.Type;

/** One history entry, already phrased by the server ("changed status from A to B"). */
export const KanbanActivity = Schema.Struct({
  id: Schema.String,
  actorId: Schema.NullOr(KanbanPersonId),
  actorName: Schema.String,
  actorAvatarUrl: Schema.NullOr(Schema.String),
  /** The sentence after the actor's name, e.g. "moved from Backlog to Em Progresso". */
  text: Schema.String,
  createdAt: IsoDateTime,
});
export type KanbanActivity = typeof KanbanActivity.Type;

export const KanbanSubIssue = Schema.Struct({
  issueId: Schema.String,
  /** The sub-issue's own ticket when it is on this board. */
  ticketId: Schema.NullOr(KanbanTicketId),
  identifier: Schema.String,
  title: Schema.String,
  status: KanbanTicketStatus,
  priority: NonNegativeInt,
  assigneeId: Schema.NullOr(KanbanPersonId),
  url: Schema.NullOr(Schema.String),
});
export type KanbanSubIssue = typeof KanbanSubIssue.Type;

/**
 * What the issue view adds to the snapshot's ticket, read when the issue opens (from Linear for a
 * synced ticket, from bots.sqlite for a local one), never on the polling path.
 */
export const KanbanTicketDetail = Schema.Struct({
  ticketId: KanbanTicketId,
  /** Markdown; null when empty. */
  description: Schema.NullOr(Schema.String),
  parent: Schema.NullOr(
    Schema.Struct({
      issueId: Schema.String,
      ticketId: Schema.NullOr(KanbanTicketId),
      identifier: Schema.String,
      title: Schema.String,
      status: Schema.NullOr(KanbanTicketStatus),
    }),
  ),
  children: Schema.Array(KanbanSubIssue),
  /** Oldest first. */
  comments: Schema.Array(KanbanComment),
  /** Oldest first. */
  activity: Schema.Array(KanbanActivity),
  fetchedAt: IsoDateTime,
});
export type KanbanTicketDetail = typeof KanbanTicketDetail.Type;

export const KanbanTicketCommentInput = Schema.Struct({
  ticketId: KanbanTicketId,
  body: TrimmedNonEmptyString.check(Schema.isMaxLength(KANBAN_LIMITS.comment)),
});
export type KanbanTicketCommentInput = typeof KanbanTicketCommentInput.Type;

export const KanbanTicketCommentRef = Schema.Struct({
  ticketId: KanbanTicketId,
  commentId: Schema.String.check(Schema.isMaxLength(128)),
});
export type KanbanTicketCommentRef = typeof KanbanTicketCommentRef.Type;

/**
 * Starts work on a ticket. `project`: a new thread in the ticket's T3 project (its default model
 * unless one is given, in the project root), whose first message carries the issue (identifier,
 * title, link and description). `bot`: the same message goes to that bot's conversation. Either
 * way the thread is linked to the ticket.
 */
export const KanbanTicketStartThreadInput = Schema.Struct({
  ticketId: KanbanTicketId,
  target: Schema.Union([
    Schema.Struct({
      kind: Schema.Literal("project"),
      modelSelection: Schema.optionalKey(ModelSelection),
    }),
    Schema.Struct({ kind: Schema.Literal("bot"), botId: BotId }),
  ]),
  /** Added after the issue context, e.g. "Plan only". */
  note: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(4_000))),
});
export type KanbanTicketStartThreadInput = typeof KanbanTicketStartThreadInput.Type;

export const KanbanTicketStartThreadResult = Schema.Struct({
  threadId: ThreadId,
  ticket: KanbanTicket,
});
export type KanbanTicketStartThreadResult = typeof KanbanTicketStartThreadResult.Type;

/** Creates or (with `id`) replaces a saved view. A new view goes last. */
export const KanbanViewSaveInput = Schema.Struct({
  id: Schema.optionalKey(KanbanViewId),
  projectId: Schema.NullOr(ProjectId),
  name: KanbanViewName,
  icon: Schema.NullOr(Schema.String.check(Schema.isMaxLength(40))),
  config: KanbanViewConfig,
});
export type KanbanViewSaveInput = typeof KanbanViewSaveInput.Type;

export const KanbanViewRef = Schema.Struct({ viewId: KanbanViewId });
export type KanbanViewRef = typeof KanbanViewRef.Type;

/** Every view id in the new tab order; ids left out keep their relative order at the end. */
export const KanbanViewReorderInput = Schema.Struct({
  viewIds: Schema.Array(KanbanViewId).check(Schema.isMaxLength(200)),
});
export type KanbanViewReorderInput = typeof KanbanViewReorderInput.Type;

export const KanbanViewImportResult = Schema.Struct({
  imported: Schema.Array(KanbanView),
  /** Linear views not imported, with why (a filter T3 cannot express, or already imported). */
  skipped: Schema.Array(Schema.Struct({ name: Schema.String, reason: Schema.String })),
});
export type KanbanViewImportResult = typeof KanbanViewImportResult.Type;

export const KanbanLabelCreateInput = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(KANBAN_LIMITS.labelName)),
  color: Schema.String.check(Schema.isPattern(/^#[0-9a-fA-F]{6}$/)),
});
export type KanbanLabelCreateInput = typeof KanbanLabelCreateInput.Type;

export const KanbanLabelRef = Schema.Struct({
  labelId: Schema.String.check(Schema.isMaxLength(128)),
});
export type KanbanLabelRef = typeof KanbanLabelRef.Type;

/** Natural language to filter clauses, through the server's OpenRouter key. */
export const KanbanAiFilterInput = Schema.Struct({
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(KANBAN_LIMITS.aiFilterText)),
  projectId: Schema.NullOr(ProjectId),
});
export type KanbanAiFilterInput = typeof KanbanAiFilterInput.Type;

export const KanbanAiFilterResult = Schema.Struct({
  filters: Schema.Array(KanbanFilterClause),
});
export type KanbanAiFilterResult = typeof KanbanAiFilterResult.Type;

export const KANBAN_WS_METHODS = {
  kanbanSubscribe: "bots.kanban.subscribe",
  kanbanAccountAdd: "bots.kanban.account.add",
  kanbanAccountRename: "bots.kanban.account.rename",
  kanbanAccountDelete: "bots.kanban.account.delete",
  kanbanLinearTeams: "bots.kanban.linear.teams",
  kanbanProjectLink: "bots.kanban.project.link",
  kanbanProjectUnlink: "bots.kanban.project.unlink",
  kanbanWorkspaceBots: "bots.kanban.workspace.bots",
  kanbanTicketCreate: "bots.kanban.ticket.create",
  kanbanTicketMove: "bots.kanban.ticket.move",
  kanbanTicketDelete: "bots.kanban.ticket.delete",
  kanbanTicketLinkThread: "bots.kanban.ticket.linkThread",
  kanbanTicketUnlinkThread: "bots.kanban.ticket.unlinkThread",
  kanbanSync: "bots.kanban.sync",
  kanbanTicketDetail: "bots.kanban.ticket.detail",
  kanbanTicketUpdate: "bots.kanban.ticket.update",
  kanbanTicketComment: "bots.kanban.ticket.comment",
  kanbanTicketDeleteComment: "bots.kanban.ticket.deleteComment",
  kanbanTicketStartThread: "bots.kanban.ticket.startThread",
  kanbanViewSave: "bots.kanban.view.save",
  kanbanViewDelete: "bots.kanban.view.delete",
  kanbanViewReorder: "bots.kanban.view.reorder",
  kanbanViewImportLinear: "bots.kanban.view.importLinear",
  kanbanLabelCreate: "bots.kanban.label.create",
  kanbanLabelDelete: "bots.kanban.label.delete",
  kanbanAiFilter: "bots.kanban.aiFilter",
} as const;

const KanbanRpcError = Schema.Union([KanbanError, EnvironmentAuthorizationError]);

export const KanbanSubscribeRpc = Rpc.make(KANBAN_WS_METHODS.kanbanSubscribe, {
  payload: Schema.Struct({}),
  success: KanbanSnapshot,
  error: KanbanRpcError,
  stream: true,
});
/** Checks the key against Linear before saving it. */
export const KanbanAccountAddRpc = Rpc.make(KANBAN_WS_METHODS.kanbanAccountAdd, {
  payload: LinearAccountAddInput,
  success: LinearAccount,
  error: KanbanRpcError,
});
export const KanbanAccountRenameRpc = Rpc.make(KANBAN_WS_METHODS.kanbanAccountRename, {
  payload: LinearAccountRenameInput,
  success: LinearAccount,
  error: KanbanRpcError,
});
/** Unlinks its projects and drops their synced tickets with them; local tickets stay. */
export const KanbanAccountDeleteRpc = Rpc.make(KANBAN_WS_METHODS.kanbanAccountDelete, {
  payload: LinearAccountRef,
  success: LinearAccountRef,
  error: KanbanRpcError,
});
export const KanbanLinearTeamsRpc = Rpc.make(KANBAN_WS_METHODS.kanbanLinearTeams, {
  payload: LinearAccountRef,
  success: LinearTeamsResult,
  error: KanbanRpcError,
});
/** Replaces the project's link; tickets synced under another team or account are dropped. */
export const KanbanProjectLinkRpc = Rpc.make(KANBAN_WS_METHODS.kanbanProjectLink, {
  payload: KanbanProjectLinkInput,
  success: KanbanProjectLink,
  error: KanbanRpcError,
});
/** The project's synced tickets go with the link; its local tickets stay. */
export const KanbanProjectUnlinkRpc = Rpc.make(KANBAN_WS_METHODS.kanbanProjectUnlink, {
  payload: KanbanProjectRef,
  success: KanbanProjectRef,
  error: KanbanRpcError,
});
export const KanbanWorkspaceBotsRpc = Rpc.make(KANBAN_WS_METHODS.kanbanWorkspaceBots, {
  payload: KanbanWorkspaceBotsInput,
  success: KanbanWorkspaceBotsInput,
  error: KanbanRpcError,
});
export const KanbanTicketCreateRpc = Rpc.make(KANBAN_WS_METHODS.kanbanTicketCreate, {
  payload: KanbanTicketCreateInput,
  success: KanbanTicket,
  error: KanbanRpcError,
});
/** Moving a Linear ticket updates the issue in Linear first; a refusal there changes nothing. */
export const KanbanTicketMoveRpc = Rpc.make(KANBAN_WS_METHODS.kanbanTicketMove, {
  payload: KanbanTicketMoveInput,
  success: KanbanTicket,
  error: KanbanRpcError,
});
/** Local tickets only: a Linear issue is closed or archived in Linear. */
export const KanbanTicketDeleteRpc = Rpc.make(KANBAN_WS_METHODS.kanbanTicketDelete, {
  payload: KanbanTicketRef,
  success: KanbanTicketRef,
  error: KanbanRpcError,
});
export const KanbanTicketLinkThreadRpc = Rpc.make(KANBAN_WS_METHODS.kanbanTicketLinkThread, {
  payload: KanbanTicketThreadInput,
  success: KanbanTicket,
  error: KanbanRpcError,
});
export const KanbanTicketUnlinkThreadRpc = Rpc.make(KANBAN_WS_METHODS.kanbanTicketUnlinkThread, {
  payload: KanbanTicketThreadInput,
  success: KanbanTicket,
  error: KanbanRpcError,
});
/** Pulls Linear changes now instead of at the next poll. */
export const KanbanSyncRpc = Rpc.make(KANBAN_WS_METHODS.kanbanSync, {
  payload: KanbanSyncInput,
  success: KanbanSyncInput,
  error: KanbanRpcError,
});

/** Read on demand when the issue opens; Linear-backed for a synced ticket. */
export const KanbanTicketDetailRpc = Rpc.make(KANBAN_WS_METHODS.kanbanTicketDetail, {
  payload: KanbanTicketRef,
  success: KanbanTicketDetail,
  error: KanbanRpcError,
});
export const KanbanTicketUpdateRpc = Rpc.make(KANBAN_WS_METHODS.kanbanTicketUpdate, {
  payload: KanbanTicketUpdateInput,
  success: KanbanTicket,
  error: KanbanRpcError,
});
export const KanbanTicketCommentRpc = Rpc.make(KANBAN_WS_METHODS.kanbanTicketComment, {
  payload: KanbanTicketCommentInput,
  success: KanbanComment,
  error: KanbanRpcError,
});
export const KanbanTicketDeleteCommentRpc = Rpc.make(KANBAN_WS_METHODS.kanbanTicketDeleteComment, {
  payload: KanbanTicketCommentRef,
  success: KanbanTicketCommentRef,
  error: KanbanRpcError,
});
export const KanbanTicketStartThreadRpc = Rpc.make(KANBAN_WS_METHODS.kanbanTicketStartThread, {
  payload: KanbanTicketStartThreadInput,
  success: KanbanTicketStartThreadResult,
  error: KanbanRpcError,
});
export const KanbanViewSaveRpc = Rpc.make(KANBAN_WS_METHODS.kanbanViewSave, {
  payload: KanbanViewSaveInput,
  success: KanbanView,
  error: KanbanRpcError,
});
export const KanbanViewDeleteRpc = Rpc.make(KANBAN_WS_METHODS.kanbanViewDelete, {
  payload: KanbanViewRef,
  success: KanbanViewRef,
  error: KanbanRpcError,
});
export const KanbanViewReorderRpc = Rpc.make(KANBAN_WS_METHODS.kanbanViewReorder, {
  payload: KanbanViewReorderInput,
  success: KanbanViewReorderInput,
  error: KanbanRpcError,
});
/** Copies the account's Linear custom views whose filters T3 can express; never writes Linear. */
export const KanbanViewImportLinearRpc = Rpc.make(KANBAN_WS_METHODS.kanbanViewImportLinear, {
  payload: LinearAccountRef,
  success: KanbanViewImportResult,
  error: KanbanRpcError,
});
/** Local labels only; Linear labels are managed in Linear. */
export const KanbanLabelCreateRpc = Rpc.make(KANBAN_WS_METHODS.kanbanLabelCreate, {
  payload: KanbanLabelCreateInput,
  success: KanbanLabel,
  error: KanbanRpcError,
});
export const KanbanLabelDeleteRpc = Rpc.make(KANBAN_WS_METHODS.kanbanLabelDelete, {
  payload: KanbanLabelRef,
  success: KanbanLabelRef,
  error: KanbanRpcError,
});
export const KanbanAiFilterRpc = Rpc.make(KANBAN_WS_METHODS.kanbanAiFilter, {
  payload: KanbanAiFilterInput,
  success: KanbanAiFilterResult,
  error: KanbanRpcError,
});

export const KANBAN_RPCS = [
  KanbanSubscribeRpc,
  KanbanAccountAddRpc,
  KanbanAccountRenameRpc,
  KanbanAccountDeleteRpc,
  KanbanLinearTeamsRpc,
  KanbanProjectLinkRpc,
  KanbanProjectUnlinkRpc,
  KanbanWorkspaceBotsRpc,
  KanbanTicketCreateRpc,
  KanbanTicketMoveRpc,
  KanbanTicketDeleteRpc,
  KanbanTicketLinkThreadRpc,
  KanbanTicketUnlinkThreadRpc,
  KanbanSyncRpc,
  KanbanTicketDetailRpc,
  KanbanTicketUpdateRpc,
  KanbanTicketCommentRpc,
  KanbanTicketDeleteCommentRpc,
  KanbanTicketStartThreadRpc,
  KanbanViewSaveRpc,
  KanbanViewDeleteRpc,
  KanbanViewReorderRpc,
  KanbanViewImportLinearRpc,
  KanbanLabelCreateRpc,
  KanbanLabelDeleteRpc,
  KanbanAiFilterRpc,
] as const;

/**
 * The column a ticket sits in on a board that mixes teams (or Linear and local tickets): Linear
 * states fold into the local states by category. Linear has no review category, so a started
 * state named like a review ("In Review", "Em Revisão", "En revisión") counts as "In review". Canceled and duplicate tickets have no
 * column there.
 */
export function kanbanLocalStateOf(
  status: KanbanTicketStatus,
  statesById: ReadonlyMap<string, LinearWorkflowState>,
): KanbanLocalState | null {
  if (status.kind === "local") return status.state;
  const state = statesById.get(status.stateId);
  if (state === undefined) return null;
  switch (state.type) {
    case "triage":
    case "backlog":
      return "backlog";
    case "unstarted":
      return "todo";
    case "started":
      return /revi(ew|s)/i.test(state.name) ? "in_review" : "in_progress";
    case "completed":
      return "done";
    case "canceled":
    case "duplicate":
      return null;
  }
}

/**
 * A ticket's Linear category: a Linear state's type, or the category a local state stands for
 * (In progress and In review are both `started`).
 */
export function kanbanStateTypeOf(
  status: KanbanTicketStatus,
  statesById: ReadonlyMap<string, LinearWorkflowState>,
): LinearStateType | null {
  if (status.kind === "linear") return statesById.get(status.stateId)?.type ?? null;
  switch (status.state) {
    case "backlog":
      return "backlog";
    case "todo":
      return "unstarted";
    case "in_progress":
    case "in_review":
      return "started";
    case "done":
      return "completed";
  }
}
