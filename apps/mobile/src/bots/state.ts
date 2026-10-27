import { createBotsEnvironmentAtoms } from "@t3tools/client-runtime/state/bots";
import type { BotDirectory, EnvironmentId, KanbanSnapshot } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useServerConfigs } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";

/** Bots (friend fork) commands and the live directory, bound to the mobile connection runtime. */
export const botsEnvironment = createBotsEnvironmentAtoms(connectionAtomRuntime);

/**
 * The environment that hosts bots (its server advertises the `bots` capability), or null. Bots
 * live on one machine, so the phone reads them from that environment whichever others it has.
 */
export function useBotsEnvironmentId(): EnvironmentId | null {
  for (const [environmentId, config] of useServerConfigs()) {
    if (config.environment.capabilities.bots === true) return environmentId;
  }
  return null;
}

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

/** The bots host's live kanban; null until the first snapshot arrives. */
export function useKanbanSnapshot(environmentId: EnvironmentId | null): {
  readonly snapshot: KanbanSnapshot | null;
  readonly error: string | null;
} {
  const query = useEnvironmentQuery(
    environmentId === null ? null : botsEnvironment.kanban({ environmentId, input: {} }),
  );
  return { snapshot: query.data, error: query.error };
}
