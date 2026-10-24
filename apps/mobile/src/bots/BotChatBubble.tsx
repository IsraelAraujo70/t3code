import type { BubblePlacement } from "@t3tools/client-runtime/bot-chat";
import type { ReactNode } from "react";
import { Pressable, View, type DimensionValue, type ViewStyle } from "react-native";

import { AppText as Text } from "../components/ui/AppText";

const ROUND = 20;
const TIGHT = 6;

/** Horizontal padding plus border on each side of a bot bubble, for sizing its markdown. */
export const BOT_BUBBLE_HORIZONTAL_INSET = 15;

/**
 * Corner shape of a bubble: round except on the speaker's side, where a bubble that continues a
 * group meets the previous one with a tight corner, and the bottom corner stays tight like a tail.
 */
export function botBubbleCorners(placement: BubblePlacement): ViewStyle {
  const top = placement.joinsPrevious ? TIGHT : ROUND;
  return placement.side === "bot"
    ? { borderRadius: ROUND, borderTopStartRadius: top, borderBottomStartRadius: TIGHT }
    : { borderRadius: ROUND, borderTopEndRadius: top, borderBottomEndRadius: TIGHT };
}

/** Bottom margin of a bubble row: bubbles of one group sit close together. */
export const botBubbleSpacingClass = (placement: BubblePlacement) =>
  placement.joinsNext ? "mb-1" : "mb-3";

/**
 * A bot reply's bubble. `width` pins the bubble to its maximum for content that cannot size
 * itself (a wide code block or table), as the user bubble does.
 */
export function BotAssistantBubble(props: {
  readonly placement: BubblePlacement;
  readonly maxWidth: DimensionValue;
  readonly pinWidth: boolean;
  readonly children: ReactNode;
}) {
  return (
    <View
      className="min-w-0 gap-1.5 self-start border border-border-subtle bg-card px-3.5 py-2.5"
      style={[
        botBubbleCorners(props.placement),
        { maxWidth: props.maxWidth },
        props.pinWidth ? { width: props.maxWidth } : null,
      ]}
    >
      {props.children}
    </View>
  );
}

/** A settled bot turn's "Worked for …" fold: a small muted toggle instead of a divider row. */
export function BotTurnFold(props: {
  readonly label: string;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: props.expanded }}
      onPress={props.onToggle}
      hitSlop={8}
      className="mb-1 self-start px-1 py-1"
    >
      <Text className="font-t3-medium text-xs tabular-nums text-foreground-muted">
        {props.label}
        {props.expanded ? " · hide details" : ""}
      </Text>
    </Pressable>
  );
}
