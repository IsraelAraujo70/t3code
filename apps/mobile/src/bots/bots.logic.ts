import { isBotChatThread } from "@t3tools/client-runtime/bot-chat";
import {
  botGroupKey,
  type BotGroup,
  type BotRowModel,
} from "@t3tools/client-runtime/bot-directory";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

/**
 * The thread list without bot conversations (`bot:<botId>:<generation>`, every generation): they
 * show in the Bots tab instead. Returns the input array when nothing is removed so memoized
 * consumers keep their identity.
 */
export function withoutBotThreads<T extends Pick<EnvironmentThreadShell, "id">>(
  threads: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const kept = threads.filter((thread) => !isBotChatThread(thread.id));
  return kept.length === threads.length ? threads : kept;
}

/**
 * The workspace tab a thread belongs to: a bot's conversation opens from the Bots tab. A draft
 * route has no thread id yet and belongs to Threads.
 */
export function workspaceTabForThread(threadId: string | undefined): "bots" | "threads" {
  return threadId !== undefined && isBotChatThread(threadId) ? "bots" : "threads";
}

/** One group of the Bots tab as it renders. */
export interface BotsTabGroup {
  readonly key: string;
  /** The header's label; null when the tab shows no headers. */
  readonly title: string | null;
  readonly collapsed: boolean;
  readonly rows: ReadonlyArray<BotRowModel>;
}

/**
 * The sidebar's groups as the Bots tab shows them. As on desktop, a list without sections needs
 * no header (it is the whole list) and cannot fold; the default list is titled "Bots".
 */
export function botsTabGroups(
  groups: ReadonlyArray<BotGroup>,
  collapsedKeys: ReadonlyArray<string>,
): BotsTabGroup[] {
  const headed = groups.some((group) => group.section !== null);
  return groups.map((group) => {
    const key = botGroupKey(group.section);
    return {
      key,
      title: headed ? (group.section?.name ?? "Bots") : null,
      collapsed: headed && collapsedKeys.includes(key),
      rows: group.rows,
    };
  });
}

/** `keys` with `key` folded if it was open, opened if it was folded. */
export function toggleCollapsedKey(keys: ReadonlyArray<string>, key: string): string[] {
  return keys.includes(key) ? keys.filter((entry) => entry !== key) : [...keys, key];
}
