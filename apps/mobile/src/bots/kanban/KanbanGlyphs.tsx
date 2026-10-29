import type { KanbanGroupIcon, ThreadCardStatus } from "@t3tools/client-runtime/kanban-board";
import type { BotDirectoryEntry, KanbanLabel, LinearStateType } from "@t3tools/contracts";
import { Image } from "expo-image";
import type { ReactNode } from "react";
import { View, type ColorValue } from "react-native";
import Svg, { Circle, Path, Rect } from "react-native-svg";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";
import { BotAvatar } from "../BotAvatar";
import {
  personDisplay,
  personInitials,
  priorityGlyph,
  statusGlyph,
  type KanbanLookups,
  type KanbanPersonDisplay,
} from "@t3tools/client-runtime/kanban-display";

/** Theme colors the glyphs need, read once by the screen rather than per glyph. */
export interface KanbanGlyphColors {
  readonly muted: ColorValue;
  readonly urgent: ColorValue;
}

const PRIORITY_BARS = [
  { x: 1.5, y: 8, height: 4.5 },
  { x: 5.5, y: 5, height: 7.5 },
  { x: 9.5, y: 1.5, height: 11 },
];

/** Linear's status glyph (see `statusGlyph`). */
export function KanbanStatusIcon(props: {
  readonly stateType: LinearStateType;
  readonly color: ColorValue;
  readonly progress?: number;
  readonly size?: number;
}) {
  const size = props.size ?? 14;
  const glyph = statusGlyph(props.stateType, props.progress);
  const { color } = props;
  return (
    <Svg width={size} height={size} viewBox="0 0 14 14">
      {glyph.kind === "dashed" ? (
        <Circle
          cx={7}
          cy={7}
          r={6}
          stroke={color}
          strokeWidth={1.5}
          strokeDasharray="1.4 1.74"
          fill="none"
        />
      ) : glyph.kind === "ring" ? (
        <>
          <Circle cx={7} cy={7} r={6} stroke={color} strokeWidth={1.5} fill="none" />
          {glyph.fill === "full" ? (
            <Circle cx={7} cy={7} r={3.5} fill={color} />
          ) : glyph.fill === "none" ? null : (
            <Path d={glyph.fill.path} fill={color} />
          )}
        </>
      ) : (
        <>
          <Circle cx={7} cy={7} r={6.75} fill={color} />
          <Path
            d={glyph.mark}
            stroke="white"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </>
      )}
    </Svg>
  );
}

/** Linear's priority glyph (see `priorityGlyph`). */
export function KanbanPriorityIcon(props: {
  readonly priority: number;
  readonly colors: KanbanGlyphColors;
  readonly size?: number;
}) {
  const size = props.size ?? 14;
  const glyph = priorityGlyph(props.priority);
  const { muted, urgent } = props.colors;
  return (
    <Svg width={size} height={size} viewBox="0 0 14 14">
      {glyph.kind === "urgent" ? (
        <>
          <Rect x={0.5} y={0.5} width={13} height={13} rx={3} fill={urgent} />
          <Rect x={6.25} y={3} width={1.5} height={5} rx={0.75} fill="white" />
          <Circle cx={7} cy={10.25} r={0.9} fill="white" />
        </>
      ) : glyph.kind === "none" ? (
        PRIORITY_BARS.map((bar) => (
          <Rect key={bar.x} x={bar.x} y={6.25} width={3} height={1.5} rx={0.5} fill={muted} />
        ))
      ) : (
        PRIORITY_BARS.map((bar, index) => (
          <Rect
            key={bar.x}
            x={bar.x}
            y={bar.y}
            width={3}
            height={bar.height}
            rx={1}
            fill={muted}
            opacity={index < glyph.filled ? 1 : 0.3}
          />
        ))
      )}
    </Svg>
  );
}

/** A person's image, their initials, a bot's face, or a dashed ring for nobody. */
export function KanbanAvatar(props: {
  readonly person: KanbanPersonDisplay | null;
  readonly colors: KanbanGlyphColors;
  readonly size?: number;
}) {
  const size = props.size ?? 18;
  const { person } = props;
  if (person === null) {
    return (
      <Svg width={size} height={size} viewBox="0 0 14 14">
        <Circle
          cx={7}
          cy={7}
          r={6.25}
          stroke={props.colors.muted}
          strokeWidth={1.2}
          strokeDasharray="2 1.6"
          fill="none"
        />
      </Svg>
    );
  }
  if (person.botId !== null) return <BotAvatar botId={person.botId} size={size} />;
  if (person.avatarUrl !== null) {
    return (
      <Image
        source={{ uri: person.avatarUrl }}
        recyclingKey={person.avatarUrl}
        accessibilityLabel={person.name}
        style={{ width: size, height: size, borderRadius: size / 2 }}
        cachePolicy="memory-disk"
      />
    );
  }
  return (
    <View
      className="items-center justify-center rounded-full bg-subtle-strong"
      style={{ width: size, height: size }}
    >
      <Text className="font-t3-medium text-foreground-muted" style={{ fontSize: size * 0.42 }}>
        {personInitials(person.name)}
      </Text>
    </View>
  );
}

