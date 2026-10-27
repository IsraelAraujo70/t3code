import { useAtomSet, useAtomValue } from "@effect/atom-react";
import {
  groupBotRows,
  resolveBotRows,
  type BotRowModel,
  type BotThreadShell,
} from "@t3tools/client-runtime/bot-directory";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { BotDirectory, BotDirectoryEntry, EnvironmentId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";
import { AsyncResult, Atom } from "effect/reactivity";
import { useMemo, type ReactNode } from "react";
import { Platform, Pressable, View } from "react-native";

import { SymbolView, type AppSymbolName } from "../components/ui/AppSymbol";
import { AppText as Text } from "../components/ui/AppText";
import { RowPressable } from "../components/ui/RowPressable";
import { useAtomValueWhileVisible } from "../features/home/home-route-visibility";
import { useSelectWorkspaceDetail } from "../features/workspace/useSelectWorkspaceDetail";
import { THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME } from "../features/threads/thread-list-v2-row-appearance";
import { cn } from "../lib/cn";
import { relativeTime } from "../lib/time";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../state/preferences";
import { environmentThreadShells } from "../state/threads";
import { BotAvatar } from "./BotAvatar";
import { botsTabGroups, toggleCollapsedKey } from "./bots.logic";
import { useBotDirectory } from "./state";

const COMPUTER_SYMBOL: AppSymbolName = { ios: "desktopcomputer", android: "desktop_windows" };

// The home thread rows' surface: rounded inset cards on Android, flat edge-to-edge rows on iOS.
const ROW_CONTAINER_CLASS_NAME =
  Platform.OS === "android" ? "mx-2 my-0.5 overflow-hidden rounded-[20px]" : undefined;
const ROW_CLASS_NAME = Platform.OS === "android" ? "rounded-[20px] bg-screen" : "bg-screen";

/** A tappable row shaped like a thread row: leading tile, title, optional status line, trailer. */
function BotsListRow(props: {
  readonly accessibilityLabel: string;
  readonly accessibilityHint: string;
  readonly leading: ReactNode;
  readonly title: string;
  readonly dimmed?: boolean;
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
          {props.leading}
          <View className="min-w-0 flex-1">
            <Text
              className={cn(
                "text-base font-t3-medium",
                props.dimmed ? "text-foreground-muted" : "text-foreground",
              )}
              numberOfLines={1}
            >
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

/** As in the sidebar: a dot on the avatar's corner, primary while working, amber for a new reply. */
function StatusDot(props: { readonly row: BotRowModel }) {
  const { status } = props.row;
  const tone =
    status.kind === "working"
      ? "bg-primary"
      : status.kind === "needs-you" && status.attention === "unseen"
        ? "bg-warning"
        : null;
  if (tone === null) return null;
  return (
    <View
      className={cn(
        "absolute -bottom-0.5 -right-0.5 size-3 rounded-full border-2 border-screen",
        tone,
      )}
    />
  );
}

function BotRow(props: { readonly row: BotRowModel; readonly onOpen: () => void }) {
  const { bot, status, preview, activityAt } = props.row;
  const settled = status.kind === "settled";
  const request = status.kind === "needs-you" && status.attention === "request";
  return (
    <BotsListRow
      accessibilityLabel={preview === null ? bot.name : `${bot.name}, ${preview}`}
      accessibilityHint="Opens the bot's conversation"
      leading={
        <View
          className={cn(
            "size-10 items-center justify-center rounded-full bg-subtle",
            settled && "opacity-50",
          )}
        >
          <BotAvatar botId={bot.id} size={28} />
          <StatusDot row={props.row} />
        </View>
      }
      title={bot.name}
      dimmed={settled}
      subtitle={
        preview === null ? null : (
          <Text
            className={cn(
              "mt-0.5 text-xs font-t3-medium",
              request ? "text-warning-foreground" : "text-foreground-muted",
            )}
            numberOfLines={1}
          >
            {preview}
          </Text>
        )
      }
      trailing={
        status.kind === "working" || activityAt === null ? null : (
          <Text className="text-xs tabular-nums text-foreground-tertiary">
            {relativeTime(activityAt)}
          </Text>
        )
      }
      onPress={props.onOpen}
    />
  );
}

/** A section's header; tapping it folds or opens the section. Folded, it shows its bot count. */
function GroupHeader(props: {
  readonly title: string;
  readonly count: number;
  readonly collapsed: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.title}
      accessibilityState={{ expanded: !props.collapsed }}
      accessibilityHint={`${props.collapsed ? "Expands" : "Collapses"} the section.`}
      className="mb-1.5 mt-4 flex-row items-center gap-2.5 px-5"
      onPress={props.onToggle}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <Text className="text-xs font-t3-medium text-foreground-tertiary">
        {props.collapsed && props.count > 0 ? `${props.title} (${props.count})` : props.title}
      </Text>
      <View className="h-px flex-1 bg-border" />
      <SymbolView
        name="chevron.down"
        size={10}
        tintColorClassName="accent-foreground-muted"
        type="monochrome"
        style={{ transform: [{ rotate: props.collapsed ? "0deg" : "180deg" }] }}
      />
    </Pressable>
  );
}

function BotsNotice(props: { readonly children: string }) {
  return <Text className="px-5 py-2 text-sm text-foreground-muted">{props.children}</Text>;
}

/** Folded sections, kept on the device like the thread list's shelves. */
function useCollapsedBotGroups() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferences);
  const collapsed = loaded ? (preferences.value.collapsedBotGroups ?? []) : [];
  // A transform reads the optimistic value, so two quick taps toggle twice.
  const toggle = (key: string) => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => ({
        collapsedBotGroups: toggleCollapsedKey(current.collapsedBotGroups ?? [], key),
      }),
    });
  };
  return { collapsed, toggle } as const;
}

