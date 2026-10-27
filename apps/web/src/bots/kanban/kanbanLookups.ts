/**
 * Lookups the kanban UI builds once per snapshot: people, labels, states, projects, cycles,
 * milestones, bots and the owner, so cards and pickers never search arrays per render.
 */
import {
  KANBAN_LOCAL_STATE_LABELS,
  KANBAN_OWNER_PERSON_ID,
  type BotDirectoryEntry,
  type KanbanCycle,
  type KanbanLabel,
  type KanbanLinearProject,
  type KanbanLocalState,
  type KanbanMilestone,
  type KanbanPerson,
  type KanbanSnapshot,
  type KanbanTicket,
  type LinearStateType,
  type LinearWorkflowState,
} from "@t3tools/contracts";

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
  /** The T3 user's display name for `owner` ("You" when unknown). */
  readonly ownerName: string;
}

/** How a person id shows: a Linear user, the owner, a bot, or an unknown id. */
export interface KanbanPersonDisplay {
  readonly id: string;
  readonly name: string;
  readonly avatarUrl: string | null;
  /** Set for `bot:<id>`: draw the bot's face instead of an image. */
  readonly botId: string | null;
}

const byId = <T extends { readonly id: string }>(items: ReadonlyArray<T>): ReadonlyMap<string, T> =>
  new Map(items.map((item) => [item.id, item]));

export function buildKanbanLookups(
  snapshot: KanbanSnapshot,
  bots: ReadonlyArray<BotDirectoryEntry>,
  ownerName: string | null,
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

const BOT_PREFIX = "bot:";

export function personDisplay(lookups: KanbanLookups, personId: string): KanbanPersonDisplay {
  if (personId === KANBAN_OWNER_PERSON_ID) {
    return { id: personId, name: lookups.ownerName, avatarUrl: null, botId: null };
  }
  if (personId.startsWith(BOT_PREFIX)) {
    const botId = personId.slice(BOT_PREFIX.length);
    const name = lookups.botsById.get(botId)?.name ?? botId;
    return { id: personId, name, avatarUrl: null, botId };
  }
  const person = lookups.peopleById.get(personId);
  if (person === undefined) return { id: personId, name: personId, avatarUrl: null, botId: null };
  return {
    id: personId,
    name: person.name || person.displayName,
    avatarUrl: person.avatarUrl,
    botId: null,
  };
}

/** How a ticket's status draws: Linear's category glyph in the state's color. */
export interface KanbanStatusDisplay {
  readonly name: string;
  readonly stateType: LinearStateType;
  readonly color: string;
  /** Fill of a started glyph; later started states draw fuller. */
  readonly progress: number;
}

/** Linear's default colors for the local states, readable in both themes. */
const LOCAL_STATE_DISPLAY: Record<KanbanLocalState, Omit<KanbanStatusDisplay, "name">> = {
  backlog: { stateType: "backlog", color: "#95a2b3", progress: 0 },
  todo: { stateType: "unstarted", color: "#95a2b3", progress: 0 },
  in_progress: { stateType: "started", color: "#f2c94c", progress: 0.5 },
  in_review: { stateType: "started", color: "#5e6ad2", progress: 0.75 },
  done: { stateType: "completed", color: "#4cb782", progress: 1 },
};

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

/** A ticket's status for its glyph; a Linear state missing from the snapshot reads as backlog. */
export function ticketStatusDisplay(
  lookups: KanbanLookups,
  ticket: KanbanTicket,
): KanbanStatusDisplay {
  if (ticket.status.kind === "local") {
    return {
      name: KANBAN_LOCAL_STATE_LABELS[ticket.status.state],
      ...LOCAL_STATE_DISPLAY[ticket.status.state],
    };
  }
  const state = lookups.statesById.get(ticket.status.stateId);
  if (state === undefined) {
    return { name: "Unknown status", stateType: "backlog", color: "#95a2b3", progress: 0 };
  }
  return {
    name: state.name,
    stateType: state.type,
    color: state.color,
    progress: lookups.startedProgressById.get(state.id) ?? 0,
  };
}
