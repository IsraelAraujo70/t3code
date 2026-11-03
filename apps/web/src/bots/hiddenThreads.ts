import { withoutHiddenThreads } from "@t3tools/client-runtime/bot-directory";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { SidebarBotsLayout } from "@t3tools/contracts/settings";

import { useBotDirectory, useBotsEnvironmentId } from "../state/bots";
import { isBotsBlockThread } from "./BotThreadIdentity";

/**
 * The sidebar's thread list: without bot threads the Bots block lists instead, and without hidden
 * side threads unless the user is searching, so a hidden thread can still be found.
 */
export function useSidebarListedThreads<
  T extends Pick<EnvironmentThreadShell, "environmentId" | "id">,
>(threads: ReadonlyArray<T>, layout: SidebarBotsLayout, searching: boolean): ReadonlyArray<T> {
  const environmentId = useBotsEnvironmentId();
  const { directory } = useBotDirectory(environmentId);
  const listed =
    layout === "mixed"
      ? threads
      : threads.filter((thread) => !isBotsBlockThread(thread.id, layout));
  return searching
    ? listed
    : withoutHiddenThreads(listed, environmentId, directory?.hiddenThreadIds);
}