/**
 * The bots' main thread shells, one subscription for the list. Quiet shells skip streaming
 * ticks, which change nothing a row shows; while hidden the list holds its last value.
 */
function useBotThreadShells(
  environmentId: EnvironmentId,
  bots: ReadonlyArray<BotDirectoryEntry>,
  visible: boolean,
): ReadonlyArray<BotThreadShell> {
  const shellsAtom = useMemo(
    () =>
      Atom.make((get) =>
        bots.flatMap((bot) => {
          const shell = get(
            environmentThreadShells.quietThreadShellAtom(
              scopeThreadRef(environmentId, bot.homeThreadId),
            ),
          );
          return shell === null ? [] : [shell];
        }),
      ),
    [environmentId, bots],
  );
  return useAtomValueWhileVisible(shellsAtom, visible);
}

function BotGroups(props: {
  readonly environmentId: EnvironmentId;
  readonly directory: BotDirectory;
  readonly visible: boolean;
}) {
  const { environmentId, directory } = props;
  const shells = useBotThreadShells(environmentId, directory.bots, props.visible);
  const { collapsed, toggle } = useCollapsedBotGroups();
  const selectDetail = useSelectWorkspaceDetail();
  const groups = botsTabGroups(
    groupBotRows(directory.sections, resolveBotRows(directory.bots, environmentId, shells)),
    collapsed,
  );
  return groups.map((group) => (
    <View key={group.key}>
      {group.title === null ? null : (
        <GroupHeader
          title={group.title}
          count={group.rows.length}
          collapsed={group.collapsed}
          onToggle={() => toggle(group.key)}
        />
      )}
      {group.collapsed
        ? null
        : group.rows.map((row) => (
            <BotRow
              key={row.bot.id}
              row={row}
              onOpen={() =>
                selectDetail({
                  name: "Thread",
                  params: { environmentId, threadId: row.bot.homeThreadId },
                })
              }
            />
          ))}
    </View>
  ));
}

/**
 * The bots host's bots as the desktop sidebar lists them: the user's sections in order, each
 * foldable, bots inside by status and then the user's order, then a row that opens the host's
 * screen. Read-only: bots and sections are managed from desktop. Rows open the bot's main
 * conversation in the ordinary Thread route.
 */
export function BotsList(props: {
  readonly environmentId: EnvironmentId;
  /** False while the list is covered or its tab is hidden: rows stop following their threads. */
  readonly visible: boolean;
}) {
  const { environmentId } = props;
  const { directory, error } = useBotDirectory(environmentId);
  const navigation = useNavigation();
  return (
    <View>
      {directory === null ? (
        <BotsNotice>{error === null ? "Loading bots…" : `Bots unavailable: ${error}`}</BotsNotice>
      ) : directory.bots.length === 0 ? (
        <BotsNotice>No bots yet. Create one in T3 Code on your computer.</BotsNotice>
      ) : (
        <BotGroups environmentId={environmentId} directory={directory} visible={props.visible} />
      )}
      <View className="mt-3">
        <BotsListRow
          accessibilityLabel="Computer"
          accessibilityHint="Shows the bots' computer screen live"
          leading={
            <View className="size-10 items-center justify-center rounded-full bg-subtle">
              <SymbolView
                name={COMPUTER_SYMBOL}
                size={18}
                tintColorClassName="accent-foreground-muted"
                type="monochrome"
              />
            </View>
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
      </View>
    </View>
  );
}

/** Shown in place of the list when no connected environment hosts bots. */
export function BotsHostMissingNotice() {
  return <BotsNotice>Bots live on another machine that is not connected.</BotsNotice>;
}
