/**
 * Lookups the kanban UI builds once per snapshot: people, labels, states, projects, cycles,
 * milestones, bots and the owner, so cards and pickers never search arrays per render.
 */
import type {
  BotDirectoryEntry,
  KanbanCycle,
  KanbanLabel,
  KanbanLinearProject,
  KanbanMilestone,
  KanbanPerson,
  KanbanSnapshot,
  LinearWorkflowState,
} from "@t3tools/contracts";

export interface KanbanLookups {
  readonly peopleById: ReadonlyMap<string, KanbanPerson>;
  readonly labelsById: ReadonlyMap<string, KanbanLabel>;
  readonly statesById: ReadonlyMap<string, LinearWorkflowState>;
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

export function buildKanbanLookups(
  snapshot: KanbanSnapshot,
  bots: ReadonlyArray<BotDirectoryEntry>,
  ownerName: string | null,
): KanbanLookups {
  void snapshot;
  void bots;
  void ownerName;
  throw new Error("buildKanbanLookups: not implemented");
}

export function personDisplay(lookups: KanbanLookups, personId: string): KanbanPersonDisplay {
  void lookups;
  void personId;
  throw new Error("personDisplay: not implemented");
}
