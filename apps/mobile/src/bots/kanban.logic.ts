import {
  dropActionFor,
  groupTickets,
  type KanbanGroup,
  type KanbanViewResult,
} from "@t3tools/client-runtime/kanban-board";
import type {
  KanbanSnapshot,
  KanbanTicket,
  KanbanTicketStatus,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import type { MenuAction } from "@react-native-menu/menu";

/** What a ticket's menu does; the menu ids encode it so one handler serves every card. */
export type TicketMenuChoice =
  | { readonly kind: "open" }
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
 * The status columns of a board scope, holding the scope's tickets. "Move to…" reads these
 * whatever the view groups by, so a card moves between statuses on any view.
 */
export function statusGroupsOf(
  snapshot: KanbanSnapshot,
  projectId: ProjectId | null,
): ReadonlyArray<KanbanGroup> {
  const tickets =
    projectId === null
      ? snapshot.tickets
      : snapshot.tickets.filter((ticket) => ticket.projectId === projectId);
  return groupTickets(snapshot, projectId, "status", tickets);
}

/** The status a "Move to" choice gives the ticket, or null when that column cannot take it. */
export function moveTarget(
  snapshot: KanbanSnapshot,
  statusGroups: ReadonlyArray<KanbanGroup>,
  ticket: KanbanTicket,
  columnId: string,
): KanbanTicketStatus | null {
  const group = statusGroups.find((candidate) => candidate.id === columnId);
  if (group === undefined) return null;
  const action = dropActionFor(snapshot, ticket, "status", group);
  return action?.kind === "move" ? action.to : null;
}

/**
 * The card's menu. "Move to…" lists the status columns the ticket can take: a Linear ticket only
 * its own team's states, and never the column it sits in. Phones cannot drag well, so this is
 * the way to move a card.
 */
export function ticketMenuActions(input: {
  readonly snapshot: KanbanSnapshot;
  readonly statusGroups: ReadonlyArray<KanbanGroup>;
  readonly ticket: KanbanTicket;
  readonly linkable: ReadonlyArray<TicketMenuThread>;
  readonly linked: ReadonlyArray<TicketMenuThread>;
  readonly canEdit: boolean;
}): MenuAction[] {
  const { ticket } = input;
  const moves = input.statusGroups.flatMap((group) =>
    moveTarget(input.snapshot, input.statusGroups, ticket, group.id) === null
      ? []
      : [{ id: `move:${group.id}`, title: group.title }],
  );
  const actions: MenuAction[] = [{ id: "open", title: "Open issue" }];
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
    case "open":
      return { kind: "open" };
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

/**
 * The column a phone shows: the one picked while the view still has it (shown or hidden); else
 * the first shown column that holds tickets; else the first shown column.
 */
export function shownColumnId(
  view: Pick<KanbanViewResult, "columns" | "hiddenColumns">,
  picked: string | null,
): string | null {
  if (
    picked !== null &&
    (view.columns.some((column) => column.id === picked) ||
      view.hiddenColumns.some((column) => column.id === picked))
  ) {
    return picked;
  }
  return (
    view.columns.find((column) => column.tickets.length > 0)?.id ?? view.columns[0]?.id ?? null
  );
}
