import { createBotsEnvironmentAtoms } from "@t3tools/client-runtime/state/bots";
import type { BotDirectory, EnvironmentId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

/** Bots (friend fork) commands and the live directory, bound to the web connection runtime. */
export const botsEnvironment = createBotsEnvironmentAtoms(connectionAtomRuntime);

/**
 * The live bot directory of one environment. `directory` is null until the first snapshot
 * arrives or while the environment is unavailable; an empty directory is a loaded, empty list.
 */
export function useBotDirectory(environmentId: EnvironmentId | null): {
  readonly directory: BotDirectory | null;
  readonly error: string | null;
} {
  const query = useEnvironmentQuery(
    environmentId === null ? null : botsEnvironment.directory({ environmentId, input: {} }),
  );
  return { directory: query.data, error: query.error };
}
