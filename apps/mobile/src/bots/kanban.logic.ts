import { dropTarget, sameStatus, type KanbanBoard } from "@t3tools/client-runtime/kanban-board";
import type {
  KanbanSnapshot,
  KanbanTicket,
  KanbanTicketStatus,
  ThreadId,
} from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";

/** What a ticket's menu does; the menu ids encode it so one handler serves every card. */
export type TicketMenuChoice =
  | { readonly kind: "move"; readonly columnId: string }
  | { readonly kind: "link"; readonly threadId: ThreadId }
  | { readonly kind: "unlink"; readonly threadId: ThreadId }
  | { readonly kind: "open-linear" }
  | { readonly kind: "delete" };

export interface TicketMenuThread {
  readonly id: ThreadId;
  readonly title: string;
}

/**
 * The card's menu. "Move to…" lists the board's other columns the ticket can take: a Linear ticket
 * only its own team's states, and never its current column. Phones cannot drag well, so this is
 * the way to move a card.
 */
export function ticketMenuActions(input: {
  readonly snapshot: KanbanSnapshot;
  readonly board: KanbanBoard;
  readonly ticket: KanbanTicket;
  readonly linkable: ReadonlyArray<TicketMenuThread>;
  readonly linked: ReadonlyArray<TicketMenuThread>;
  readonly canEdit: boolean;
}): MenuAction[] {
  const { ticket } = input;
  const moves = input.board.columns.flatMap((column) => {
    const to = dropTarget(input.snapshot, ticket, column);
    return to === null || sameStatus(to, ticket.status)
      ? []
      : [{ id: `move:${column.id}`, title: column.title }];
  });
  const actions: MenuAction[] = [];
  if (input.canEdit && moves.length > 0) {
    actions.push({ id: "move", title: "Move to…", subactions: moves });
  }
  if (input.canEdit && input.linkable.length > 0) {
    actions.push({
      id: "link",
      title: "Link thread",
      subactions: input.linkable.map((thread) => ({
        id: `link:${thread.id}`,
        title: thread.title,
      })),
    });
  }
  if (input.canEdit && input.linked.length > 0) {
    actions.push({
      id: "unlink",
      title: "Unlink thread",
      subactions: input.linked.map((thread) => ({
        id: `unlink:${thread.id}`,
        title: thread.title,
      })),
    });
  }
  if (ticket.linear !== null) {
    actions.push({ id: "open-linear", title: "Open in Linear" });
  } else if (input.canEdit) {
    actions.push({ id: "delete", title: "Delete ticket", attributes: { destructive: true } });
  }
  return actions;
}

export function parseTicketMenuChoice(id: string): TicketMenuChoice | null {
  const separator = id.indexOf(":");
  const kind = separator === -1 ? id : id.slice(0, separator);
  const value = separator === -1 ? "" : id.slice(separator + 1);
  switch (kind) {
    case "move":
      return value === "" ? null : { kind: "move", columnId: value };
    case "link":
    case "unlink":
      return value === "" ? null : { kind, threadId: value as ThreadId };
    case "open-linear":
      return { kind: "open-linear" };
    case "delete":
      return { kind: "delete" };
    default:
      return null;
  }
}

/** The status a "Move to" choice gives the ticket, or null when that column cannot take it. */
export function moveTarget(
  snapshot: KanbanSnapshot,
  board: KanbanBoard,
  ticket: KanbanTicket,
  columnId: string,
): KanbanTicketStatus | null {
  const column = board.columns.find((candidate) => candidate.id === columnId);
  return column === undefined ? null : dropTarget(snapshot, ticket, column);
}

/**
 * The column a phone shows: the one picked, while it is still on the board; else the first that
 * holds tickets; else the first.
 */
export function shownColumnId(board: KanbanBoard, picked: string | null): string | null {
  if (picked !== null && board.columns.some((column) => column.id === picked)) return picked;
  return (
    board.columns.find((column) => column.tickets.length > 0)?.id ?? board.columns[0]?.id ?? null
  );
}
