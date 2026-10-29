// @effect-diagnostics globalDate:off -- Due dates and labels are local calendar days for React views.
/**
 * How the web and mobile kanban draw tickets: lookups built once per snapshot, people, statuses,
 * Linear's status and priority glyphs, PR badges, due dates, and the issue pickers' choices.
 */
import {
  isCalendarDay,
  KANBAN_LOCAL_STATE_LABELS,
  KANBAN_LOCAL_STATES,
  KANBAN_OWNER_PERSON_ID,
  kanbanBotPersonId,
  kanbanStateTypeOf,
  linearWorkspaceId,
  type BotDirectoryEntry,
  type KanbanActivity,
  type KanbanComment,
  type KanbanCycle,
  type KanbanLabel,
  type KanbanLinearProject,
  type KanbanLocalState,
  type KanbanMilestone,
  type KanbanPerson,
  type KanbanPullRequestRef,
  type KanbanSnapshot,
  type KanbanTicket,
  type KanbanTicketDetail,
  type KanbanTicketStatus,
  type LinearStateType,
  type LinearWorkflowState,
} from "@t3tools/contracts";

import { KANBAN_LOCAL_COLUMN_COLORS, sortStates, workspaceOf } from "./kanbanBoard.ts";

export interface KanbanLookups {
  readonly peopleById: ReadonlyMap<string, KanbanPerson>;
  readonly labelsById: ReadonlyMap<string, KanbanLabel>;
  readonly statesById: ReadonlyMap<string, LinearWorkflowState>;
  /** Fill of each started state's glyph: a team's started states go from half to three quarters. */
  readonly startedProgressById: ReadonlyMap<string, number>;
  readonly projectsById: ReadonlyMap<string, KanbanLinearProject>;
  readonly milestonesById: ReadonlyMap<string, KanbanMilestone>;
  readonly cyclesById: ReadonlyMap<string, KanbanCycle>;
  readonly botsById: ReadonlyMap<string, BotDirectoryEntry>;
  /** The T3 user's name for `owner` ("You" when unknown). */
  readonly ownerName: string;
}

const byId = <T extends { readonly id: string }>(items: ReadonlyArray<T>): ReadonlyMap<string, T> =>
  new Map(items.map((item) => [item.id, item]));

function startedProgressById(
  states: ReadonlyArray<LinearWorkflowState>,
): ReadonlyMap<string, number> {
  const byTeam = new Map<string, LinearWorkflowState[]>();
  for (const state of states) {
    if (state.type !== "started") continue;
    byTeam.set(state.teamId, [...(byTeam.get(state.teamId) ?? []), state]);
  }
  const progress = new Map<string, number>();
  for (const started of byTeam.values()) {
    started.sort((a, b) => a.position - b.position);
    started.forEach((state, index) =>
      progress.set(
        state.id,
        started.length <= 1 ? 0.5 : 0.5 + (0.25 * index) / (started.length - 1),
      ),
    );
  }
  return progress;
}

export function buildKanbanLookups(
  snapshot: KanbanSnapshot,
  bots: ReadonlyArray<BotDirectoryEntry>,
  ownerName: string | null = null,
): KanbanLookups {
  return {
    peopleById: byId(snapshot.people),
    labelsById: byId(snapshot.labels),
    statesById: byId(snapshot.states),
    startedProgressById: startedProgressById(snapshot.states),
    projectsById: byId(snapshot.linearProjects),
    milestonesById: byId(snapshot.milestones),
    cyclesById: byId(snapshot.cycles),
    botsById: byId(bots),
    ownerName: ownerName ?? "You",
  };
}

/** How a person id shows: a Linear user, the owner, a bot, or an unknown id. */
export interface KanbanPersonDisplay {
  readonly id: string;
  readonly name: string;
  readonly avatarUrl: string | null;
  /** Set for `bot:<id>`: draw the bot's face instead of an image. */
  readonly botId: string | null;
}

const BOT_PREFIX = "bot:";

