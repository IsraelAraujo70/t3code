/**
 * Shared rules for showing a bot conversation as a chat on web and mobile: which threads are bot
 * conversations, which turn items stay visible once tool calls are hidden, and how message
 * bubbles group.
 */
import {
  botThreadId,
  parseBotThreadId,
  type BotHistoryEntry,
  type BotId,
  type OrchestrationV2TurnItem,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** The user's messages sit on the end side of a bot conversation, the bot's on the start side. */
export type BubbleSide = "user" | "bot";

/**
 * Where one message bubble sits in its run of same-side messages. A bubble joins its neighbour
 * only when the two rows are adjacent messages from the same side: any other row between them
 * starts a new group.
 */
export interface BubblePlacement {
  readonly side: BubbleSide;
  readonly joinsPrevious: boolean;
  readonly joinsNext: boolean;
}

export interface BubbleLayout {
  /** Only rows that are bubbles have an entry. */
  readonly byId: ReadonlyMap<string, BubblePlacement>;
  /**
   * Changes only when some bubble's placement changes, not on every streamed token, so a list can
   * re-render the rows that stay exactly when a new message regroups them.
   */
  readonly key: string;
}

export const isBotChatThread = (threadId: string | null | undefined): boolean =>
  threadId != null && parseBotThreadId(threadId) !== null;

/**
 * Turn items a bot conversation shows even though it hides tool calls: a failed or interrupted run
 * is news the user needs, and a secret request waits on them.
 */
export const showsInBotChat = (item: Pick<OrchestrationV2TurnItem, "type" | "status">) =>
  (item.type === "error" && item.status !== "completed") ||
  item.type === "run_interrupt_result" ||
  item.type === "secret_request";

const code = (side: BubbleSide, joinsPrevious: boolean, joinsNext: boolean) =>
  `${side === "user" ? "u" : "b"}${joinsPrevious ? 1 : 0}${joinsNext ? 1 : 0}`;

// One shared object per placement keeps a row's placement identical across renders, so rows whose
// placement did not change can skip re-rendering.
const PLACEMENTS = new Map<string, BubblePlacement>(
  (["user", "bot"] as const).flatMap((side) =>
    [false, true].flatMap((joinsPrevious) =>
      [false, true].map(
        (joinsNext) =>
          [code(side, joinsPrevious, joinsNext), { side, joinsPrevious, joinsNext }] as const,
      ),
    ),
  ),
);

/** Groups adjacent same-side rows; `sideOf` returns null for rows that are not bubbles. */
export function bubbleLayout<Row extends { readonly id: string }>(
  rows: ReadonlyArray<Row>,
  sideOf: (row: Row) => BubbleSide | null,
): BubbleLayout {
  const sides = rows.map(sideOf);
  const byId = new Map<string, BubblePlacement>();
  const codes: Array<string> = [];
  rows.forEach((row, index) => {
    const side = sides[index];
    if (side == null) return;
    const placement = code(side, sides[index - 1] === side, sides[index + 1] === side);
    byId.set(row.id, PLACEMENTS.get(placement)!);
    codes.push(`${row.id}=${placement}`);
  });
  return { byId, key: codes.join("\n") };
}

/**
 * Where a bot conversation stands among its bot's generations. Only the current one takes
 * messages; an earlier one is archived and read-only.
 */
export type BotGenerationView =
  | {
      readonly kind: "current";
      readonly botId: BotId;
      /** The generation before this one, which a fresh, empty conversation points back to. */
      readonly previousThreadId: ThreadId | null;
    }
  | { readonly kind: "earlier"; readonly botId: BotId; readonly currentThreadId: ThreadId };

/**
 * Null for a thread that is not a bot conversation, and while the bot's current generation is
 * unknown (directory not loaded, bot gone), so neither client guesses which one takes messages.
 */
export function botGenerationView(
  threadId: string | null | undefined,
  homeGeneration: number | null,
): BotGenerationView | null {
  const parsed = threadId == null ? null : parseBotThreadId(threadId);
  if (parsed === null || homeGeneration === null) return null;
  // A newer generation than the directory knows is the current one arriving before its update.
  if (parsed.generation >= homeGeneration) {
    return {
      kind: "current",
      botId: parsed.botId,
      previousThreadId:
        parsed.generation > 1 ? botThreadId(parsed.botId, parsed.generation - 1) : null,
    };
  }
  return {
    kind: "earlier",
    botId: parsed.botId,
    currentThreadId: botThreadId(parsed.botId, homeGeneration),
  };
}

const DAY_AND_TIME = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const dayAndTime = (iso: string) =>
  DAY_AND_TIME.format(DateTime.toEpochMillis(DateTime.makeUnsafe(iso)));

/** The span an earlier generation covers, in the user's locale. */
export const botHistoryRange = (entry: Pick<BotHistoryEntry, "startedAt" | "endedAt">) =>
  entry.endedAt === null
    ? `From ${dayAndTime(entry.startedAt)}`
    : `${dayAndTime(entry.startedAt)} – ${dayAndTime(entry.endedAt)}`;

/** Copy for a renewed conversation that has no messages yet, shared by web and mobile. */
export const BOT_RENEWED_COPY = {
  title: "New conversation",
  detail: "Earlier messages are in History.",
  action: "Open previous conversation",
} as const;

/** Copy for the bar that replaces the composer in an earlier, read-only generation. */
export const BOT_EARLIER_COPY = {
  detail: "Earlier conversation. Read only.",
  action: "Open current conversation",
} as const;
