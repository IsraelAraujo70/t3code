import {
  assigneeChoices,
  personDisplay,
  type KanbanLookups,
} from "@t3tools/client-runtime/kanban-display";
import {
  KANBAN_OWNER_PERSON_ID,
  type BotDirectoryEntry,
  type KanbanCycle,
  type KanbanLabel,
  type KanbanSnapshot,
  type KanbanTicket,
} from "@t3tools/contracts";

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
  lookups: KanbanLookups,
  bots: ReadonlyArray<Pick<BotDirectoryEntry, "id">>,
): ReadonlyArray<AssigneeOption> {
  const me = snapshot.accounts.find((account) => account.id === ticket.linear?.accountId)?.userId;
  return assigneeChoices(
    snapshot,
    ticket,
    bots.map((bot) => bot.id),
  ).map((id) => ({
    ...personDisplay(lookups, id),
    isMe: id === KANBAN_OWNER_PERSON_ID || id === me,
  }));
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
const LOCAL_LABEL_COLORS = [
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