const readableName = (name: string | null | undefined) =>
  name !== null && name !== undefined && name.trim() !== "" && !name.includes("@") ? name : null;

/**
 * A person id as it shows. `fallbackName` (a ticket's denormalized assignee name) covers people
 * the snapshot lacks; an email is never shown as a name.
 */
export function personDisplay(
  lookups: KanbanLookups,
  personId: string,
  fallbackName?: string | null,
): KanbanPersonDisplay {
  if (personId === KANBAN_OWNER_PERSON_ID) {
    return { id: personId, name: lookups.ownerName, avatarUrl: null, botId: null };
  }
  if (personId.startsWith(BOT_PREFIX)) {
    const botId = personId.slice(BOT_PREFIX.length);
    return {
      id: personId,
      name: lookups.botsById.get(botId)?.name ?? botId,
      avatarUrl: null,
      botId,
    };
  }
  const person = lookups.peopleById.get(personId);
  if (person === undefined) {
    return {
      id: personId,
      name: readableName(fallbackName) ?? "Unknown",
      avatarUrl: null,
      botId: null,
    };
  }
  return {
    id: personId,
    name: readableName(person.name) ?? readableName(person.displayName) ?? "Unknown",
    avatarUrl: person.avatarUrl,
    botId: null,
  };
}

/** One or two letters for an avatar without an image. */
export function personInitials(name: string): string {
  const words = name
    .replace(/@.*$/, "")
    .split(/[\s._-]+/)
    .filter((word) => word.length > 0);
  const [first, second] = words;
  if (first === undefined) return "?";
  return `${first[0] ?? ""}${second?.[0] ?? ""}`.toUpperCase();
}

/** How a status draws: Linear's category glyph in the state's color. */
export interface KanbanStatusDisplay {
  readonly name: string;
  readonly stateType: LinearStateType;
  readonly color: string;
  /** Fill of a started glyph; later started states draw fuller. */
  readonly progress: number;
}

const LOCAL_STATE_PROGRESS: Record<KanbanLocalState, number> = {
  backlog: 0,
  todo: 0,
  in_progress: 0.5,
  in_review: 0.75,
  done: 1,
};

/** A status for its glyph; a Linear state missing from the snapshot reads as backlog. */
export function statusDisplay(
  lookups: KanbanLookups,
  status: KanbanTicketStatus,
): KanbanStatusDisplay {
  if (status.kind === "local") {
    return {
      name: KANBAN_LOCAL_STATE_LABELS[status.state],
      stateType: kanbanStateTypeOf(status, lookups.statesById) ?? "backlog",
      color: KANBAN_LOCAL_COLUMN_COLORS[status.state],
      progress: LOCAL_STATE_PROGRESS[status.state],
    };
  }
  const state = lookups.statesById.get(status.stateId);
  if (state === undefined) {
    return {
      name: "Unknown status",
      stateType: "backlog",
      color: KANBAN_LOCAL_COLUMN_COLORS.canceled,
      progress: 0,
    };
  }
  return {
    name: state.name,
    stateType: state.type,
    color: state.color,
    progress: lookups.startedProgressById.get(state.id) ?? 0,
  };
}

const round = (value: number) => Math.round(value * 1000) / 1000;

/**
 * Linear's status glyph in a 14×14 box: a dashed ring (triage, backlog), an empty ring
 * (unstarted), a ring with a pie filled by progress (started), or a filled disc with a mark.
 */
export type KanbanStatusGlyph =
  | { readonly kind: "dashed" }
  | { readonly kind: "ring"; readonly fill: "none" | "full" | { readonly path: string } }
  | { readonly kind: "disc"; readonly mark: string };

const STATUS_MARKS = {
  completed: "M4.4 7.3 6.2 9.1 9.7 5.3",
  canceled: "M5 5 9 9M9 5 5 9",
  duplicate: "M4.3 7h5.2M7.6 5l2 2-2 2",
} as const;

