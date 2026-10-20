/**
 * Owns bots: their rows in BotsStore, their main threads, and the directory clients render.
 *
 * Invariants:
 * - A bot's main thread is `botThreadId(bot.id, bot.homeGeneration)`, launched in the managed
 *   Scratch project with a deterministic launch command id, so a retry or the startup
 *   reconciliation converges on the same thread instead of creating another.
 * - The row is written before its thread is launched; reconciliation launches any missing
 *   main thread, so a crash between the two writes heals on the next start.
 * - Reset raises the generation, archives the previous thread, and launches the next one.
 *   Delete archives the main thread, then removes the row and its memories.
 * - Renaming a bot retitles its main thread to `<emoji> <name>`.
 * - `directory` publishes only after a write commits.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Option from "effect/Option";
import type * as Stream from "effect/Stream";

import type {
  Bot,
  BotCreateInput,
  BotDirectory,
  BotId,
  BotMemory,
  BotMemoryCreateInput,
  BotMemoryRef,
  BotMemorySource,
  BotMemoryUpdateInput,
  BotRef,
  BotsError,
  BotsImportInput,
  BotsImportResult,
  BotsOwnerUpdateInput,
  BotUpdateInput,
  ThreadId,
} from "@t3tools/contracts";

import type { BotsStore } from "./BotsStore.ts";

export class BotsService extends Context.Service<
  BotsService,
  {
    /** The current directory on subscribe, then a fresh one after every committed change. */
    readonly directory: Stream.Stream<BotDirectory, BotsError>;
    readonly createBot: (input: BotCreateInput) => Effect.Effect<Bot, BotsError>;
    readonly updateBot: (input: BotUpdateInput) => Effect.Effect<Bot, BotsError>;
    readonly deleteBot: (input: BotRef) => Effect.Effect<BotRef, BotsError>;
    readonly resetConversation: (input: BotRef) => Effect.Effect<Bot, BotsError>;
    /** Duplicate text for the same bot fails with BotsError. */
    readonly createMemory: (
      input: BotMemoryCreateInput,
      source: BotMemorySource,
    ) => Effect.Effect<BotMemory, BotsError>;
    readonly updateMemory: (input: BotMemoryUpdateInput) => Effect.Effect<BotMemory, BotsError>;
    readonly deleteMemory: (input: BotMemoryRef) => Effect.Effect<BotMemoryRef, BotsError>;
    readonly memoriesOf: (botId: BotId) => Effect.Effect<ReadonlyArray<BotMemory>, BotsError>;
    readonly updateOwner: (
      input: BotsOwnerUpdateInput,
    ) => Effect.Effect<BotsOwnerUpdateInput, BotsError>;
    /** Plans an import from friend's database; with `apply`, commits it and launches threads. */
    readonly importFriend: (input: BotsImportInput) => Effect.Effect<BotsImportResult, BotsError>;
    /** The bot a thread belongs to, from its id; none for every other thread. */
    readonly botForThread: (threadId: ThreadId) => Effect.Effect<Option.Option<Bot>, BotsError>;
  }
>()("t3/bots/BotsService") {}

/**
 * Also needs the orchestration runtime (ThreadLaunchService, ManagedProjectFolders,
 * ThreadManagementService, provider instances), which server.ts provides beneath it.
 */
export const layer: Layer.Layer<BotsService, never, BotsStore> = Layer.effect(
  BotsService,
  Effect.die("not implemented: BotsService.layer"),
);
