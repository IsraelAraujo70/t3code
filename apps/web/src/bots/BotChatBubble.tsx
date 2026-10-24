import { createContext } from "react";

import { cn } from "../lib/utils";
import type { BubblePlacement } from "@t3tools/client-runtime/bot-chat";

import type { BotChatRowLayout } from "./botChatBubbles.logic";

/**
 * The bot-conversation layout of the timeline row being rendered. Null outside bot conversations,
 * so every other thread keeps the regular timeline.
 */
export const BotChatRowCtx = createContext<BotChatRowLayout | null>(null);

/**
 * Corner shape of a bubble: round except on the speaker's side, where a bubble that continues a
 * group meets the previous one with a tight corner, and the bottom corner stays tight like a tail.
 */
export function botBubbleShapeClass(placement: BubblePlacement): string {
  return placement.side === "bot"
    ? cn("rounded-2xl rounded-es-md", placement.joinsPrevious && "rounded-ss-md")
    : cn("rounded-2xl rounded-ee-md", placement.joinsPrevious && "rounded-se-md");
}

/** Bottom spacing of a bubble row: bubbles of one group sit close together. */
export function botBubbleRowSpacingClass(placement: BubblePlacement): string {
  return placement.joinsNext ? "pb-1" : "pb-2";
}

/**
 * A bot reply's bubble, start-aligned and as wide as its content up to a limit. Its action row
 * (copy, listen, time) renders below it.
 */
export function botAssistantBubbleClass(placement: BubblePlacement): string {
  return cn(
    "w-fit max-w-[85%] border border-border/70 bg-card px-3.5 py-2.5 text-card-foreground",
    botBubbleShapeClass(placement),
  );
}

/** A settled bot turn's "Worked for …" fold: a small muted toggle instead of a full-width rule. */
export function BotTurnFold({
  label,
  expanded,
  onToggle,
}: {
  readonly label: string;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      data-scroll-anchor-ignore
      onClick={onToggle}
      className="mb-1 rounded-md px-1 text-xs text-muted-foreground tabular-nums transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
    >
      {label}
      {expanded ? " · hide details" : ""}
    </button>
  );
}
