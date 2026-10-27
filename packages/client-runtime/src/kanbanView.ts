/**
 * Kanban v2 views (friend fork), shared by web and mobile: which tickets a saved view's filters
 * keep, how they group into columns, list sections and swimlanes, their order, what dropping a
 * card on a group changes, and how a filter clause reads as a chip. Pure functions over the
 * snapshot; design in docs/friend/linear-kanban.md ("v2").
 */
import {
  KANBAN_LOCAL_STATE_LABELS,
  KANBAN_LOCAL_STATES,
  kanbanBotPersonId,
  kanbanLocalStateOf,
  kanbanStateTypeOf,
  LINEAR_STATE_TYPE_ORDER,
  linearWorkspaceId,
  LOCAL_KANBAN_WORKSPACE_ID,
  type KanbanCycle,
  type KanbanDateFilterField,
  type KanbanFilterClause,
  type KanbanFlagFilterField,
  type KanbanGrouping,
  type KanbanLocalState,
  type KanbanSetFilterField,
  type KanbanSnapshot,
  type KanbanTicket,
  type KanbanTicketPatch,
  type KanbanTicketStatus,
  type KanbanViewConfig,
  type LinearStateType,
  type LinearWorkflowState,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";

import {
  dropTarget,
  sameStatus,
  sortStates,
  THREAD_CARD_STATUS_LABELS,
  workspaceOf,
  type KanbanColumn,
  type ThreadCardStatus,
} from "./kanbanBoard.ts";

/** What a view needs beyond the snapshot. */
export interface KanbanViewContext {
  /** Epoch milliseconds, for date filters and "completed in the past week". */
  readonly now: number;
  /** A linked thread's status as the client sees it; null for a thread it does not know. */
  readonly threadStatus: (threadId: ThreadId) => ThreadCardStatus | null;
  /** Names the snapshot lacks: `owner` and `bot:<id>` people. Null falls back to the id. */
  readonly personName?: (personId: string) => string | null;
  /** A T3 project's title, for `t3Project` options and chips. Null falls back to the id. */
  readonly projectName?: (projectId: ProjectId) => string | null;
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

const DAY_MS = 86_400_000;
const CANCELED_GROUP_ID = "canceled";

/** Colors of the local columns (and the board of all projects' `canceled`), Linear's defaults. */
export const KANBAN_LOCAL_COLUMN_COLORS: Readonly<
  Record<KanbanLocalState | typeof CANCELED_GROUP_ID, string>
> = {
  backlog: "#bec2c8",
  todo: "#e2e2e2",
  in_progress: "#f2c94c",
  in_review: "#5e6ad2",
  done: "#4cb782",
  canceled: "#95a2b3",
};

const LOCAL_COLUMN_STATE_TYPES: Record<
  KanbanLocalState | typeof CANCELED_GROUP_ID,
  LinearStateType
> = {
  backlog: "backlog",
  todo: "unstarted",
  in_progress: "started",
  in_review: "started",
  done: "completed",
  canceled: "canceled",
};

const localColumnIcon = (column: KanbanLocalState | typeof CANCELED_GROUP_ID): KanbanGroupIcon => ({
  kind: "status",
  stateType: LOCAL_COLUMN_STATE_TYPES[column],
  color: KANBAN_LOCAL_COLUMN_COLORS[column],
});

const STATE_TYPE_LABELS: Record<LinearStateType, string> = {
  triage: "Triage",
  backlog: "Backlog",
  unstarted: "Unstarted",
  started: "Started",
  completed: "Completed",
  canceled: "Canceled",
  duplicate: "Duplicate",
};

const PULL_REQUEST_STATE_LABELS = {
  open: "Open",
  draft: "Draft",
  merged: "Merged",
  closed: "Closed",
} as const;

const PRIORITY_ORDER = [1, 2, 3, 4, 0] as const;

const statesByIdOf = (snapshot: KanbanSnapshot) =>
  new Map(snapshot.states.map((state) => [state.id, state]));

const isClosedType = (type: LinearStateType | null) =>
  type === "completed" || type === "canceled" || type === "duplicate";

const scopeTickets = (snapshot: KanbanSnapshot, projectId: ProjectId | null) =>
  projectId === null
    ? snapshot.tickets
    : snapshot.tickets.filter((ticket) => ticket.projectId === projectId);

const isCurrentCycle = (cycle: KanbanCycle, now: number) =>
  Date.parse(cycle.startsAt) <= now && now < Date.parse(cycle.endsAt);

const cycleTitle = (cycle: KanbanCycle) => cycle.name ?? `Cycle ${cycle.number}`;

const personNamer = (
  snapshot: KanbanSnapshot,
  context: Pick<KanbanViewContext, "personName"> | undefined,
) => {
  const people = new Map(snapshot.people.map((person) => [person.id, person.name]));
  return (personId: string) => people.get(personId) ?? context?.personName?.(personId) ?? personId;
};

/** The person ids "me" stands for: every account's own Linear user, and `owner`. */
export function kanbanMeIds(snapshot: KanbanSnapshot): ReadonlySet<string> {
  const ids = new Set<string>(["owner"]);
  for (const account of snapshot.accounts) if (account.userId !== null) ids.add(account.userId);
  return ids;
}

/**
 * The values a ticket has for a set field, as filter values. Status also carries the local
 * column a Linear state folds into (or `canceled`), so the all-projects columns filter too.
 */
function setValueReader(snapshot: KanbanSnapshot, context: KanbanViewContext) {
  const statesById = statesByIdOf(snapshot);
  const me = kanbanMeIds(snapshot);
  const cycles = new Map(snapshot.cycles.map((cycle) => [cycle.id, cycle]));
  const workspaceBots = new Map(
    snapshot.workspaces.map((workspace) => [workspace.id, workspace.botIds]),
  );
  // A local ticket on a linked project's board sits in the first state of its category.
  const linkedFirstOfCategory = new Map<string, Map<KanbanLocalState, string>>();
  for (const link of snapshot.links) {
    const firsts = new Map<KanbanLocalState, string>();
    for (const state of sortStates(snapshot.states.filter((s) => s.teamId === link.teamId))) {
      const category = kanbanLocalStateOf({ kind: "linear", stateId: state.id }, statesById);
      if (category !== null && !firsts.has(category)) firsts.set(category, state.id);
    }
    linkedFirstOfCategory.set(link.projectId, firsts);
  }
  const person = (id: string | null) => (id === null ? ["none"] : me.has(id) ? [id, "me"] : [id]);
  const orNone = (value: string | null) => [value ?? "none"];

  return (ticket: KanbanTicket, field: KanbanSetFilterField): ReadonlyArray<string> => {
    switch (field) {
      case "status": {
        if (ticket.status.kind === "local") {
          const folded = linkedFirstOfCategory.get(ticket.projectId)?.get(ticket.status.state);
          return folded === undefined ? [ticket.status.state] : [ticket.status.state, folded];
        }
        const column =
          kanbanLocalStateOf(ticket.status, statesById) ??
          (isClosedType(kanbanStateTypeOf(ticket.status, statesById)) ? CANCELED_GROUP_ID : null);
        return column === null ? [ticket.status.stateId] : [ticket.status.stateId, column];
      }
      case "statusType":
        return orNone(kanbanStateTypeOf(ticket.status, statesById));
      case "assignee":
        return person(ticket.assigneeId);
      case "creator":
        return person(ticket.creatorId);
      case "priority":
        return [String(ticket.priority)];
      case "label":
        return ticket.labelIds.length > 0 ? ticket.labelIds : ["none"];
      case "project":
        return orNone(ticket.linearProjectId);
      case "milestone":
        return orNone(ticket.milestoneId);
      case "cycle": {
        if (ticket.cycleId === null) return ["none"];
        const cycle = cycles.get(ticket.cycleId);
        return cycle !== undefined && isCurrentCycle(cycle, context.now)
          ? [ticket.cycleId, "current"]
          : [ticket.cycleId];
      }
      case "bot":
        return ticket.botId !== null
          ? [ticket.botId]
          : (workspaceBots.get(workspaceOf(snapshot, ticket)) ?? []);
      case "threadStatus": {
        const known = ticket.threadIds.flatMap((threadId) => context.threadStatus(threadId) ?? []);
        return known.length > 0 ? known : ["none"];
      }
      case "pullRequest":
        return ticket.pullRequests.length > 0
          ? ticket.pullRequests.map((pullRequest) => pullRequest.state)
          : ["none"];
      case "workspace":
        return [workspaceOf(snapshot, ticket)];
      case "account":
        return [ticket.linear?.accountId ?? "local"];
      case "t3Project":
        return [ticket.projectId];
    }
  };
}

function clauseMatcher(snapshot: KanbanSnapshot, context: KanbanViewContext) {
  const setValues = setValueReader(snapshot, context);
  const labelNames = new Map(snapshot.labels.map((label) => [label.id, label.name]));

  return (ticket: KanbanTicket, clause: KanbanFilterClause): boolean => {
    switch (clause.kind) {
      case "set": {
        const values = setValues(ticket, clause.field);
        const any = clause.values.some((value) => values.includes(value));
        return clause.op === "in" ? any : !any;
      }
      case "date": {
        const raw = ticket[clause.field];
        if (clause.op === "isSet") return raw !== null;
        if (clause.op === "isEmpty") return raw === null;
        if (raw === null) return false;
        const date = Date.parse(raw);
        switch (clause.op) {
          case "before":
            return date < Date.parse(String(clause.value));
          case "after":
            return date > Date.parse(String(clause.value));
          case "pastDays":
            return context.now - Number(clause.value) * DAY_MS <= date && date <= context.now;
          case "nextDays":
            return context.now <= date && date <= context.now + Number(clause.value) * DAY_MS;
        }
        return false;
      }
      case "flag": {
        const flags: Record<KanbanFlagFilterField, boolean> = {
          isSubIssue: ticket.parent !== null,
          hasSubIssues: (ticket.subIssues?.total ?? 0) > 0,
          hasThreads: ticket.threadIds.length > 0,
          hasPullRequests: ticket.pullRequests.length > 0,
          autoClosed: ticket.autoClosed,
          hasDueDate: ticket.dueDate !== null,
        };
        return flags[clause.field] === clause.value;
      }
      case "text": {
        const needle = clause.value.toLowerCase();
        return [
          ticket.identifier,
          ticket.title,
          ...ticket.labelIds.map((id) => labelNames.get(id) ?? ""),
        ].some((text) => text.toLowerCase().includes(needle));
      }
    }
  };
}

/** Whether one ticket satisfies one clause. */
export function ticketMatchesClause(
  snapshot: KanbanSnapshot,
  ticket: KanbanTicket,
  clause: KanbanFilterClause,
  context: KanbanViewContext,
): boolean {
  return clauseMatcher(snapshot, context)(ticket, clause);
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
  const tickets = scopeTickets(snapshot, projectId);
  const statesById = statesByIdOf(snapshot);
  const matches = clauseMatcher(snapshot, context);
  const scopeIssueIds = new Set(tickets.flatMap((ticket) => ticket.linear?.issueId ?? []));
  const windowDays =
    config.completed === "pastWeek" ? 7 : config.completed === "pastMonth" ? 30 : null;

  return tickets.filter((ticket) => {
    if (!config.showSubIssues && ticket.parent !== null && scopeIssueIds.has(ticket.parent.issueId))
      return false;
    if (config.completed !== "all" && isClosedType(kanbanStateTypeOf(ticket.status, statesById))) {
      if (windowDays === null) return false;
      if (Date.parse(ticket.closedAt ?? ticket.updatedAt) < context.now - windowDays * DAY_MS)
        return false;
    }
    return config.filters.every((clause) => matches(ticket, clause));
  });
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
  // Linear's 0 is "no priority"; it sorts after urgent (1) through low (4).
  const rank = (priority: number) => (priority === 0 ? 5 : priority);
  const byOrdering = (a: KanbanTicket, b: KanbanTicket) => {
    switch (config.orderBy) {
      case "priority":
        return rank(a.priority) - rank(b.priority) || b.updatedAt.localeCompare(a.updatedAt);
      case "updated":
        return b.updatedAt.localeCompare(a.updatedAt);
      case "created":
        return b.createdAt.localeCompare(a.createdAt);
      case "manual":
        return a.sortOrder - b.sortOrder;
      case "dueDate":
        return a.dueDate === null || b.dueDate === null
          ? Number(a.dueDate === null) - Number(b.dueDate === null)
          : a.dueDate.localeCompare(b.dueDate);
    }
  };
  return [...tickets].sort((a, b) => {
    if (config.completedByRecency && (a.closedAt !== null || b.closedAt !== null)) {
      if (a.closedAt === null) return -1;
      if (b.closedAt === null) return 1;
      return b.closedAt.localeCompare(a.closedAt) || a.identifier.localeCompare(b.identifier);
    }
    return byOrdering(a, b) || a.identifier.localeCompare(b.identifier);
  });
}

interface GroupDraft {
  readonly id: string;
  readonly title: string;
  readonly icon: KanbanGroupIcon;
  readonly tickets: KanbanTicket[];
}

const draft = (id: string, title: string, icon: KanbanGroupIcon): GroupDraft => ({
  id,
  title,
  icon,
  tickets: [],
});

/** A linked project's team states in board order; empty for any other scope. */
function linkedTeam(snapshot: KanbanSnapshot, projectId: ProjectId | null) {
  const link =
    projectId === null
      ? undefined
      : snapshot.links.find((candidate) => candidate.projectId === projectId);
  const states =
    link === undefined
      ? []
      : sortStates(snapshot.states.filter((state) => state.teamId === link.teamId));
  return { teamId: states.length > 0 && link !== undefined ? link.teamId : null, states };
}

/** Status columns of a scope, and the column a ticket sits in (undefined: none of them). */
function statusColumns(snapshot: KanbanSnapshot, projectId: ProjectId | null) {
  const statesById = statesByIdOf(snapshot);
  const team = linkedTeam(snapshot, projectId);
  if (team.teamId !== null) {
    const firstOfCategory = new Map<KanbanLocalState, string>();
    for (const state of team.states) {
      const category = kanbanLocalStateOf({ kind: "linear", stateId: state.id }, statesById);
      if (category !== null && !firstOfCategory.has(category)) {
        firstOfCategory.set(category, state.id);
      }
    }
    return {
      teamId: team.teamId,
      drafts: team.states.map((state) =>
        draft(state.id, state.name, { kind: "status", stateType: state.type, color: state.color }),
      ),
      columnOf: (ticket: KanbanTicket) =>
        ticket.status.kind === "linear"
          ? ticket.status.stateId
          : firstOfCategory.get(ticket.status.state),
    };
  }
  return {
    teamId: null,
    drafts: [
      ...KANBAN_LOCAL_STATES.map((state) =>
        draft(state, KANBAN_LOCAL_STATE_LABELS[state], localColumnIcon(state)),
      ),
      draft(CANCELED_GROUP_ID, "Canceled", localColumnIcon(CANCELED_GROUP_ID)),
    ],
    columnOf: (ticket: KanbanTicket) =>
      kanbanLocalStateOf(ticket.status, statesById) ??
      (isClosedType(kanbanStateTypeOf(ticket.status, statesById)) ? CANCELED_GROUP_ID : undefined),
  };
}

function fillFixed(
  drafts: ReadonlyArray<GroupDraft>,
  tickets: ReadonlyArray<KanbanTicket>,
  columnOf: (ticket: KanbanTicket) => string | undefined,
): ReadonlyArray<KanbanGroup> {
  const byId = new Map(drafts.map((group) => [group.id, group]));
  for (const ticket of tickets) {
    const id = columnOf(ticket);
    if (id !== undefined) byId.get(id)?.tickets.push(ticket);
  }
  return drafts;
}

/** One group per value present, by title, then `none`. */
function fillByValue(
  tickets: ReadonlyArray<KanbanTicket>,
  valuesOf: (ticket: KanbanTicket) => ReadonlyArray<string>,
  describe: (id: string) => Pick<KanbanGroup, "title" | "icon">,
  none: GroupDraft,
): ReadonlyArray<KanbanGroup> {
  const byId = new Map<string, GroupDraft>();
  for (const ticket of tickets) {
    const values = valuesOf(ticket);
    if (values.length === 0) none.tickets.push(ticket);
    for (const id of values) {
      let group = byId.get(id);
      if (group === undefined) {
        const { title, icon } = describe(id);
        group = draft(id, title, icon);
        byId.set(id, group);
      }
      group.tickets.push(ticket);
    }
  }
  return [
    ...[...byId.values()].sort(
      (a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id),
    ),
    none,
  ];
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
  context?: Pick<KanbanViewContext, "personName">,
): ReadonlyArray<KanbanGroup> {
  switch (grouping) {
    case "status": {
      const { drafts, columnOf } = statusColumns(snapshot, projectId);
      return fillFixed(drafts, tickets, columnOf);
    }
    case "priority":
      return fillFixed(
        PRIORITY_ORDER.map((priority) =>
          draft(String(priority), KANBAN_PRIORITY_LABELS[priority], { kind: "priority", priority }),
        ),
        tickets,
        (ticket) => String(ticket.priority),
      );
    case "none":
      return [{ id: "all", title: "All issues", icon: { kind: "none" }, tickets }];
    case "assignee": {
      const nameOf = personNamer(snapshot, context);
      return fillByValue(
        tickets,
        (ticket) => (ticket.assigneeId === null ? [] : [ticket.assigneeId]),
        (id) => ({ title: nameOf(id), icon: { kind: "person", personId: id } }),
        draft("none", "No assignee", { kind: "person", personId: null }),
      );
    }
    case "label": {
      const labels = new Map(snapshot.labels.map((label) => [label.id, label]));
      return fillByValue(
        tickets,
        (ticket) => ticket.labelIds,
        (id) => {
          const label = labels.get(id);
          return { title: label?.name ?? id, icon: { kind: "label", color: label?.color ?? null } };
        },
        draft("none", "No labels", { kind: "label", color: null }),
      );
    }
    case "project": {
      const projects = new Map(snapshot.linearProjects.map((project) => [project.id, project]));
      return fillByValue(
        tickets,
        (ticket) => (ticket.linearProjectId === null ? [] : [ticket.linearProjectId]),
        (id) => {
          const project = projects.get(id);
          return {
            title: project?.name ?? id,
            icon: { kind: "project", color: project?.color ?? null, icon: project?.icon ?? null },
          };
        },
        draft("none", "No project", { kind: "project", color: null, icon: null }),
      );
    }
    case "cycle": {
      const cycles = new Map(snapshot.cycles.map((cycle) => [cycle.id, cycle]));
      return fillByValue(
        tickets,
        (ticket) => (ticket.cycleId === null ? [] : [ticket.cycleId]),
        (id) => {
          const cycle = cycles.get(id);
          return { title: cycle === undefined ? id : cycleTitle(cycle), icon: { kind: "cycle" } };
        },
        draft("none", "No cycle", { kind: "cycle" }),
      );
    }
  }
}

/** The whole view: filter, sort, columns (shown and hidden) and swimlanes. */
export function buildKanbanView(
  snapshot: KanbanSnapshot,
  projectId: ProjectId | null,
  config: KanbanViewConfig,
  context: KanbanViewContext,
): KanbanViewResult {
  const tickets = sortViewTickets(viewTickets(snapshot, projectId, config, context), config);
  const groups = groupTickets(snapshot, projectId, config.groupBy, tickets, context);
  const userHidden = new Set(config.hiddenColumns);
  const isHidden = (group: KanbanGroup) =>
    userHidden.has(group.id) || (!config.showEmptyColumns && group.tickets.length === 0);
  const columns = groups.filter((group) => !isHidden(group));

  let swimlanes: ReadonlyArray<KanbanSwimlane> | null = null;
  if (config.subGroupBy !== "none") {
    const columnsOfTicket = new Map<string, string[]>();
    for (const column of columns) {
      for (const ticket of column.tickets) {
        const ids = columnsOfTicket.get(ticket.id);
        if (ids === undefined) columnsOfTicket.set(ticket.id, [column.id]);
        else ids.push(column.id);
      }
    }
    swimlanes = groupTickets(snapshot, projectId, config.subGroupBy, tickets, context).flatMap(
      (lane) => {
        const cells = new Map<string, KanbanTicket[]>();
        for (const ticket of lane.tickets) {
          for (const columnId of columnsOfTicket.get(ticket.id) ?? []) {
            const cell = cells.get(columnId);
            if (cell === undefined) cells.set(columnId, [ticket]);
            else cell.push(ticket);
          }
        }
        return cells.size > 0 ? [{ ...lane, cells }] : [];
      },
    );
  }

  return {
    teamId: linkedTeam(snapshot, projectId).teamId,
    columns,
    hiddenColumns: groups.filter(isHidden),
    swimlanes,
    total: tickets.length,
  };
}

function statusDropColumn(
  statesById: ReadonlyMap<string, LinearWorkflowState>,
  groupId: string,
): KanbanColumn | null {
  const state = statesById.get(groupId);
  if (state !== undefined) {
    return {
      kind: "linear",
      id: state.id,
      title: state.name,
      color: state.color,
      state,
      tickets: [],
    };
  }
  const local = KANBAN_LOCAL_STATES.find((candidate) => candidate === groupId);
  return local === undefined
    ? null
    : { kind: "local", id: local, title: local, color: null, state: local, tickets: [] };
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
  const value = group.id === "none" ? null : group.id;
  const update = (patch: KanbanTicketPatch): KanbanDropAction => ({ kind: "update", patch });
  const linear = ticket.linear;
  const organizationId =
    linear === null
      ? undefined
      : snapshot.accounts.find((account) => account.id === linear.accountId)?.organizationId;

  switch (grouping) {
    case "none":
      return null;
    case "status": {
      // Several states can fold into one column; dropping where it already sits is no move.
      if (group.tickets.some((candidate) => candidate.id === ticket.id)) return null;
      const statesById = statesByIdOf(snapshot);
      const column = statusDropColumn(statesById, group.id);
      if (column !== null) {
        const to = dropTarget(snapshot, ticket, column);
        return to === null || sameStatus(to, ticket.status) ? null : { kind: "move", to };
      }
      if (group.id !== CANCELED_GROUP_ID || linear === null) return null;
      const type = kanbanStateTypeOf(ticket.status, statesById);
      if (type === "canceled" || type === "duplicate") return null;
      const target = sortStates(
        snapshot.states.filter((state) => state.teamId === linear.teamId),
      ).find((state) => state.type === "canceled");
      return target === undefined
        ? null
        : { kind: "move", to: { kind: "linear", stateId: target.id } };
    }
    case "assignee": {
      if (value === ticket.assigneeId) return null;
      if (value !== null) {
        const fits =
          linear === null
            ? value === "owner" || value.startsWith("bot:")
            : snapshot.people.some(
                (person) => person.id === value && person.organizationId === organizationId,
              );
        if (!fits) return null;
      }
      return update({ assigneeId: value });
    }
    case "priority": {
      const priority = Number(group.id);
      return Number.isInteger(priority) &&
        priority >= 0 &&
        priority <= 4 &&
        priority !== ticket.priority
        ? update({ priority })
        : null;
    }
    case "label": {
      if (value === null) return ticket.labelIds.length > 0 ? update({ labelIds: [] }) : null;
      if (ticket.labelIds.includes(value)) return null;
      const label = snapshot.labels.find((candidate) => candidate.id === value);
      if (label === undefined) return null;
      const usable =
        linear === null
          ? label.source === "local"
          : label.source === "linear" &&
            organizationId !== undefined &&
            label.workspaceId === linearWorkspaceId(organizationId) &&
            (label.teamId === null || label.teamId === linear.teamId);
      return usable ? update({ labelIds: [...ticket.labelIds, value] }) : null;
    }
    case "project": {
      if (linear === null || value === ticket.linearProjectId) return null;
      if (
        value !== null &&
        !snapshot.linearProjects.some(
          (project) => project.id === value && project.organizationId === organizationId,
        )
      )
        return null;
      return update({ linearProjectId: value });
    }
    case "cycle": {
      if (linear === null || value === ticket.cycleId) return null;
      if (
        value !== null &&
        !snapshot.cycles.some((cycle) => cycle.id === value && cycle.teamId === linear.teamId)
      )
        return null;
      return update({ cycleId: value });
    }
  }
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

type OptionDraft = Omit<KanbanFilterOption, "count">;

/** The Linear organizations and teams a scope reaches, and whether it holds local tickets. */
function scopeReach(
  snapshot: KanbanSnapshot,
  projectId: ProjectId | null,
  tickets: ReadonlyArray<KanbanTicket>,
) {
  const organizationOf = new Map<string, string>(
    snapshot.accounts.map((account) => [account.id, account.organizationId]),
  );
  const organizations = new Set<string>();
  const teams = new Set<string>();
  const reach = (accountId: string, teamId: string) => {
    const organizationId = organizationOf.get(accountId);
    if (organizationId !== undefined) organizations.add(organizationId);
    teams.add(teamId);
  };
  const links =
    projectId === null
      ? snapshot.links
      : snapshot.links.filter((link) => link.projectId === projectId);
  for (const link of links) reach(link.accountId, link.teamId);
  for (const ticket of tickets)
    if (ticket.linear) reach(ticket.linear.accountId, ticket.linear.teamId);
  if (projectId === null)
    for (const organizationId of organizationOf.values()) organizations.add(organizationId);
  const local =
    projectId === null || links.length === 0 || tickets.some((ticket) => ticket.linear === null);
  return { organizations, teams, local };
}

function setFieldOptions(
  snapshot: KanbanSnapshot,
  projectId: ProjectId | null,
  field: KanbanSetFilterField,
  tickets: ReadonlyArray<KanbanTicket>,
  context: Pick<KanbanViewContext, "personName" | "projectName"> | undefined,
): ReadonlyArray<OptionDraft> {
  const none: OptionDraft = { value: "none", label: "None", icon: { kind: "none" } };
  const { organizations, teams, local } = scopeReach(snapshot, projectId, tickets);
  const projectsInScope = snapshot.linearProjects.filter((project) =>
    organizations.has(project.organizationId),
  );

  switch (field) {
    case "status":
      return statusColumns(snapshot, projectId).drafts.map((group) => ({
        value: group.id,
        label: group.title,
        icon: group.icon,
      }));
    case "statusType":
      return LINEAR_STATE_TYPE_ORDER.map((type) => ({
        value: type,
        label: STATE_TYPE_LABELS[type],
        icon: { kind: "none" },
      }));
    case "assignee":
    case "creator": {
      const nameOf = personNamer(snapshot, context);
      const ids = new Set(
        snapshot.people
          .filter((person) => organizations.has(person.organizationId))
          .map((person) => person.id),
      );
      for (const ticket of tickets) {
        const id = field === "assignee" ? ticket.assigneeId : ticket.creatorId;
        if (id === "owner" || id?.startsWith("bot:")) ids.add(id);
      }
      const people = [...ids]
        .map((id): OptionDraft => ({
          value: id,
          label: nameOf(id),
          icon: { kind: "person", personId: id },
        }))
        .sort((a, b) => a.label.localeCompare(b.label) || a.value.localeCompare(b.value));
      return [
        { value: "me", label: "Me", icon: { kind: "person", personId: null } },
        ...people,
        { ...none, icon: { kind: "person", personId: null } },
      ];
    }
    case "priority":
      return PRIORITY_ORDER.map((priority) => ({
        value: String(priority),
        label: KANBAN_PRIORITY_LABELS[priority],
        icon: { kind: "priority", priority },
      }));
    case "label": {
      const workspaces = new Set([...organizations].map(linearWorkspaceId));
      const labels = snapshot.labels.filter((label) =>
        label.source === "local"
          ? local
          : workspaces.has(label.workspaceId) && (label.teamId === null || teams.has(label.teamId)),
      );
      return [
        ...labels.map((label): OptionDraft => ({
          value: label.id,
          label: label.name,
          icon: { kind: "label", color: label.color },
        })),
        none,
      ];
    }
    case "project":
      return [
        ...projectsInScope.map((project): OptionDraft => ({
          value: project.id,
          label: project.name,
          icon: { kind: "project", color: project.color, icon: project.icon },
        })),
        none,
      ];
    case "milestone": {
      const projectIds = new Set(projectsInScope.map((project) => project.id));
      return [
        ...snapshot.milestones
          .filter((milestone) => projectIds.has(milestone.projectId))
          .map((milestone): OptionDraft => ({
            value: milestone.id,
            label: milestone.name,
            icon: { kind: "none" },
          })),
        none,
      ];
    }
    case "cycle":
      return [
        { value: "current", label: "Current cycle", icon: { kind: "cycle" } },
        ...snapshot.cycles
          .filter((cycle) => teams.has(cycle.teamId))
          .map((cycle): OptionDraft => ({
            value: cycle.id,
            label: cycleTitle(cycle),
            icon: { kind: "cycle" },
          })),
        none,
      ];
    case "bot": {
      const reached = snapshot.workspaces.filter((workspace) =>
        workspace.id === LOCAL_KANBAN_WORKSPACE_ID
          ? local
          : organizations.has(workspace.id.slice("linear:".length)),
      );
      const botIds = new Set<string>(reached.flatMap((workspace) => workspace.botIds));
      for (const ticket of tickets) if (ticket.botId !== null) botIds.add(ticket.botId);
      return [...botIds].map((botId) => {
        const personId = kanbanBotPersonId(botId);
        return {
          value: botId,
          label: context?.personName?.(personId) ?? botId,
          icon: { kind: "person", personId },
        };
      });
    }
    case "threadStatus":
      return [
        ...Object.entries(THREAD_CARD_STATUS_LABELS).map(([value, label]): OptionDraft => ({
          value,
          label,
          icon: { kind: "none" },
        })),
        none,
      ];
    case "pullRequest":
      return [
        ...Object.entries(PULL_REQUEST_STATE_LABELS).map(([value, label]): OptionDraft => ({
          value,
          label,
          icon: { kind: "none" },
        })),
        none,
      ];
    case "workspace":
      return snapshot.workspaces.map((workspace) => ({
        value: workspace.id,
        label: workspace.name,
        icon: { kind: "none" },
      }));
    case "account":
      return [
        ...snapshot.accounts.map((account): OptionDraft => ({
          value: account.id,
          label: account.name,
          icon: { kind: "none" },
        })),
        { value: "local", label: "Local", icon: { kind: "none" } },
      ];
    case "t3Project":
      return [
        ...new Set([
          ...snapshot.links.map((link) => link.projectId),
          ...snapshot.tickets.map((ticket) => ticket.projectId),
        ]),
      ].map((id) => ({
        value: id,
        label: context?.projectName?.(id) ?? id,
        icon: { kind: "none" },
      }));
  }
}

/**
 * The values a set field offers on a board scope, restricted to what that scope can hold:
 * `me` first and `none` last where they apply. Counts need `now` (current cycle) and
 * `threadStatus` from the context; without them those counts read as none.
 */
export function filterOptions(
  snapshot: KanbanSnapshot,
  projectId: ProjectId | null,
  field: KanbanSetFilterField,
  context?: Partial<KanbanViewContext>,
): ReadonlyArray<KanbanFilterOption> {
  const tickets = scopeTickets(snapshot, projectId);
  const options = setFieldOptions(snapshot, projectId, field, tickets, context);
  const counts = new Map(options.map((option) => [option.value, 0]));
  const valuesOf = setValueReader(snapshot, {
    now: context?.now ?? 0,
    threadStatus: context?.threadStatus ?? (() => null),
  });
  for (const ticket of tickets) {
    for (const value of new Set(valuesOf(ticket, field))) {
      const count = counts.get(value);
      if (count !== undefined) counts.set(value, count + 1);
    }
  }
  return options.map((option) => ({ ...option, count: counts.get(option.value) ?? 0 }));
}

const DATE_OP_LABELS = {
  before: "before",
  after: "after",
  pastDays: "in the past",
  nextDays: "in the next",
  isSet: "is set",
  isEmpty: "is empty",
} as const;

/** A clause as a chip: "Assignee" "is" "Israel", "Priority" "is any of" "Urgent, High". */
export function describeClause(
  snapshot: KanbanSnapshot,
  clause: KanbanFilterClause,
  context?: Pick<KanbanViewContext, "personName" | "projectName">,
): { readonly field: string; readonly op: string; readonly value: string } {
  const field = KANBAN_FILTER_FIELD_LABELS[clause.field];
  switch (clause.kind) {
    case "text":
      return { field, op: "contains", value: clause.value };
    case "flag":
      return { field, op: "is", value: clause.value ? "Yes" : "No" };
    case "date": {
      const value =
        clause.op === "isSet" || clause.op === "isEmpty"
          ? ""
          : clause.op === "pastDays" || clause.op === "nextDays"
            ? `${clause.value} days`
            : String(clause.value ?? "");
      return { field, op: DATE_OP_LABELS[clause.op], value };
    }
    case "set": {
      const labels = new Map(
        setFieldOptions(snapshot, null, clause.field, snapshot.tickets, context).map((option) => [
          option.value,
          option.label,
        ]),
      );
      if (clause.field === "status") {
        for (const state of snapshot.states) labels.set(state.id, state.name);
      }
      const many = clause.values.length > 1;
      const op =
        clause.op === "in" ? (many ? "is any of" : "is") : many ? "is not any of" : "is not";
      const value = clause.values
        .map((value) =>
          value === "me" ? "Me" : value === "none" ? "None" : (labels.get(value) ?? value),
        )
        .join(", ");
      return { field, op, value };
    }
  }
}

/** Linear's priority names, by Linear's number (0 none, 1 urgent … 4 low). */
export const KANBAN_PRIORITY_LABELS = ["No priority", "Urgent", "High", "Medium", "Low"] as const;
