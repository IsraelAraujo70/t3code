/**
 * Shared rules for listing bots on web and mobile: each bot's status from its main thread, the
 * line under its name, the user's sections in order, and arranging bots and sections.
 */
import type {
  BotDirectoryEntry,
  BotId,
  BotsArrangeInput,
  BotSection,
  BotSectionId,
  EnvironmentId,
  ScopedThreadRef,
} from "@t3tools/contracts";

import { scopeThreadRef } from "./environment/index.ts";
import type { EnvironmentThreadShell } from "./state/models.ts";
import { isThreadWorking } from "./state/threadInbox.ts";

/**
 * Where a bot stands, as in the Threads inbox: it needs the user, it is working, or the user (or
 * auto-settle) settled its conversation. `attention` marks a needs-you bot with something new for
 * the user (a request, a failure, an unseen reply); the badges count only those.
 */
export type BotStatus =
  | { readonly kind: "needs-you"; readonly attention: "request" | "unseen" | null }
  | { readonly kind: "working" }
  | { readonly kind: "settled" };

/** The parts of a thread shell a bot row reads. */
export type BotThreadShell = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "id"
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "interactionMode"
  | "latestRun"
  | "runtime"
  | "lastVisitedAt"
  | "updatedAt"
  | "settledOverride"
>;

export interface BotRowModel {
  readonly bot: BotDirectoryEntry;
  readonly threadRef: ScopedThreadRef;
  readonly status: BotStatus;
  /** What the row says under the name: the request it waits on, or what it is doing. */
  readonly preview: string | null;
  /** When the bot last did something, for the row's relative time; null before its thread loads. */
  readonly activityAt: string | null;
}

const QUIET: BotStatus = { kind: "needs-you", attention: null };

/**
 * The request the bot is waiting on, if any. Same order as the thread lists' status: approvals,
 * then questions, then a failed runtime.
 */
function pendingRequest(shell: BotThreadShell): string | null {
  if (shell.hasPendingApprovals || shell.pendingSubagentRequest === "approval") {
    return "Needs approval";
  }
  if (shell.hasPendingUserInput || shell.pendingSubagentRequest === "user_input") {
    return "Waiting for your answer";
  }
  if (shell.runtime?.status === "failed") {
    return shell.runtime.lastErrorClass === "usage_limit" ? "Usage limit" : "Failed";
  }
  return null;
}

/** A run that finished after the user last opened the thread; never-opened threads have none. */
function hasUnseenCompletion(shell: BotThreadShell): boolean {
  const completedAt = Date.parse(shell.latestRun?.completedAt ?? "");
  if (Number.isNaN(completedAt) || !shell.lastVisitedAt) return false;
  const lastVisitedAt = Date.parse(shell.lastVisitedAt);
  return Number.isNaN(lastVisitedAt) || completedAt > lastVisitedAt;
}

/**
 * Requests and failures need the user before anything else; then running work; then a settled
 * conversation; everything else waits on the user like an unsettled thread. A null shell (not
 * loaded yet, or the conversation has not started) needs nothing.
 */
export function botStatusFromShell(shell: BotThreadShell | null): BotStatus {
  if (shell === null) return QUIET;
  if (pendingRequest(shell) !== null) return { kind: "needs-you", attention: "request" };
  if (isThreadWorking(shell)) return { kind: "working" };
  if (shell.settledOverride === "settled") return { kind: "settled" };
  if (hasUnseenCompletion(shell)) return { kind: "needs-you", attention: "unseen" };
  return QUIET;
}

/** How many bots have something new for the user, for the tab badge. */
export function countBotsNeedingYou(statuses: ReadonlyArray<BotStatus>): number {
  return statuses.filter((status) => status.kind === "needs-you" && status.attention !== null)
    .length;
}

/**
 * The one mark an avatar carries where the bot's name is not shown: a request or failure, an
 * unseen reply, or a running turn. A quiet or settled bot carries none.
 */
export type BotSignal = "request" | "unseen" | "working" | null;

export function botSignal(status: BotStatus): BotSignal {
  switch (status.kind) {
    case "needs-you":
      return status.attention;
    case "working":
      return "working";
    case "settled":
      return null;
  }
}

/** The latest run's completion, else the thread's last update. */
export function botActivityAt(shell: BotThreadShell | null): string | null {
  if (shell === null) return null;
  return shell.latestRun?.completedAt ?? shell.updatedAt;
}

// Thread shells carry no message bodies (the server keeps them out for speed), so the row
// describes the bot's state instead of quoting its last message.
function botPreview(shell: BotThreadShell | null, status: BotStatus): string | null {
  if (shell === null) return null;
  switch (status.kind) {
    case "needs-you":
      return status.attention === "request"
        ? pendingRequest(shell)
        : status.attention === "unseen"
          ? "New reply"
          : null;
    case "working":
      return "Working…";
    case "settled":
      return "Settled";
  }
}

/**
 * One row per directory bot, in directory order, each matched to its current main thread in
 * `environmentId`. Threads of other environments and earlier conversation generations are ignored.
 */
export function resolveBotRows(
  bots: ReadonlyArray<BotDirectoryEntry>,
  environmentId: EnvironmentId,
  threads: ReadonlyArray<BotThreadShell>,
): BotRowModel[] {
  const homeThreadIds = new Set<string>(bots.map((bot) => bot.homeThreadId));
  const shells = new Map<string, BotThreadShell>();
  for (const thread of threads) {
    if (thread.environmentId === environmentId && homeThreadIds.has(thread.id)) {
      shells.set(thread.id, thread);
    }
  }
  return bots.map((bot) => {
    const shell = shells.get(bot.homeThreadId) ?? null;
    const status = botStatusFromShell(shell);
    return {
      bot,
      threadRef: scopeThreadRef(environmentId, bot.homeThreadId),
      status,
      preview: botPreview(shell, status),
      activityAt: botActivityAt(shell),
    };
  });
}