/** The outline pill every card property sits in. */
export function KanbanPill(props: {
  readonly children: ReactNode;
  readonly tone?: "default" | "danger";
}) {
  return (
    <View
      className={cn(
        "h-5 shrink-0 flex-row items-center gap-1 rounded-full border px-1.5",
        props.tone === "danger" ? "border-danger-border" : "border-border",
      )}
    >
      {props.children}
    </View>
  );
}

export function KanbanPillText(props: {
  readonly children: ReactNode;
  readonly tone?: "default" | "danger";
}) {
  return (
    <Text
      numberOfLines={1}
      className={cn(
        "max-w-36 text-2xs",
        props.tone === "danger" ? "text-danger-foreground" : "text-foreground-muted",
      )}
    >
      {props.children}
    </Text>
  );
}

export function KanbanDot(props: { readonly color: string | null; readonly size?: number }) {
  const size = props.size ?? 8;
  return (
    <View
      className={cn("rounded-full", props.color === null && "bg-icon-subtle")}
      style={{
        width: size,
        height: size,
        ...(props.color === null ? {} : { backgroundColor: props.color }),
      }}
    />
  );
}

/** A label as Linear draws it: a colored dot and the name in an outline pill. */
export function KanbanLabelPill(props: { readonly label: KanbanLabel }) {
  return (
    <KanbanPill>
      <KanbanDot color={props.label.color} />
      <KanbanPillText>{props.label.name}</KanbanPillText>
    </KanbanPill>
  );
}

export const THREAD_STATUS_DOT: Record<ThreadCardStatus, string> = {
  approval: "bg-amber-500",
  input: "bg-indigo-500",
  failed: "bg-red-500",
  working: "bg-sky-500",
  settled: "bg-emerald-500",
};

export function KanbanThreadDot(props: { readonly status: ThreadCardStatus }) {
  return <View className={cn("size-1.5 rounded-full", THREAD_STATUS_DOT[props.status])} />;
}

/** Bots responsible for a ticket, as tiny overlapping faces. */
export function KanbanBotFaces(props: {
  readonly bots: ReadonlyArray<BotDirectoryEntry>;
  readonly size?: number;
}) {
  if (props.bots.length === 0) return null;
  return (
    <View
      className="flex-row"
      accessibilityLabel={`Responsible: ${props.bots.map((bot) => bot.name).join(", ")}`}
    >
      {props.bots.map((bot, index) => (
        <View key={bot.id} style={index > 0 ? { marginLeft: -4 } : undefined}>
          <BotAvatar botId={bot.id} size={props.size ?? 14} />
        </View>
      ))}
    </View>
  );
}

/** A group's leading icon: in filter pickers and column chips. */
export function KanbanGroupIconView(props: {
  readonly icon: KanbanGroupIcon;
  readonly lookups: KanbanLookups;
  readonly colors: KanbanGlyphColors;
  readonly size?: number;
}) {
  const { icon } = props;
  const size = props.size ?? 14;
  switch (icon.kind) {
    case "status":
      return <KanbanStatusIcon stateType={icon.stateType} color={icon.color} size={size} />;
    case "person":
      return (
        <KanbanAvatar
          person={icon.personId === null ? null : personDisplay(props.lookups, icon.personId)}
          colors={props.colors}
          size={size}
        />
      );
    case "priority":
      return <KanbanPriorityIcon priority={icon.priority} colors={props.colors} size={size} />;
    case "label":
      return <KanbanDot color={icon.color} size={Math.round(size * 0.65)} />;
    case "project":
      return <KanbanDot color={icon.color} size={Math.round(size * 0.75)} />;
    case "cycle":
      return (
        <SymbolView name="arrow.clockwise" size={size} tintColorClassName="accent-icon-muted" />
      );
    case "threadStatus": {
      const dot = Math.round(size * 0.55);
      return (
        <View
          className={cn(
            "rounded-full",
            icon.status === null
              ? "border border-foreground-muted"
              : THREAD_STATUS_DOT[icon.status],
          )}
          style={{ width: dot, height: dot }}
        />
      );
    }
    case "none":
      return null;
  }
}
