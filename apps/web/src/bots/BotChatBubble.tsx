import { createContext, type ReactNode } from "react";

import { cn } from "../lib/utils";
import type { BotChatRowLayout, BubblePlacement } from "./botChatBubbles.logic";

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
  return placement.joinsNext ? "pb-1" : "pb-4";
}

/** A bot reply as a start-aligned bubble, with its action row (copy, listen, time) below it. */
export function BotAssistantBubble({
  placement,
  meta,
  children,
}: {
  readonly placement: BubblePlacement;
  readonly meta: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col items-start gap-1" data-bot-bubble="bot">
      <div
        className={cn(
          "relative min-w-0 max-w-[85%] border border-border/70 bg-card px-3.5 py-2.5 text-card-foreground",
          botBubbleShapeClass(placement),
        )}
      >
        {children}
      </div>
      {meta === null ? null : <div className="ps-1">{meta}</div>}
    </div>
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
      className="mb-1 rounded-md px-1 text-2xs text-muted-foreground/70 tabular-nums transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
    >
      {label}
      {expanded ? " · hide details" : ""}
    </button>
  );
}