const STATUS_RANK = { "needs-you": 0, working: 1, settled: 2 } as const;

/** A sidebar group: a user section, or the default list (`section` null). */
export interface BotGroup {
  readonly section: BotSection | null;
  readonly rows: ReadonlyArray<BotRowModel>;
}

/** The default list's key wherever groups are keyed (collapse state, drop targets). */
export const DEFAULT_BOT_GROUP = "default";

/** A group's stable key: its section id, or DEFAULT_BOT_GROUP for the default list. */
export const botGroupKey = (section: BotSection | null): string => section?.id ?? DEFAULT_BOT_GROUP;

/**
 * The user's sections in order, then bots in no section (left out when empty and sections exist).
 * `byStatus` puts needs-you, then working, then settled bots first in a group, keeping the user's
 * order within a status; `arranged` keeps the user's order alone, so an avatar never moves.
 */
export function groupBotRows(
  sections: ReadonlyArray<BotSection>,
  rows: ReadonlyArray<BotRowModel>,
  order: "byStatus" | "arranged" = "byStatus",
): BotGroup[] {
  const known = new Set<string>(sections.map((section) => section.id));
  // `filter` already copies, and a stable sort keeps the user's order within a status. Not
  // `toSorted`: the phone's Hermes engine lacks it.
  const sort = (group: BotRowModel[]) =>
    order === "arranged"
      ? group
      : group.sort((a, b) => STATUS_RANK[a.status.kind] - STATUS_RANK[b.status.kind]);
  const groups: BotGroup[] = sections.map((section) => ({
    section,
    rows: sort(rows.filter((row) => row.bot.sectionId === section.id)),
  }));
  const rest = sort(
    rows.filter((row) => row.bot.sectionId === null || !known.has(row.bot.sectionId)),
  );
  if (rest.length > 0 || sections.length === 0) groups.push({ section: null, rows: rest });
  return groups;
}

/** The arrangement the directory is in now, the starting point of every move. */
export function currentArrangement(
  sections: ReadonlyArray<BotSection>,
  bots: ReadonlyArray<Pick<BotDirectoryEntry, "id" | "sectionId">>,
): BotsArrangeInput {
  return {
    sectionIds: sections.map((section) => section.id),
    bots: bots.map((bot) => ({ botId: bot.id, sectionId: bot.sectionId })),
  };
}

/**
 * Moves `botId` into `sectionId` (null: the default list), just before `beforeBotId`, or to the
 * end of that section when it is null or not in it. Unknown bots change nothing.
 */
export function moveBot(
  arrangement: BotsArrangeInput,
  botId: BotId,
  sectionId: BotSectionId | null,
  beforeBotId: BotId | null,
): BotsArrangeInput {
  const moving = arrangement.bots.find((bot) => bot.botId === botId);
  if (moving === undefined || beforeBotId === botId) return arrangement;
  const others = arrangement.bots.filter((bot) => bot.botId !== botId);
  const before = others.findIndex(
    (bot) => bot.botId === beforeBotId && bot.sectionId === sectionId,
  );
  const lastInSection = others.findLastIndex((bot) => bot.sectionId === sectionId);
  const index = before !== -1 ? before : lastInSection !== -1 ? lastInSection + 1 : others.length;
  return {
    ...arrangement,
    bots: [...others.slice(0, index), { botId, sectionId }, ...others.slice(index)],
  };
}

/** Moves section `sectionId` into the place of `ontoId`. Unknown ids change nothing. */
export function moveSection(
  arrangement: BotsArrangeInput,
  sectionId: BotSectionId,
  ontoId: BotSectionId,
): BotsArrangeInput {
  const from = arrangement.sectionIds.indexOf(sectionId);
  const to = arrangement.sectionIds.indexOf(ontoId);
  if (from === -1 || to === -1 || from === to) return arrangement;
  const sectionIds = arrangement.sectionIds.filter((id) => id !== sectionId);
  sectionIds.splice(to, 0, sectionId);
  return { ...arrangement, sectionIds };
}

/**
 * The directory as `arrangement` orders it, for showing a move before the server confirms it.
 * Falls back to the directory when they no longer name the same bots and sections.
 */
export function applyArrangement<
  S extends BotSection,
  B extends Pick<BotDirectoryEntry, "id" | "sectionId">,
>(
  sections: ReadonlyArray<S>,
  bots: ReadonlyArray<B>,
  arrangement: BotsArrangeInput | null,
): { readonly sections: ReadonlyArray<S>; readonly bots: ReadonlyArray<B> } {
  if (
    arrangement === null ||
    arrangement.sectionIds.length !== sections.length ||
    arrangement.bots.length !== bots.length
  ) {
    return { sections, bots };
  }
  const sectionById = new Map(sections.map((section) => [section.id as string, section]));
  const botById = new Map(bots.map((bot) => [bot.id as string, bot]));
  const nextSections = arrangement.sectionIds.flatMap((id) => sectionById.get(id) ?? []);
  const nextBots = arrangement.bots.flatMap(({ botId, sectionId }) => {
    const bot = botById.get(botId);
    return bot === undefined ? [] : [{ ...bot, sectionId }];
  });
  return nextSections.length === sections.length && nextBots.length === bots.length
    ? { sections: nextSections, bots: nextBots }
    : { sections, bots };
}
