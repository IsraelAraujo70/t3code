/**
 * Pure pieces of the kanban issue view: the merged activity timeline, time labels, due dates,
 * status presentation and the options each property picker offers.
 */
import {
  KANBAN_LOCAL_STATE_LABELS,
  KANBAN_LOCAL_STATES,
  KANBAN_OWNER_PERSON_ID,
  kanbanBotPersonId,
  kanbanStateTypeOf,
  type BotDirectoryEntry,
  type KanbanActivity,
  type KanbanComment,
  type KanbanCycle,
  type KanbanLabel,
  type KanbanLocalState,
  type KanbanPerson,
  type KanbanSnapshot,
  type KanbanTicket,
  type KanbanTicketStatus,
  type LinearStateType,
  type LinearWorkflowState,
} from "@t3tools/contracts";
import { sortStates } from "@t3tools/client-runtime/kanban-board";

export type IssueTimelineEntry =
  | { readonly kind: "activity"; readonly id: string; readonly activity: KanbanActivity }
  | { readonly kind: "comment"; readonly id: string; readonly comment: KanbanComment };

/** History lines and comments in one list, oldest first; on a tie history comes first. */
export function issueTimeline(
  activity: ReadonlyArray<KanbanActivity>,
  comments: ReadonlyArray<KanbanComment>,
): ReadonlyArray<IssueTimelineEntry> {
  const entries = [
    ...activity.map((item) => ({
      at: Date.parse(item.createdAt),
      entry: { kind: "activity", id: `a:${item.id}`, activity: item } as const,
    })),
    ...comments.map((item) => ({
      at: Date.parse(item.createdAt),
      entry: { kind: "comment", id: `c:${item.id}`, comment: item } as const,
    })),
  ];
  return entries.sort((a, b) => a.at - b.at).map(({ entry }) => entry);
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** The epoch ms of a `useNowMinute()` value, a UTC `YYYY-MM-DDTHH:mm` without its zone suffix. */
export function minuteEpoch(minute: string): number {
  return Date.parse(`${minute}:00Z`);
}

/** "now", "5m ago", "3h ago", "5d ago" within a month, then "Oct 21" ("Oct 21, 2025" in another year). */
export function relativeTimeLabel(iso: string, now: number): string {
  const at = Date.parse(iso);
  const elapsed = now - at;
  if (elapsed < MINUTE_MS) return "now";
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m ago`;
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h ago`;
  if (elapsed < 30 * DAY_MS) return `${Math.floor(elapsed / DAY_MS)}d ago`;
  const date = new Date(at);
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    ...(date.getFullYear() === new Date(now).getFullYear() ? {} : { year: "numeric" }),
  });
}

