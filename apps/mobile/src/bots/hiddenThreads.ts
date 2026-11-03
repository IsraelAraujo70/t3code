import { withoutHiddenThreads } from "@t3tools/client-runtime/bot-directory";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { useBotDirectory, useBotsEnvironmentId } from "./state";

/** `threads` without the bots host's hidden side threads, unless the user is searching. */
export function useWithoutHiddenBotThreads<
  T extends Pick<EnvironmentThreadShell, "environmentId" | "id">,
>(threads: ReadonlyArray<T>, searching: boolean): ReadonlyArray<T> {
  const environmentId = useBotsEnvironmentId();
  const { directory } = useBotDirectory(environmentId);
  return searching
    ? threads
    : withoutHiddenThreads(threads, environmentId, directory?.hiddenThreadIds);
}
