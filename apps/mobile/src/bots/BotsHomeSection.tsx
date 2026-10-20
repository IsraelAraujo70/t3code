import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { BotDirectoryEntry, EnvironmentId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import type { ReactNode } from "react";
import { Platform, View } from "react-native";

import { SymbolView, type AppSymbolName } from "../components/AppSymbol";
import { AppText as Text } from "../components/AppText";
import { RowPressable } from "../components/RowPressable";
import {
  useAtomValueWhileVisible,
  useHomeRouteVisible,
} from "../features/home/home-route-visibility";
import { useHomeThreadSelection } from "../features/home/home-thread-navigation";
import { ThreadListV2SectionDivider } from "../features/threads/thread-list-v2-items";
import { THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME } from "../features/threads/thread-list-v2-row-appearance";
import { cn } from "../lib/cn";
import { relativeTime } from "../lib/time";
import { environmentThreadShells } from "../state/threads";
import { botActivityAt, botStatusFromShell, type BotStatus } from "./bots.logic";
import { useBotDirectory } from "./state";

const COMPUTER_SYMBOL: AppSymbolName = { ios: "desktopcomputer", android: "desktop_windows" };

// Same hues as the thread list's status labels: amber needs the user, sky is working.
const STATUS_TONE = {
  "needs-you": {
    icon: "exclamationmark.circle",
    className: "text-warning-foreground",
    iconTintClassName: "accent-warning-foreground",
  },
  working: {
    icon: "circle.dashed",
    className: "text-adaptive-sky-600-400",
    iconTintClassName: "accent-adaptive-sky-600-400",
  },
} as const satisfies Record<
  Exclude<BotStatus["kind"], "idle">,
  { icon: AppSymbolName; className: string; iconTintClassName: string }
>;

// The home thread rows' surface: rounded inset cards on Android, flat edge-to-edge rows on iOS.
const ROW_CONTAINER_CLASS_NAME =
  Platform.OS === "android" ? "mx-2 my-0.5 overflow-hidden rounded-[20px]" : undefined;
const ROW_CLASS_NAME = Platform.OS === "android" ? "rounded-[20px] bg-screen" : "bg-screen";

/** A tappable row shaped like a thread row: leading tile, title, optional status line, trailer. */
function BotsSectionRow(props: {
  readonly accessibilityLabel: string;
  readonly accessibilityHint: string;
  readonly leading: ReactNode;
  readonly title: string;
  readonly subtitle: ReactNode;
  readonly trailing: ReactNode;
  readonly onPress: () => void;
}) {
  return (
    <View className={ROW_CONTAINER_CLASS_NAME}>
      <RowPressable
        accessibilityRole="button"
        accessibilityLabel={props.accessibilityLabel}
        accessibilityHint={props.accessibilityHint}
        className={ROW_CLASS_NAME}
        interactionClassName="bg-row-hover"
        onPress={props.onPress}
      >
        <View className={cn(THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME, "flex-row items-center gap-3")}>
          <View className="size-10 items-center justify-center rounded-full bg-subtle">
            {props.leading}
          </View>
          <View className="min-w-0 flex-1">
            <Text className="text-base font-t3-medium text-foreground" numberOfLines={1}>
              {props.title}
            </Text>
            {props.subtitle}
          </View>
          {props.trailing}
        </View>
      </RowPressable>
    </View>
  );
}

function BotRow(props: {
  readonly bot: BotDirectoryEntry;
  readonly environmentId: EnvironmentId;
  readonly visible: boolean;
  readonly onOpen: () => void;
}) {
  const { bot } = props;
  // One subscription per bot thread, held while Home is covered: a streaming bot turn must not
  // re-render the hidden Home list.
  const shell = useAtomValueWhileVisible(
    environmentThreadShells.threadShellAtom(scopeThreadRef(props.environmentId, bot.homeThreadId)),
    props.visible,
  );
  const status = botStatusFromShell(shell);
  const activityAt = botActivityAt(shell);
  const tone = status.kind === "idle" ? null : STATUS_TONE[status.kind];
  return (
    <BotsSectionRow
      accessibilityLabel={status.detail === null ? bot.name : `${bot.name}, ${status.detail}`}
      accessibilityHint="Opens the bot's conversation"
      leading={<Text className="text-xl">{bot.emoji}</Text>}
      title={bot.name}
      subtitle={
        tone !== null && status.detail !== null ? (
          <View className="mt-0.5 flex-row items-center gap-1">
            <SymbolView
              name={tone.icon}
              size={12}
              tintColorClassName={tone.iconTintClassName}
              type="monochrome"
              weight="semibold"
            />
            <Text className={cn("text-xs font-t3-medium", tone.className)} numberOfLines={1}>
              {status.detail}
            </Text>
          </View>
        ) : null
      }
      trailing={
        status.kind === "working" || activityAt === null ? null : (
          <Text className={"text-xs tabular-nums text-foreground-tertiary"}>
            {relativeTime(activityAt)}
          </Text>
        )
      }
      onPress={props.onOpen}
    />
  );
}

function BotsNotice(props: { readonly children: string }) {
  return <Text className="px-5 py-2 text-sm text-foreground-muted">{props.children}</Text>;
}

/**
 * The bots host's bots above the home thread list, in directory order, then a row that opens the
 * host's screen. Read-only: bots and memories are managed from desktop Settings. Each bot row
 * opens its main conversation in the ordinary Thread route.
 */
export function BotsHomeSection(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const { directory, error } = useBotDirectory(environmentId);
  const visible = useHomeRouteVisible();
  const selectThread = useHomeThreadSelection();
  const navigation = useNavigation();
  return (
    <View>
      <ThreadListV2SectionDivider label="Bots" />
      {directory === null ? (
        <BotsNotice>{error === null ? "Loading bots…" : `Bots unavailable: ${error}`}</BotsNotice>
      ) : directory.bots.length === 0 ? (
        <BotsNotice>No bots yet. Create one in T3 Code on your computer.</BotsNotice>
      ) : (
        directory.bots.map((bot) => (
          <BotRow
            key={bot.id}
            bot={bot}
            environmentId={environmentId}
            visible={visible}
            onOpen={() => selectThread({ environmentId, id: bot.homeThreadId })}
          />
        ))
      )}
      <BotsSectionRow
        accessibilityLabel="Computer"
        accessibilityHint="Shows the bots' computer screen live"
        leading={
          <SymbolView
            name={COMPUTER_SYMBOL}
            size={18}
            tintColorClassName="accent-foreground-muted"
            type="monochrome"
          />
        }
        title="Computer"
        subtitle={null}
        trailing={
          <SymbolView
            name="chevron.right"
            size={12}
            tintColorClassName="accent-foreground-tertiary"
            type="monochrome"
          />
        }
        onPress={() => navigation.navigate("BotsComputer", { environmentId })}
      />
      <ThreadListV2SectionDivider label="Threads" />
    </View>
  );
}