/** A local calendar day as `YYYY-MM-DD`, the format of a ticket's due date. */
export function dateKey(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The local midnight of a `YYYY-MM-DD` day. */
export function dateFromKey(key: string): Date {
  const [year = 0, month = 1, day = 1] = key.split("-").map(Number);
  return new Date(year, month - 1, day);
}

/** Due before today (local time); the due day itself is not overdue. */
export function isOverdue(dueDate: string | null, now: number): boolean {
  return dueDate !== null && dueDate < dateKey(new Date(now));
}

/** `owner/name` and the number of a GitHub pull request URL, or null for any other URL. */
export function parsePullRequestUrl(
  url: string,
): { readonly repository: string; readonly number: number } | null {
  const match =
    /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)(?:[/?#]|$)/.exec(url);
  if (match === null) return null;
  const number = Number(match[2]);
  return number > 0 ? { repository: match[1]!, number } : null;
}

/** Colors of the local columns, as the board draws them. */
const LOCAL_STATE_COLORS: Record<KanbanLocalState, string> = {
  backlog: "#bec2c8",
  todo: "#e2e2e2",
  in_progress: "#f2c94c",
  in_review: "#5e6ad2",
  done: "#4cb782",
};

const LOCAL_STATE_PROGRESS: Partial<Record<KanbanLocalState, number>> = {
  in_progress: 0.5,
  in_review: 0.75,
};

export interface StatusPresentation {
  readonly name: string;
  readonly stateType: LinearStateType;
  readonly color: string;
  /** Fill for started states (In Review draws fuller than In Progress). */
  readonly progress?: number;
}

/** How a status reads: its name, Linear category and color; null for an unknown Linear state. */
export function statusPresentation(
  status: KanbanTicketStatus,
  statesById: ReadonlyMap<string, LinearWorkflowState>,
): StatusPresentation | null {
  if (status.kind === "local") {
    const progress = LOCAL_STATE_PROGRESS[status.state];
    return {
      name: KANBAN_LOCAL_STATE_LABELS[status.state],
      stateType: kanbanStateTypeOf(status, statesById) ?? "backlog",
      color: LOCAL_STATE_COLORS[status.state],
      ...(progress === undefined ? {} : { progress }),
    };
  }
  const state = statesById.get(status.stateId);
  if (state === undefined) return null;
  return {
    name: state.name,
    stateType: state.type,
    color: state.color,
    ...(state.type === "started" ? { progress: /revi(ew|s)/i.test(state.name) ? 0.75 : 0.5 } : {}),
  };
}

/** The statuses a ticket can move to, in board order: its team's states, or the local ones. */
export function statusOptions(
  snapshot: KanbanSnapshot,
  ticket: KanbanTicket,
): ReadonlyArray<KanbanTicketStatus> {
  const teamId = ticket.linear?.teamId;
  if (teamId === undefined) {
    return KANBAN_LOCAL_STATES.map((state) => ({ kind: "local", state }));
  }
  return sortStates(snapshot.states.filter((state) => state.teamId === teamId)).map((state) => ({
    kind: "linear",
    stateId: state.id,
  }));
}

/** The Linear organization of a synced ticket's account; null for a local ticket. */
export function ticketOrganizationId(
  snapshot: KanbanSnapshot,
  ticket: KanbanTicket,
): string | null {
  const accountId = ticket.linear?.accountId;
  if (accountId === undefined) return null;
  return snapshot.accounts.find((account) => account.id === accountId)?.organizationId ?? null;
}

export interface AssigneeOption {
  readonly id: string;
  readonly name: string;
  readonly avatarUrl: string | null;
  readonly botId: string | null;
  readonly isMe: boolean;
}

/**
 * Who a ticket can be assigned to, "me" first: the active people of a synced ticket's
 * organization, or the owner and the bots for a local ticket.
 */
export function assigneeOptions(
  snapshot: KanbanSnapshot,
  ticket: KanbanTicket,
  bots: ReadonlyArray<Pick<BotDirectoryEntry, "id" | "name">>,
  ownerName: string,
): ReadonlyArray<AssigneeOption> {
  if (ticket.linear === null) {
    return [
      { id: KANBAN_OWNER_PERSON_ID, name: ownerName, avatarUrl: null, botId: null, isMe: true },
      ...bots.map((bot) => ({
        id: kanbanBotPersonId(bot.id),
        name: bot.name,
        avatarUrl: null,
        botId: bot.id,
        isMe: false,
      })),
    ];
  }
  const organizationId = ticketOrganizationId(snapshot, ticket);
  const meId = snapshot.accounts.find((account) => account.id === ticket.linear?.accountId)?.userId;
  const option = (person: KanbanPerson): AssigneeOption => ({
    id: person.id,
    name: person.name,
    avatarUrl: person.avatarUrl,
    botId: null,
    isMe: person.id === meId,
  });
  return snapshot.people
    .filter(
      (person) =>
        person.organizationId === organizationId &&
        (person.active || person.id === ticket.assigneeId),
    )
    .map(option)
    .sort((a, b) => Number(b.isMe) - Number(a.isMe) || a.name.localeCompare(b.name));
}

/**
 * Labels a ticket can carry: its team's and its workspace's Linear labels (not label groups,
 * which Linear does not assign), or the local labels for a local ticket.
 */
export function labelOptions(
  snapshot: KanbanSnapshot,
  ticket: KanbanTicket,
): ReadonlyArray<KanbanLabel> {
  if (ticket.linear === null) return snapshot.labels.filter((label) => label.source === "local");
  const organizationId = ticketOrganizationId(snapshot, ticket);
  const teamId = ticket.linear.teamId;
  const groupIds = new Set(snapshot.labels.flatMap((label) => label.parentId ?? []));
  return snapshot.labels.filter(
    (label) =>
      label.source === "linear" &&
      label.workspaceId === `linear:${organizationId}` &&
      (label.teamId === null || label.teamId === teamId) &&
      !groupIds.has(label.id),
  );
}

export interface CycleOption {
  readonly cycle: KanbanCycle;
  readonly title: string;
  readonly current: boolean;
}

/** The team's cycles, the current one first, then upcoming, then past (newest first). */
export function cycleOptions(
  snapshot: KanbanSnapshot,
  teamId: string,
  now: number,
): ReadonlyArray<CycleOption> {
  const rank = (cycle: KanbanCycle) => {
    if (Date.parse(cycle.endsAt) <= now) return 2;
    return Date.parse(cycle.startsAt) <= now ? 0 : 1;
  };
  return snapshot.cycles
    .filter((cycle) => cycle.teamId === teamId)
    .map((cycle) => ({
      cycle,
      title: cycle.name ?? `Cycle ${cycle.number}`,
      current: rank(cycle) === 0,
    }))
    .sort((a, b) => {
      const byRank = rank(a.cycle) - rank(b.cycle);
      if (byRank !== 0) return byRank;
      const byStart = a.cycle.startsAt.localeCompare(b.cycle.startsAt);
      return rank(a.cycle) === 2 ? -byStart : byStart;
    });
}

/** Colors offered to a new local label, picked in turn. */
export const LOCAL_LABEL_COLORS = [
  "#5e6ad2",
  "#26b5ce",
  "#4cb782",
  "#f2c94c",
  "#f2994a",
  "#eb5757",
  "#bb87fc",
  "#95a2b3",
] as const;

/** The next palette color for a new local label, so consecutive labels differ. */
export function nextLabelColor(existing: ReadonlyArray<KanbanLabel>): string {
  const localCount = existing.filter((label) => label.source === "local").length;
  return LOCAL_LABEL_COLORS[localCount % LOCAL_LABEL_COLORS.length]!;
}

/** Case-insensitive name match for the pickers' search fields. */
export function matchesQuery(name: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return needle === "" || name.toLowerCase().includes(needle);
}
