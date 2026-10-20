import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { isThreadWorking } from "@t3tools/client-runtime/state/thread-inbox";
import type { BotDirectoryEntry, EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";

import { hasUnseenCompletion, resolveSidebarThreadStatus } from "../components/Sidebar.logic";
import type { SidebarThreadSummary } from "../types";

export type BotStatus = {
  readonly kind: "needs-you" | "working" | "idle";
  readonly detail: string | null;
};

/** The parts of a thread shell a bot row reads. */
export type BotThreadShell = Pick<
  SidebarThreadSummary,
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
>;

export interface BotRowModel {
  readonly bot: BotDirectoryEntry;
  readonly threadRef: ScopedThreadRef;
  readonly status: BotStatus;
  /** When the bot last did something, for the row's relative time; null before its thread loads. */
  readonly activityAt: string | null;
}

const IDLE: BotStatus = { kind: "idle", detail: null };

/**
 * Collapses the sidebar's thread classifiers into a bot's three states. Requests and failures
 * need the user, then running or background work, then a finished run the user has not opened.
 * A null shell (not loaded yet, or the conversation has not started) is idle.
 */
export function botStatusFromShell(shell: BotThreadShell | null): BotStatus {
  if (shell === null) return IDLE;
  switch (resolveSidebarThreadStatus(shell)) {
    case "approval":
      return { kind: "needs-you", detail: "Needs approval" };
    case "input":
      return { kind: "needs-you", detail: "Waiting for your answer" };
    case "failed":
      return { kind: "needs-you", detail: "Failed" };
    case "limited":
      return { kind: "needs-you", detail: "Usage limit" };
  }
  if (isThreadWorking(shell)) return { kind: "working", detail: "Working" };
  if (hasUnseenCompletion(shell)) return { kind: "needs-you", detail: "Finished" };
  return IDLE;
}

/** How many bots are waiting on the user, for the section header and tab badges. */
export function countBotsNeedingYou(statuses: ReadonlyArray<BotStatus>): number {
  return statuses.filter((status) => status.kind === "needs-you").length;
}

/** The latest run's completion, else the thread's last update. */
export function botActivityAt(shell: BotThreadShell | null): string | null {
  if (shell === null) return null;
  return shell.latestRun?.completedAt ?? shell.updatedAt;
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
    return {
      bot,
      threadRef: scopeThreadRef(environmentId, bot.homeThreadId),
      status: botStatusFromShell(shell),
      activityAt: botActivityAt(shell),
    };
  });
}
