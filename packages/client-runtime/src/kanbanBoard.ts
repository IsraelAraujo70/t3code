/**
 * The kanban board's rules (friend fork), shared by the web board and the mobile one: a ticket's
 * workspace, the order of workflow states, the status a dropped or moved ticket takes, and how a
 * linked thread's status reads on a card. Views and columns: kanbanView.ts.
 */
import type { BotThreadShell } from "./botDirectory.ts";
import { isThreadWorking } from "./state/threadInbox.ts";
import {
  kanbanLocalStateOf,
  LINEAR_STATE_TYPE_ORDER,
  LOCAL_KANBAN_WORKSPACE_ID,
  linearWorkspaceId,
  type KanbanLocalState,
  type KanbanSnapshot,
  type KanbanTicket,
  type KanbanTicketStatus,
  type KanbanWorkspaceId,
  type LinearWorkflowState,
} from "@t3tools/contracts";

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

export function workspaceOf(snapshot: KanbanSnapshot, ticket: KanbanTicket): KanbanWorkspaceId {
  if (ticket.linear === null) return LOCAL_KANBAN_WORKSPACE_ID;
  const linear = ticket.linear;
  const account = snapshot.accounts.find((candidate) => candidate.id === linear.accountId);
  return account === undefined
    ? LOCAL_KANBAN_WORKSPACE_ID
    : linearWorkspaceId(account.organizationId);
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
export * from "./kanbanView.ts";