export function statusGlyph(stateType: LinearStateType, progress = 0.5): KanbanStatusGlyph {
  switch (stateType) {
    case "triage":
    case "backlog":
      return { kind: "dashed" };
    case "unstarted":
      return { kind: "ring", fill: "none" };
    case "started": {
      const clamped = Math.min(1, Math.max(0, progress));
      if (clamped >= 1) return { kind: "ring", fill: "full" };
      if (clamped <= 0) return { kind: "ring", fill: "none" };
      const angle = clamped * 2 * Math.PI;
      const end = `${round(7 + 3.5 * Math.sin(angle))} ${round(7 - 3.5 * Math.cos(angle))}`;
      return {
        kind: "ring",
        fill: { path: `M7 7V3.5A3.5 3.5 0 ${clamped > 0.5 ? 1 : 0} 1 ${end}Z` },
      };
    }
    case "completed":
    case "canceled":
    case "duplicate":
      return { kind: "disc", mark: STATUS_MARKS[stateType] };
  }
}

/** Linear's priority glyph: the urgent box, dashes for none, or three bars with `filled` lit. */
export type KanbanPriorityGlyph =
  | { readonly kind: "urgent" }
  | { readonly kind: "none" }
  | { readonly kind: "bars"; readonly filled: 1 | 2 | 3 };

export function priorityGlyph(priority: number): KanbanPriorityGlyph {
  if (priority === 1) return { kind: "urgent" };
  if (priority === 2) return { kind: "bars", filled: 3 };
  if (priority === 3) return { kind: "bars", filled: 2 };
  if (priority === 4) return { kind: "bars", filled: 1 };
  return { kind: "none" };
}

const PULL_REQUEST_RANK: Record<KanbanPullRequestRef["state"], number> = {
  merged: 3,
  open: 2,
  draft: 1,
  closed: 0,
};

/** One PR's number, or "N PRs" for several, in the most advanced state among them. */
export function pullRequestBadge(
  pullRequests: ReadonlyArray<KanbanPullRequestRef>,
): { readonly text: string; readonly state: KanbanPullRequestRef["state"] } | null {
  let lead: KanbanPullRequestRef | null = null;
  for (const pullRequest of pullRequests) {
    if (lead === null || PULL_REQUEST_RANK[pullRequest.state] > PULL_REQUEST_RANK[lead.state]) {
      lead = pullRequest;
    }
  }
  if (lead === null) return null;
  return {
    text: pullRequests.length === 1 ? `#${lead.number}` : `${pullRequests.length} PRs`,
    state: lead.state,
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Oct 26", with the year when it is not `now`'s year. Local time. */
export function formatKanbanDate(date: Date, now: Date): string {
  const day = `${MONTHS[date.getMonth()]} ${date.getDate()}`;
  return date.getFullYear() === now.getFullYear() ? day : `${day}, ${date.getFullYear()}`;
}

/** `YYYY-MM-DD` of a local date, the format of due dates and before/after filter clauses. */
export const isoDay = (date: Date): string =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

/** A `YYYY-MM-DD` day at local midnight. */
export const dateFromIsoDay = (day: string): Date => {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  return new Date(year, month - 1, date);
};

/** A due date written by `format`; a stored value that is not a real day shows as is. */
export const formatDueDate = (dueDate: string, format: (date: Date) => string): string =>
  isCalendarDay(dueDate) ? format(dateFromIsoDay(dueDate)) : dueDate;

/** An open ticket whose due day is before today (local time); the due day itself is not overdue. */
export function isOverdue(ticket: Pick<KanbanTicket, "dueDate" | "closedAt">, now: Date): boolean {
  if (ticket.dueDate === null || ticket.closedAt !== null || !isCalendarDay(ticket.dueDate)) {
    return false;
  }
  return ticket.dueDate < isoDay(now);
}

/** Due date shortcuts from today, in local days. */
export function dueDatePresets(
  now: Date,
): ReadonlyArray<{ readonly label: string; readonly value: string }> {
  const inDays = (days: number) =>
    isoDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + days));
  return [
    { label: "Today", value: inDays(0) },
    { label: "Tomorrow", value: inDays(1) },
    { label: "In one week", value: inDays(7) },
    { label: "In two weeks", value: inDays(14) },
    { label: "In one month", value: inDays(30) },
  ];
}

