import { withoutHiddenThreads } from "@t3tools/client-runtime/bot-directory";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import type { SidebarBotsLayout } from "@t3tools/contracts/settings";

import { useBotDirectory, useBotsEnvironmentId } from "../state/bots";
import { isBotsBlockThread } from "./BotThreadIdentity";

type ListedThread = Pick<EnvironmentThreadShell, "environmentId" | "id">;

/**
 * The sidebar's thread list: without bot threads the Bots block lists instead and without hidden
 * side threads. A search sees every thread, so a hidden one can still be found.
 */
export function sidebarListedThreads<T extends ListedThread>(
  threads: ReadonlyArray<T>,
  options: {
    readonly layout: SidebarBotsLayout;
    readonly searching: boolean;
    readonly botsEnvironmentId: EnvironmentId | null;
    readonly hiddenThreadIds: ReadonlyArray<string> | undefined;
  },
): ReadonlyArray<T> {
  if (options.searching) return threads;
  const listed =
    options.layout === "mixed"
      ? threads
      : threads.filter((thread) => !isBotsBlockThread(thread.id, options.layout));
  return withoutHiddenThreads(listed, options.botsEnvironmentId, options.hiddenThreadIds);
}

export function useSidebarListedThreads<T extends ListedThread>(
  threads: ReadonlyArray<T>,
  layout: SidebarBotsLayout,
  searching: boolean,
): ReadonlyArray<T> {
  const botsEnvironmentId = useBotsEnvironmentId();
  const { directory } = useBotDirectory(botsEnvironmentId);
  return sidebarListedThreads(threads, {
    layout,
    searching,
    botsEnvironmentId,
    hiddenThreadIds: directory?.hiddenThreadIds,
  });
}
