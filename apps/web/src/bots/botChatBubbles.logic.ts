import {
  bubbleLayout,
  isBotChatThread,
  showsInBotChat,
  type BubblePlacement,
  type BubbleSide,
} from "@t3tools/client-runtime/bot-chat";
import type { RunId } from "@t3tools/contracts";

import type { MessagesTimelineRow } from "../components/chat/MessagesTimeline.logic";

/** How a row of a bot conversation renders: a message bubble, or a row kept as it is. */
export interface BotChatRowLayout {
  readonly bubble: BubblePlacement | null;
}

export interface BotBubbleLayout {
  readonly byRowId: ReadonlyMap<string, BotChatRowLayout>;
  /** Changes only when a bubble's placement changes; see bubbleLayout. */
  readonly key: string;
}

const runIdOf = (row: MessagesTimelineRow): RunId | null | undefined => {
  switch (row.kind) {
    case "message":
      return row.message.runId;
    case "work":
      return row.groupedEntries.find((entry) => entry.runId != null)?.runId;
    case "work-live":
      return row.entry.runId;
    case "work-toggle":
      return row.runId;
    case "event":
      return row.projectedItem.item.runId;
    default:
      return undefined;
  }
};

/**
 * A bot conversation reads like a chat: its tool calls, work log and progress rows stay out of
 * the timeline (a composer indicator says the bot is working instead). A settled turn keeps its
 * small "Worked for" fold, and expanding it shows that turn's work again. Errors, interrupts and
 * secret requests stay visible. Every other thread gets its rows back unchanged.
 */
export function botChatRows(
  threadId: string | null | undefined,
  rows: MessagesTimelineRow[],
): MessagesTimelineRow[] {
  if (!isBotChatThread(threadId)) return rows;
  const expandedRuns = new Set<RunId>();
  for (const row of rows) {
    if (row.kind === "turn-fold" && row.expanded) expandedRuns.add(row.runId);
  }
  return rows.filter((row) => {
    switch (row.kind) {
      case "message":
      case "assistant-meta":
      case "turn-fold":
      case "attempt-fold":
      case "proposed-plan":
      case "html-render":
      case "mcp-app":
      case "worktree-setup":
        return true;
      case "event":
        if (showsInBotChat(row.projectedItem.item)) return true;
        break;
      default:
        break;
    }
    const runId = runIdOf(row);
    return runId != null && expandedRuns.has(runId);
  });
}

const sideOf = (row: MessagesTimelineRow): BubbleSide | null => {
  if (row.kind !== "message") return null;
  if (row.message.role === "user") return "user";
  if (row.message.role === "assistant") return "bot";
  return null;
};

// Shared row layouts keep a row's context value identical across renders, so rows whose layout
// did not change skip re-rendering.
const NOT_A_BUBBLE: BotChatRowLayout = { bubble: null };
const rowLayouts = new WeakMap<BubblePlacement, BotChatRowLayout>();
const rowLayoutFor = (bubble: BubblePlacement): BotChatRowLayout => {
  let layout = rowLayouts.get(bubble);
  if (layout === undefined) {
    layout = { bubble };
    rowLayouts.set(bubble, layout);
  }
  return layout;
};

/**
 * The layout of every row of a bot conversation, keyed by row id. Null for every other thread,
 * which keeps the regular timeline layout.
 */
export function botBubbleLayout(
  threadId: string | null | undefined,
  rows: ReadonlyArray<MessagesTimelineRow>,
): BotBubbleLayout | null {
  if (!isBotChatThread(threadId)) return null;
  const bubbles = bubbleLayout(rows, sideOf);
  const byRowId = new Map<string, BotChatRowLayout>();
  for (const row of rows) {
    const bubble = bubbles.byId.get(row.id);
    byRowId.set(row.id, bubble === undefined ? NOT_A_BUBBLE : rowLayoutFor(bubble));
  }
  return { byRowId, key: bubbles.key };
}
