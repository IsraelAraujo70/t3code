import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { isThreadWorking } from "@t3tools/client-runtime/state/thread-inbox";
import { parseBotThreadId } from "@t3tools/contracts";

import {
  resolveThreadListV2Status,
  threadHasUnseenCompletion,
} from "../features/threads/threadListV2";

// Mirrors apps/web/src/bots/BotsSidebarSection.logic.ts on top of the mobile thread list's own
// status classifiers, so a bot reads the same on the phone as in the desktop sidebar.

export type BotStatus = {
  readonly kind: "needs-you" | "working" | "idle";
  readonly detail: string | null;
};

/** The parts of a thread shell a bot row reads. */
export type BotThreadShell = Pick<
  EnvironmentThreadShell,
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

const IDLE: BotStatus = { kind: "idle", detail: null };

/**
 * Collapses the thread list's classifiers into a bot's three states. Requests and failures need
 * the user, then running or background work, then a finished run the user has not opened. A null
 * shell (not loaded yet, or the conversation has not started) is idle.
 */
export function botStatusFromShell(shell: BotThreadShell | null): BotStatus {
  if (shell === null) return IDLE;
  switch (resolveThreadListV2Status(shell)) {
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
  if (threadHasUnseenCompletion(shell)) return { kind: "needs-you", detail: "Finished" };
  return IDLE;
}

/** The latest run's completion, else the thread's last update; null before the thread loads. */
export function botActivityAt(shell: BotThreadShell | null): string | null {
  if (shell === null) return null;
  return shell.latestRun?.completedAt ?? shell.updatedAt;
}

/**
 * The thread list without bot conversations (`bot:<botId>:<generation>`, every generation): they
 * show in the Bots section instead. Returns the input array when nothing is removed so memoized
 * consumers keep their identity.
 */
export function withoutBotThreads<T extends Pick<EnvironmentThreadShell, "id">>(
  threads: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const kept = threads.filter((thread) => parseBotThreadId(thread.id) === null);
  return kept.length === threads.length ? threads : kept;
}
