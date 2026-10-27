import { sortStates, workspaceOf } from "@t3tools/client-runtime/kanban-board";
import {
  KANBAN_LOCAL_STATES,
  KANBAN_OWNER_PERSON_ID,
  kanbanBotPersonId,
  linearWorkspaceId,
  type KanbanActivity,
  type KanbanComment,
  type KanbanLabel,
  type KanbanSnapshot,
  type KanbanTicket,
  type KanbanTicketDetail,
  type KanbanTicketStatus,
} from "@t3tools/contracts";

/** Comments and history in one list, oldest first; at the same instant history comes first. */
export type KanbanTimelineEntry =
  | { readonly kind: "activity"; readonly activity: KanbanActivity }
  | { readonly kind: "comment"; readonly comment: KanbanComment };

const entryTime = (entry: KanbanTimelineEntry) =>
  entry.kind === "activity" ? entry.activity.createdAt : entry.comment.createdAt;

export function issueTimeline(
  detail: Pick<KanbanTicketDetail, "comments" | "activity">,
): ReadonlyArray<KanbanTimelineEntry> {
  const entries: KanbanTimelineEntry[] = [
    ...detail.activity.map((activity) => ({ kind: "activity" as const, activity })),
    ...detail.comments.map((comment) => ({ kind: "comment" as const, comment })),
  ];
  // Array sort is stable, so entries at the same instant keep activity-then-comment order.
  return entries.sort((a, b) => Date.parse(entryTime(a)) - Date.parse(entryTime(b)));
}

/** Statuses a ticket can move to: its Linear team's states, or the local columns. */
export function statusChoices(
  snapshot: KanbanSnapshot,
  ticket: KanbanTicket,
): ReadonlyArray<{ readonly id: string; readonly status: KanbanTicketStatus }> {
  const linear = ticket.linear;
  if (linear === null) {
    return KANBAN_LOCAL_STATES.map((state) => ({ id: state, status: { kind: "local", state } }));
  }
  return sortStates(snapshot.states.filter((state) => state.teamId === linear.teamId)).map(
    (state) => ({ id: state.id, status: { kind: "linear", stateId: state.id } }),
  );
}

const organizationOf = (snapshot: KanbanSnapshot, ticket: KanbanTicket) => {
  const linear = ticket.linear;
  return linear === null
    ? undefined
    : snapshot.accounts.find((account) => account.id === linear.accountId)?.organizationId;
};

/**
 * People a ticket can be assigned to, as person ids: the active Linear users of its workspace
 * (its account's own user first), or the owner and the bots for a local ticket.
 */
export function assigneeChoices(
  snapshot: KanbanSnapshot,
  ticket: KanbanTicket,
  botIds: ReadonlyArray<string>,
): ReadonlyArray<string> {
  if (ticket.linear === null) {
    return [KANBAN_OWNER_PERSON_ID, ...botIds.map((botId) => kanbanBotPersonId(botId))];
  }
  const organizationId = organizationOf(snapshot, ticket);
  const accountId = ticket.linear.accountId;
  const me = snapshot.accounts.find((account) => account.id === accountId)?.userId ?? null;
  const people = snapshot.people
    .filter(
      (person) =>
        person.organizationId === organizationId &&
        (person.active || person.id === ticket.assigneeId),
    )
    .sort((a, b) => Number(b.id === me) - Number(a.id === me) || a.name.localeCompare(b.name));
  return people.map((person) => person.id);
}

/** Labels a ticket can carry: its team's and its workspace's Linear labels, or local labels. */
export function labelChoices(
  snapshot: KanbanSnapshot,
  ticket: KanbanTicket,
): ReadonlyArray<KanbanLabel> {
  const linear = ticket.linear;
  if (linear === null) return snapshot.labels.filter((label) => label.source === "local");
  const organizationId = organizationOf(snapshot, ticket);
  if (organizationId === undefined) return [];
  const workspaceId = linearWorkspaceId(organizationId);
  return snapshot.labels.filter(
    (label) =>
      label.source === "linear" &&
      label.workspaceId === workspaceId &&
      (label.teamId === null || label.teamId === linear.teamId),
  );
}

/** The ticket's own bot when it has one, else the bots responsible for its workspace. */
export function responsibleBotIds(
  snapshot: KanbanSnapshot,
  ticket: KanbanTicket,
): ReadonlyArray<string> {
  if (ticket.botId !== null) return [ticket.botId];
  const workspaceId = workspaceOf(snapshot, ticket);
  return snapshot.workspaces.find((workspace) => workspace.id === workspaceId)?.botIds ?? [];
}
