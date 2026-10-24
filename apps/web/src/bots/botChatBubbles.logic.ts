import { parseBotThreadId, type RunId } from "@t3tools/contracts";

import type { MessagesTimelineRow } from "../components/chat/MessagesTimeline.logic";

/** The user's messages sit on the end side of a bot conversation, the bot's on the start side. */
export type BubbleSide = "user" | "bot";

/**
 * Where one message bubble sits in its run of same-side messages. A bubble joins its neighbour
 * only when the two rows are adjacent messages from the same side: a fold, an error or any other
 * row between them starts a new group.
 */
export interface BubblePlacement {
  readonly side: BubbleSide;
  readonly joinsPrevious: boolean;
  readonly joinsNext: boolean;
}

/** How a row of a bot conversation renders: a message bubble, or a row kept as it is. */
export interface BotChatRowLayout {
  readonly bubble: BubblePlacement | null;
}

export interface BotBubbleLayout {
  readonly byRowId: ReadonlyMap<string, BotChatRowLayout>;
  /**
   * Changes only when some row's layout changes, not on every streamed token, so the list can
   * re-render the rows that stay exactly when a new message regroups them.
   */
  readonly key: string;
}

export const isBotChatThread = (threadId: string | null | undefined): boolean =>
  threadId != null && parseBotThreadId(threadId) !== null;

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

/** A failed run or an interrupted one is news the user needs, not work detail. */
const isProblemEvent = (row: Extract<MessagesTimelineRow, { kind: "event" }>): boolean => {
  const item = row.projectedItem.item;
  return (
    (item.type === "error" && item.status !== "completed") || item.type === "run_interrupt_result"
  );
};

/**
 * A bot conversation reads like a chat: its tool calls, work log and progress rows stay out of
 * the timeline (a composer indicator says the bot is working instead). A settled turn keeps its
 * small "Worked for" fold, and expanding it shows that turn's work again. Errors and interrupts
 * stay visible. Every other thread gets its rows back unchanged.
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
      case "turn-fold":
      case "attempt-fold":
      case "proposed-plan":
      case "html-render":
      case "mcp-app":
      case "worktree-setup":
        return true;
      case "event":
        if (isProblemEvent(row)) return true;
        break;
      case "assistant-meta":
        // The reply's copy, listen and time row: it belongs with the bubble above it.
        return true;
      default:
        break;
    }
    const runId = runIdOf(row);
    return runId != null && expandedRuns.has(runId);
  });
}

const sideOf = (row: MessagesTimelineRow | undefined): BubbleSide | null => {
  if (row?.kind !== "message") return null;
  if (row.message.role === "user") return "user";
  if (row.message.role === "assistant") return "bot";
  return null;
};

// One shared object per layout: a row's context value keeps its identity across renders, so rows
// whose layout did not change skip re-rendering.
const NOT_A_BUBBLE: BotChatRowLayout = { bubble: null };
const BUBBLES = new Map<string, BotChatRowLayout>(
  (["user", "bot"] as const).flatMap((side) =>
    [false, true].flatMap((joinsPrevious) =>
      [false, true].map(
        (joinsNext) =>
          [
            bubbleCode(side, joinsPrevious, joinsNext),
            { bubble: { side, joinsPrevious, joinsNext } },
          ] as const,
      ),
    ),
  ),
);

function bubbleCode(side: BubbleSide, joinsPrevious: boolean, joinsNext: boolean): string {
  return `${side === "user" ? "u" : "b"}${joinsPrevious ? 1 : 0}${joinsNext ? 1 : 0}`;
}

/**
 * The layout of every row of a bot conversation, keyed by row id. Null for every other thread,
 * which keeps the regular timeline layout.
 */
export function botBubbleLayout(
  threadId: string | null | undefined,
  rows: ReadonlyArray<MessagesTimelineRow>,
): BotBubbleLayout | null {
  if (!isBotChatThread(threadId)) return null;
  const byRowId = new Map<string, BotChatRowLayout>();
  const codes: Array<string> = [];
  rows.forEach((row, index) => {
    const side = sideOf(row);
    if (side === null) {
      byRowId.set(row.id, NOT_A_BUBBLE);
      return;
    }
    const code = bubbleCode(
      side,
      sideOf(rows[index - 1]) === side,
      sideOf(rows[index + 1]) === side,
    );
    byRowId.set(row.id, BUBBLES.get(code)!);
    codes.push(`${row.id}=${code}`);
  });
  return { byRowId, key: codes.join("\n") };
}
