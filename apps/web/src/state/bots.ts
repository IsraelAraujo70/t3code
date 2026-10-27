import { createBotsEnvironmentAtoms } from "@t3tools/client-runtime/state/bots";
import type { BotDirectory, EnvironmentId, KanbanSnapshot } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useServerConfigs } from "./entities";
import { useEnvironmentQuery } from "./query";

/** Bots (friend fork) commands and the live directory, bound to the web connection runtime. */
export const botsEnvironment = createBotsEnvironmentAtoms(connectionAtomRuntime);

/**
 * The connected environment that hosts bots (it advertises the `bots` capability), or null.
 * Bots live on one machine, so a client connected to several environments reads them from that
 * one, never from whichever environment happens to be primary.
 */
export function useBotsEnvironmentId(): EnvironmentId | null {
  for (const [environmentId, config] of useServerConfigs()) {
    if (config.environment.capabilities.bots === true) return environmentId;
  }
  return null;
}

/**
 * The connected environment that transcribes dictation (it advertises `dictation`), or null.
 * `preferred` wins when it transcribes too, so a composer uses its own server when it can.
 */
export function useDictationEnvironmentId(preferred: EnvironmentId | null): EnvironmentId | null {
  let fallback: EnvironmentId | null = null;
  for (const [environmentId, config] of useServerConfigs()) {
    if (config.environment.capabilities.dictation !== true) continue;
    if (environmentId === preferred) return environmentId;
    fallback ??= environmentId;
  }
  return fallback;
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

/** The live kanban of the bots host; null until the first snapshot arrives. */
export function useKanbanSnapshot(environmentId: EnvironmentId | null): {
  readonly snapshot: KanbanSnapshot | null;
  readonly error: string | null;
} {
  const query = useEnvironmentQuery(
    environmentId === null ? null : botsEnvironment.kanban({ environmentId, input: {} }),
  );
  return { snapshot: query.data, error: query.error };
}