export type KanbanTimelineEntry =
  | { readonly kind: "activity"; readonly id: string; readonly activity: KanbanActivity }
  | { readonly kind: "comment"; readonly id: string; readonly comment: KanbanComment };

/** History lines and comments in one list, oldest first; at the same instant history comes first. */
export function issueTimeline(
  detail: Pick<KanbanTicketDetail, "activity" | "comments">,
): ReadonlyArray<KanbanTimelineEntry> {
  const entries = [
    ...detail.activity.map((activity) => ({
      at: Date.parse(activity.createdAt),
      entry: { kind: "activity", id: `a:${activity.id}`, activity } as const,
    })),
    ...detail.comments.map((comment) => ({
      at: Date.parse(comment.createdAt),
      entry: { kind: "comment", id: `c:${comment.id}`, comment } as const,
    })),
  ];
  // Array sort is stable, so entries at the same instant keep activity-then-comment order.
  return entries.sort((a, b) => a.at - b.at).map(({ entry }) => entry);
}

/** The statuses a ticket can move to, in board order: its team's states, or the local ones. */
export function statusChoices(
  snapshot: KanbanSnapshot,
  ticket: KanbanTicket,
): ReadonlyArray<KanbanTicketStatus> {
  const linear = ticket.linear;
  if (linear === null) return KANBAN_LOCAL_STATES.map((state) => ({ kind: "local", state }));
  return sortStates(snapshot.states.filter((state) => state.teamId === linear.teamId)).map(
    (state) => ({ kind: "linear", stateId: state.id }),
  );
}

/** The Linear organization of a synced ticket's account; null for a local ticket. */
export function ticketOrganizationId(
  snapshot: KanbanSnapshot,
  ticket: KanbanTicket,
): string | null {
  const linear = ticket.linear;
  if (linear === null) return null;
  return (
    snapshot.accounts.find((account) => account.id === linear.accountId)?.organizationId ?? null
  );
}

/**
 * People a ticket can be assigned to, as person ids: the active Linear users of its workspace
 * (its account's own user first, then by name), or the owner and the bots for a local ticket.
 */
export function assigneeChoices(
  snapshot: KanbanSnapshot,
  ticket: KanbanTicket,
  botIds: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const linear = ticket.linear;
  if (linear === null) {
    return [KANBAN_OWNER_PERSON_ID, ...botIds.map((botId) => kanbanBotPersonId(botId))];
  }
  const organizationId = ticketOrganizationId(snapshot, ticket);
  const me = snapshot.accounts.find((account) => account.id === linear.accountId)?.userId ?? null;
  return snapshot.people
    .filter(
      (person) =>
        person.organizationId === organizationId &&
        (person.active || person.id === ticket.assigneeId),
    )
    .sort((a, b) => Number(b.id === me) - Number(a.id === me) || a.name.localeCompare(b.name))
    .map((person) => person.id);
}

/**
 * Labels a ticket can carry: its team's and its workspace's Linear labels (not label groups,
 * which Linear does not assign), or the local labels for a local ticket.
 */
export function labelChoices(
  snapshot: KanbanSnapshot,
  ticket: KanbanTicket,
): ReadonlyArray<KanbanLabel> {
  const linear = ticket.linear;
  if (linear === null) return snapshot.labels.filter((label) => label.source === "local");
  const organizationId = ticketOrganizationId(snapshot, ticket);
  if (organizationId === null) return [];
  const workspaceId = linearWorkspaceId(organizationId);
  const groupIds = new Set(snapshot.labels.flatMap((label) => label.parentId ?? []));
  return snapshot.labels.filter(
    (label) =>
      label.source === "linear" &&
      label.workspaceId === workspaceId &&
      (label.teamId === null || label.teamId === linear.teamId) &&
      !groupIds.has(label.id),
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
