import { BOTS_WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

/**
 * Bots (friend fork) for one environment: the live directory and its mutations. Web and mobile
 * bind this once each; every reader of an environment shares the same subscription.
 */
export function createBotsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  // Writes to one environment's bots apply in order, so a rename never lands before its create.
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { environmentId: string }) => environmentId,
  };
  const command = <
    Tag extends (typeof BOTS_WS_METHODS)[Exclude<
      keyof typeof BOTS_WS_METHODS,
      "directorySubscribe"
    >],
  >(
    label: string,
    tag: Tag,
  ) =>
    createEnvironmentRpcCommand(runtime, {
      label: `environment-data:bots:${label}`,
      tag,
      scheduler,
      concurrency,
    });
  return {
    /** Bots in sidebar order with their memories, plus the owner profile; refreshed on change. */
    directory: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:bots:directory",
      tag: BOTS_WS_METHODS.directorySubscribe,
    }),
    createBot: command("create-bot", BOTS_WS_METHODS.botCreate),
    updateBot: command("update-bot", BOTS_WS_METHODS.botUpdate),
    deleteBot: command("delete-bot", BOTS_WS_METHODS.botDelete),
    resetConversation: command("reset-conversation", BOTS_WS_METHODS.botResetConversation),
    createMemory: command("create-memory", BOTS_WS_METHODS.memoryCreate),
    updateMemory: command("update-memory", BOTS_WS_METHODS.memoryUpdate),
    deleteMemory: command("delete-memory", BOTS_WS_METHODS.memoryDelete),
    updateOwner: command("update-owner", BOTS_WS_METHODS.ownerUpdate),
    importFriend: command("import-friend", BOTS_WS_METHODS.import),
  };
}
