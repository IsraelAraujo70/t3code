import {
  bubbleLayout,
  isBotChatThread,
  showsInBotChat,
  type BubbleLayout,
  type BubbleSide,
} from "@t3tools/client-runtime/bot-chat";
import type { RunId } from "@t3tools/contracts";

import type { ThreadFeedEntry } from "../lib/threadActivity";

/**
 * A bot conversation reads like a chat: its tool calls, work log and thinking rows stay out of
 * the feed (the floating working pill above the composer says the bot is busy). A settled turn
 * keeps its "Worked for" fold, and expanding it shows that turn's work again. Errors, interrupts
 * and secret requests stay visible. Every other thread gets its entries back unchanged.
 */
export function botChatFeed<Entry extends ThreadFeedEntry>(
  threadId: string | null | undefined,
  entries: ReadonlyArray<Entry>,
): ReadonlyArray<Entry> {
  if (!isBotChatThread(threadId)) return entries;
  const expandedRuns = new Set<RunId>();
  for (const entry of entries) {
    if (entry.type === "run-fold" && entry.expanded) expandedRuns.add(entry.runId);
  }
  return entries.filter((entry) => {
    switch (entry.type) {
      case "message":
      case "run-fold":
      case "html-render":
      case "mcp-app":
        return true;
      case "activity-group":
        if (entry.activities.some((activity) => showsInBotChat(activity.projectedItem.item)))
          return true;
        break;
      default:
        break;
    }
    return entry.runId !== null && expandedRuns.has(entry.runId);
  });
}

const sideOf = (entry: ThreadFeedEntry): BubbleSide | null =>
  entry.type !== "message" ? null : entry.message.role === "user" ? "user" : "bot";

/** Bubble placement of every message in a bot conversation; null for every other thread. */
export function botFeedBubbles(
  threadId: string | null | undefined,
  entries: ReadonlyArray<ThreadFeedEntry>,
): BubbleLayout | null {
  return isBotChatThread(threadId) ? bubbleLayout(entries, sideOf) : null;
}
