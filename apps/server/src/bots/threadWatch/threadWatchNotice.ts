import type {
  OrchestrationV2Notification,
  OrchestrationV2Run,
  OrchestrationV2RuntimeRequest,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { BOT_COMPACTION_MESSAGE_PREFIX } from "../compaction/botCompaction.ts";
import type { ThreadWatch } from "./ThreadWatchStore.ts";

/** What wakes a watcher: one of the watched thread's runs ended, or it waits on someone. */
export type WatchedChange =
  | { readonly type: "run"; readonly run: OrchestrationV2Run }
  | { readonly type: "request"; readonly request: OrchestrationV2RuntimeRequest };

export interface ThreadWatchNotice {
  /** Stable per watch and change, so a replayed event never wakes the watcher twice. */
  readonly key: string;
  readonly text: string;
  readonly notification: OrchestrationV2Notification;
}

const ENDED: Partial<Record<OrchestrationV2Run["status"], OrchestrationV2Notification["outcome"]>> =
  {
    completed: "completed",
    failed: "failed",
    cancelled: "cancelled",
    interrupted: "cancelled",
  };

/** Opens the id of every message that wakes a watcher. */
export const THREAD_WATCH_MESSAGE_PREFIX = "message:thread-watch:";

const MAX_TITLE = 80;

const shortTitle = (title: string | null) => {
  const trimmed = title?.trim() ?? "";
  if (trimmed.length === 0) return undefined;
  return trimmed.length > MAX_TITLE ? `${trimmed.slice(0, MAX_TITLE - 1)}…` : trimmed;
};

/**
 * Pure. The message that wakes a watcher for a change in the thread it watches, or null when the
 * change is not news: a run still going, a run that ended before the watch started, a request
 * that is no longer pending or needs no answer, or a thread watching itself. A run that a wake started never wakes
 * anyone, so two threads watching each other cannot wake each other forever.
 */
export function threadWatchNotice(
  watch: ThreadWatch,
  targetTitle: string | null,
  change: WatchedChange,
): ThreadWatchNotice | null {
  const target: ThreadId = watch.targetThreadId;
  if (watch.watcherThreadId === target) return null;
  const title = shortTitle(targetTitle);
  const named = title === undefined ? `Thread ${target}` : `Thread "${title}" (${target})`;
  const link = `[${title ?? target}](t3-thread://v1/${target})`;
  const prefix = `${watch.watcherThreadId}:${target}`;

  if (change.type === "run") {
    const outcome = ENDED[change.run.status];
    const endedAt = change.run.completedAt;
    if (outcome === undefined || endedAt === null) return null;
    if (change.run.userMessageId.startsWith(THREAD_WATCH_MESSAGE_PREFIX)) return null;
    // Saving memory and compacting are upkeep of a bot's own conversation, not news.
    if (change.run.userMessageId.startsWith(BOT_COMPACTION_MESSAGE_PREFIX)) return null;
    if (DateTime.formatIso(endedAt) < watch.createdAt) return null;
    return {
      key: `${prefix}:${change.run.id}:${change.run.status}`,
      text: `${named}, which you watch, ${change.run.status === "completed" ? "finished its run" : `stopped: its run ${change.run.status}`} (run ${change.run.id}). Read the result with t3_thread_read using threadId ${target}, then tell the user what happened if they are waiting on it. Link: ${link}. You keep watching it until you call unwatch_thread.`,
      notification: {
        source: { kind: "system" },
        outcome,
        summary: `Watched thread${title === undefined ? "" : ` "${title}"`} ${change.run.status}`,
      },
    };
  }

  // Client-run tools and sign-in refreshes do not wait on an answer in the conversation.
  if (change.request.status !== "pending") return null;
  if (change.request.kind === "dynamic_tool_call" || change.request.kind === "auth_refresh") {
    return null;
  }
  const asks =
    change.request.kind === "user_input" ? "is waiting for an answer" : "is waiting for approval";
  return {
    key: `${prefix}:${change.request.id}`,
    text: `${named}, which you watch, ${asks} and cannot continue until someone responds. Read it with t3_pending_request_read using threadId ${target} and requestId ${change.request.id}. Answer it with t3_pending_request_respond when the answer follows from the task or the user's instructions; otherwise ask the user, then answer it. If it is no longer pending, it was answered or dismissed. Link: ${link}.`,
    notification: {
      source: { kind: "system" },
      outcome: "updated",
      summary: `Watched thread${title === undefined ? "" : ` "${title}"`} ${asks}`,
    },
  };
}
