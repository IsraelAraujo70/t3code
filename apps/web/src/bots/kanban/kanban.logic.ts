import { isThreadWorking } from "@t3tools/client-runtime/state/thread-inbox";
import type { BotThreadShell } from "@t3tools/client-runtime/bot-directory";
import {
  KANBAN_LOCAL_STATE_LABELS,
  KANBAN_LOCAL_STATES,
  kanbanLocalStateOf,
  LINEAR_STATE_TYPE_ORDER,
  LOCAL_KANBAN_WORKSPACE_ID,
  linearWorkspaceId,
  type KanbanLocalState,
  type KanbanSnapshot,
  type KanbanTicket,
  type KanbanTicketStatus,
  type KanbanWorkspaceId,
  type LinearAccountId,
  type LinearWorkflowState,
  type ProjectId,
} from "@t3tools/contracts";

/** What the board shows; null in a field means "all". */
export interface KanbanFilter {
  readonly projectId: ProjectId | null;
  readonly workspaceId: KanbanWorkspaceId | null;
  readonly accountId: LinearAccountId | null;
}

/**
 * A board column. On a linked project's board the columns are its team's workflow states
 * (`state`); everywhere else they are the five local states (`local`), with Linear tickets folded
 * in by category.
 */
export type KanbanColumn =
  | {
      readonly kind: "linear";
      readonly id: string;
      readonly title: string;
      readonly color: string;
      readonly state: LinearWorkflowState;
      readonly tickets: ReadonlyArray<KanbanTicket>;
    }
  | {
      readonly kind: "local";
      readonly id: string;
      readonly title: string;
      readonly color: null;
      readonly state: KanbanLocalState;
      readonly tickets: ReadonlyArray<KanbanTicket>;
    };

export interface KanbanBoard {
  /** The team whose workflow the columns follow; null on a board of local states. */
  readonly teamId: string | null;
  readonly columns: ReadonlyArray<KanbanColumn>;
}

export function workspaceOf(snapshot: KanbanSnapshot, ticket: KanbanTicket): KanbanWorkspaceId {
  if (ticket.linear === null) return LOCAL_KANBAN_WORKSPACE_ID;
  const linear = ticket.linear;
  const account = snapshot.accounts.find((candidate) => candidate.id === linear.accountId);
  return account === undefined
    ? LOCAL_KANBAN_WORKSPACE_ID
    : linearWorkspaceId(account.organizationId);
}

export function filterTickets(
  snapshot: KanbanSnapshot,
  filter: KanbanFilter,
): ReadonlyArray<KanbanTicket> {
  return snapshot.tickets.filter(
    (ticket) =>
      (filter.projectId === null || ticket.projectId === filter.projectId) &&
      (filter.workspaceId === null || workspaceOf(snapshot, ticket) === filter.workspaceId) &&
      (filter.accountId === null || ticket.linear?.accountId === filter.accountId),
  );
}

/** Board order: Linear's categories in workflow order, then `position` within one. */
export function sortStates(
  states: ReadonlyArray<LinearWorkflowState>,
): ReadonlyArray<LinearWorkflowState> {
  return [...states].sort(
    (a, b) =>
      LINEAR_STATE_TYPE_ORDER.indexOf(a.type) - LINEAR_STATE_TYPE_ORDER.indexOf(b.type) ||
      a.position - b.position,
  );
}

const byPriorityThenUpdate = (a: KanbanTicket, b: KanbanTicket) => {
  // Linear's 0 is "no priority"; it sorts after urgent (1) through low (4).
  const rank = (priority: number) => (priority === 0 ? 5 : priority);
  return rank(a.priority) - rank(b.priority) || b.updatedAt.localeCompare(a.updatedAt);
};

/**
 * The columns of the filtered board. A board narrowed to one linked project follows that
 * project's team; its local tickets (from before the link) sit in the first state of their
 * category.
 */
