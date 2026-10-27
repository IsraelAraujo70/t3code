/**
 * Kanban v2 views (friend fork), shared by web and mobile: which tickets a saved view's filters
 * keep, how they group into columns, list sections and swimlanes, their order, what dropping a
 * card on a group changes, and how a filter clause reads as a chip. Pure functions over the
 * snapshot; design in docs/friend/linear-kanban.md ("v2").
 */
import type {
  KanbanDateFilterField,
  KanbanFilterClause,
  KanbanFlagFilterField,
  KanbanGrouping,
  KanbanSetFilterField,
  KanbanSnapshot,
  KanbanTicket,
  KanbanTicketPatch,
  KanbanTicketStatus,
  KanbanViewConfig,
  LinearStateType,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";

import type { ThreadCardStatus } from "./kanbanBoard.ts";

/** What a view needs beyond the snapshot. */
export interface KanbanViewContext {
  /** Epoch milliseconds, for date filters and "completed in the past week". */
  readonly now: number;
  /** A linked thread's status as the client sees it; null for a thread it does not know. */
  readonly threadStatus: (threadId: ThreadId) => ThreadCardStatus | null;
  /** Names the snapshot lacks: `owner` and `bot:<id>` people. Null falls back to the id. */
  readonly personName?: (personId: string) => string | null;
}

/** How a group draws its leading icon. */
export type KanbanGroupIcon =
  | {
      readonly kind: "status";
      readonly stateType: LinearStateType;
      readonly color: string;
    }
  | { readonly kind: "person"; readonly personId: string | null }
  | { readonly kind: "priority"; readonly priority: number }
  | { readonly kind: "label"; readonly color: string | null }
  | { readonly kind: "project"; readonly color: string | null; readonly icon: string | null }
  | { readonly kind: "cycle" }
  | { readonly kind: "none" };

/** One column (board), section (list) or swimlane. */
export interface KanbanGroup {
  /**
   * Stable within a grouping: a state id or local state for status, a person id, "0".."4", a
   * label/project/cycle id, or `none` for the tickets without one. `all` when grouping is `none`.
   */
  readonly id: string;
  readonly title: string;
  readonly icon: KanbanGroupIcon;
  readonly tickets: ReadonlyArray<KanbanTicket>;
}

export interface KanbanSwimlane extends KanbanGroup {
  /** The lane's tickets by column id; a column absent here is empty in this lane. */
  readonly cells: ReadonlyMap<string, ReadonlyArray<KanbanTicket>>;
}

export interface KanbanViewResult {
  /** The team whose workflow status columns follow; null on a board of local states. */
  readonly teamId: string | null;
  /** Columns shown, in board order. */
  readonly columns: ReadonlyArray<KanbanGroup>;
  /** Empty columns (when the view hides them) and columns the user hid, in board order. */
  readonly hiddenColumns: ReadonlyArray<KanbanGroup>;
  /** Swimlanes when `subGroupBy` is not `none`; null otherwise. */
  readonly swimlanes: ReadonlyArray<KanbanSwimlane> | null;
  /** Tickets the view keeps, in all columns, hidden ones included. */
  readonly total: number;
}

/** What dropping a ticket on a group does. */
export type KanbanDropAction =
  | { readonly kind: "move"; readonly to: KanbanTicketStatus }
  | { readonly kind: "update"; readonly patch: KanbanTicketPatch };

/** The person ids "me" stands for: every account's own Linear user, and `owner`. */
export function kanbanMeIds(snapshot: KanbanSnapshot): ReadonlySet<string> {
  void snapshot;
  throw new Error("kanbanMeIds: not implemented");
}

/** Whether one ticket satisfies one clause. */
export function ticketMatchesClause(
  snapshot: KanbanSnapshot,
  ticket: KanbanTicket,
  clause: KanbanFilterClause,
  context: KanbanViewContext,
): boolean {
  void snapshot;
  void ticket;
  void clause;
  void context;
  throw new Error("ticketMatchesClause: not implemented");
}

/**
 * The tickets of a board scope (one project, or every project when null) that a view keeps:
 * every clause, the `completed` window (closed tickets older than it go), and `showSubIssues`
 * (false drops sub-issues whose parent is on the board).
 */
export function viewTickets(
  snapshot: KanbanSnapshot,
  projectId: ProjectId | null,
  config: KanbanViewConfig,
  context: KanbanViewContext,
): ReadonlyArray<KanbanTicket> {
  void snapshot;
  void projectId;
  void config;
  void context;
  throw new Error("viewTickets: not implemented");
}

/**
 * The view's order: `priority` (urgent first, none last, then newest update), `updated`,
 * `created` (newest first), `manual` (sortOrder), `dueDate` (soonest first, none last). With
 * `completedByRecency`, closed tickets come after open ones, newest closed first.
 */
export function sortViewTickets(
  tickets: ReadonlyArray<KanbanTicket>,
  config: Pick<KanbanViewConfig, "orderBy" | "completedByRecency">,
): ReadonlyArray<KanbanTicket> {
  void tickets;
  void config;
  throw new Error("sortViewTickets: not implemented");
}

/**
 * Groups for one grouping, in display order, including empty ones. Status: a linked project's
 * team states (its local tickets in the first state of their category); any other scope the five
 * local states plus `canceled` (Linear canceled and duplicate tickets). Priority: urgent … low,
 * then none. Assignee/label/project/cycle: the values present plus `none`, by name.
 */
export function groupTickets(
  snapshot: KanbanSnapshot,
  projectId: ProjectId | null,
  grouping: KanbanGrouping,
  tickets: ReadonlyArray<KanbanTicket>,
): ReadonlyArray<KanbanGroup> {
  void snapshot;
  void projectId;
  void grouping;
  void tickets;
  throw new Error("groupTickets: not implemented");
}

/** The whole view: filter, sort, columns (shown and hidden) and swimlanes. */
export function buildKanbanView(
  snapshot: KanbanSnapshot,
  projectId: ProjectId | null,
  config: KanbanViewConfig,
  context: KanbanViewContext,
): KanbanViewResult {
  void snapshot;
  void projectId;
  void config;
  void context;
  throw new Error("buildKanbanView: not implemented");
}

/**
 * What dropping `ticket` on a group of `grouping` does, or null when it cannot go there (a
 * Linear ticket on another team's state, a local ticket on `canceled`, a Linear ticket given a
 * local label, or the group it is already in). Labels: dropping adds that label (and on `none`
 * clears them).
 */
export function dropActionFor(
  snapshot: KanbanSnapshot,
  ticket: KanbanTicket,
  grouping: KanbanGrouping,
  group: KanbanGroup,
): KanbanDropAction | null {
  void snapshot;
  void ticket;
  void grouping;
  void group;
  throw new Error("dropActionFor: not implemented");
}

/** Filter menu field names, in the menu's order. */
export const KANBAN_FILTER_FIELD_LABELS: Readonly<
  Record<KanbanSetFilterField | KanbanDateFilterField | KanbanFlagFilterField | "content", string>
> = {
  status: "Status",
  statusType: "Status type",
  assignee: "Assignee",
  creator: "Creator",
  priority: "Priority",
  label: "Labels",
  project: "Project",
  milestone: "Milestone",
  cycle: "Cycle",
  bot: "Responsible bot",
  threadStatus: "Thread status",
  pullRequest: "Pull requests",
  workspace: "Workspace",
  account: "Linear account",
  t3Project: "T3 project",
  createdAt: "Created",
  updatedAt: "Updated",
  dueDate: "Due date",
  closedAt: "Completed",
  isSubIssue: "Is sub-issue",
  hasSubIssues: "Has sub-issues",
  hasThreads: "Has linked thread",
  hasPullRequests: "Has pull request",
  autoClosed: "Auto-closed",
  hasDueDate: "Has due date",
  content: "Content",
};

/** One choice in a set filter's value menu. */
export interface KanbanFilterOption {
  readonly value: string;
  readonly label: string;
  readonly icon: KanbanGroupIcon;
  /** Tickets in the scope with this value, before the view's filters. */
  readonly count: number;
}

/**
 * The values a set field offers on a board scope: the snapshot's states, people (with `me` and
 * `none` first), labels, projects… restricted to what that scope can hold.
 */
export function filterOptions(
  snapshot: KanbanSnapshot,
  projectId: ProjectId | null,
  field: KanbanSetFilterField,
): ReadonlyArray<KanbanFilterOption> {
  void snapshot;
  void projectId;
  void field;
  throw new Error("filterOptions: not implemented");
}

/** A clause as a chip: "Assignee" "is" "Israel", "Priority" "is any of" "Urgent, High". */
export function describeClause(
  snapshot: KanbanSnapshot,
  clause: KanbanFilterClause,
): { readonly field: string; readonly op: string; readonly value: string } {
  void snapshot;
  void clause;
  throw new Error("describeClause: not implemented");
}

/** Linear's priority names, by Linear's number (0 none, 1 urgent … 4 low). */
export const KANBAN_PRIORITY_LABELS = ["No priority", "Urgent", "High", "Medium", "Low"] as const;
