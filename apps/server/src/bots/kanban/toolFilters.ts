/**
 * The filters `kanban_list` offers a bot: a small server-side subset of the board's filters
 * (`@t3tools/client-runtime/kanban-board`, which the server cannot import). Every given filter must
 * match; a list filter matches when any of its values does.
 */
import {
  kanbanBotPersonId,
  kanbanStateTypeOf,
  type BotId,
  type KanbanSnapshot,
  type KanbanTicket,
  type LinearStateType,
} from "@t3tools/contracts";

export interface KanbanToolFilters {
  readonly statusTypes?: ReadonlyArray<LinearStateType> | undefined;
  /** A Linear workflow state id, or a local state (`todo`, …). */
  readonly stateIds?: ReadonlyArray<string> | undefined;
  /** A person id, `none`, or `me` (the calling bot, `bot:<id>`). */
  readonly assignee?: string | undefined;
  readonly priorities?: ReadonlyArray<number> | undefined;
  /** Label names, case-insensitive. */
  readonly labels?: ReadonlyArray<string> | undefined;
  /** Contained in the identifier or title, case-insensitive. */
  readonly text?: string | undefined;
  readonly hasThreads?: boolean | undefined;
}

export function kanbanToolTicketFilter(
  snapshot: KanbanSnapshot,
  filters: KanbanToolFilters,
  callerBotId: BotId,
): (ticket: KanbanTicket) => boolean {
  const statesById = new Map(snapshot.states.map((state) => [state.id, state]));
  const statusTypes = filters.statusTypes && new Set<string>(filters.statusTypes);
  const stateIds = filters.stateIds && new Set(filters.stateIds);
  const priorities = filters.priorities && new Set(filters.priorities);
  const labelNames = filters.labels && new Set(filters.labels.map((name) => name.toLowerCase()));
  const labelIds =
    labelNames &&
    new Set(
      snapshot.labels.flatMap((label) =>
        labelNames.has(label.name.toLowerCase()) ? [label.id] : [],
      ),
    );
  const assignee =
    filters.assignee === undefined
      ? undefined
      : filters.assignee === "none"
        ? null
        : filters.assignee === "me"
          ? kanbanBotPersonId(callerBotId)
          : filters.assignee;
  const text = filters.text?.trim().toLowerCase() || undefined;

  return (ticket) =>
    (statusTypes === undefined ||
      statusTypes.has(kanbanStateTypeOf(ticket.status, statesById) ?? "")) &&
    (stateIds === undefined ||
      stateIds.has(ticket.status.kind === "local" ? ticket.status.state : ticket.status.stateId)) &&
    (assignee === undefined || ticket.assigneeId === assignee) &&
    (priorities === undefined || priorities.has(ticket.priority)) &&
    (labelIds === undefined || ticket.labelIds.some((id) => labelIds.has(id))) &&
    (text === undefined ||
      ticket.identifier.toLowerCase().includes(text) ||
      ticket.title.toLowerCase().includes(text)) &&
    (filters.hasThreads === undefined || ticket.threadIds.length > 0 === filters.hasThreads);
}