export function buildBoard(snapshot: KanbanSnapshot, filter: KanbanFilter): KanbanBoard {
  const tickets = [...filterTickets(snapshot, filter)].sort(byPriorityThenUpdate);
  const statesById = new Map(snapshot.states.map((state) => [state.id, state]));
  const link =
    filter.projectId === null
      ? undefined
      : snapshot.links.find((candidate) => candidate.projectId === filter.projectId);
  const teamStates = link
    ? sortStates(snapshot.states.filter((state) => state.teamId === link.teamId))
    : [];

  if (link !== undefined && teamStates.length > 0) {
    const firstOfCategory = new Map<KanbanLocalState, string>();
    for (const state of teamStates) {
      const category = kanbanLocalStateOf({ kind: "linear", stateId: state.id }, statesById);
      if (category !== null && !firstOfCategory.has(category)) {
        firstOfCategory.set(category, state.id);
      }
    }
    const columnOf = (ticket: KanbanTicket) =>
      ticket.status.kind === "linear"
        ? ticket.status.stateId
        : firstOfCategory.get(ticket.status.state);
    return {
      teamId: link.teamId,
      columns: teamStates.map((state) => ({
        kind: "linear",
        id: state.id,
        title: state.name,
        color: state.color,
        state,
        tickets: tickets.filter((ticket) => columnOf(ticket) === state.id),
      })),
    };
  }

  return {
    teamId: null,
    columns: KANBAN_LOCAL_STATES.map((state) => ({
      kind: "local",
      id: state,
      title: KANBAN_LOCAL_STATE_LABELS[state],
      color: null,
      state,
      tickets: tickets.filter((ticket) => kanbanLocalStateOf(ticket.status, statesById) === state),
    })),
  };
}

/**
 * The status a ticket takes when dropped on a column, or null when the column has no place for
 * it (a Linear ticket on a board of another team, or a category its team lacks). A Linear ticket
 * dropped on a local column moves to the first state of that category in its own team.
 */
export function dropTarget(
  snapshot: KanbanSnapshot,
  ticket: KanbanTicket,
  column: KanbanColumn,
): KanbanTicketStatus | null {
  const statesById = new Map(snapshot.states.map((state) => [state.id, state]));
  const category =
    column.kind === "local"
      ? column.state
      : kanbanLocalStateOf({ kind: "linear", stateId: column.state.id }, statesById);
  if (ticket.linear === null) {
    return category === null ? null : { kind: "local", state: category };
  }
  if (column.kind === "linear") {
    return column.state.teamId === ticket.linear.teamId
      ? { kind: "linear", stateId: column.state.id }
      : null;
  }
  const teamId = ticket.linear.teamId;
  const target = sortStates(snapshot.states.filter((state) => state.teamId === teamId)).find(
    (state) => kanbanLocalStateOf({ kind: "linear", stateId: state.id }, statesById) === category,
  );
  return target === undefined ? null : { kind: "linear", stateId: target.id };
}

export function sameStatus(a: KanbanTicketStatus, b: KanbanTicketStatus): boolean {
  return a.kind === "local" && b.kind === "local"
    ? a.state === b.state
    : a.kind === "linear" && b.kind === "linear" && a.stateId === b.stateId;
}

export type ThreadCardStatus = "approval" | "input" | "failed" | "working" | "settled";

export const THREAD_CARD_STATUS_LABELS: Record<ThreadCardStatus, string> = {
  approval: "Needs approval",
  input: "Waiting for answer",
  failed: "Failed",
  working: "Working",
  settled: "Settled",
};

/** How a linked thread reads on a card: what it waits on, whether it works, or settled. */
export function threadCardStatus(shell: BotThreadShell): ThreadCardStatus {
  if (shell.hasPendingApprovals || shell.pendingSubagentRequest === "approval") return "approval";
  if (shell.hasPendingUserInput || shell.pendingSubagentRequest === "user_input") return "input";
  if (shell.runtime?.status === "failed") return "failed";
  if (isThreadWorking(shell)) return "working";
  return "settled";
}
