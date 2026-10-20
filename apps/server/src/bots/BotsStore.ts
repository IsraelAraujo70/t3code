/**
 * Rows of `bots.sqlite`: bots, their memories, and the owner profile. The store keeps rows only;
 * BotsService owns every rule about them (thread generations, limits, who may write what).
 *
 * The database is a separate file next to the upstream `statev2.sqlite`, with its own migration
 * ledger. Its SqlClient stays inside this layer so it never replaces the main one.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Option from "effect/Option";

import type { Bot, BotId, BotMemory, BotMemoryId, BotsError } from "@t3tools/contracts";

/** One atomic import: rows whose id already exists are skipped, never overwritten. */
export interface BotsImportBatch {
  readonly bots: ReadonlyArray<Bot>;
  readonly memories: ReadonlyArray<BotMemory>;
  /** Written only when the stored profile is empty at commit time. */
  readonly aboutMe: string | null;
}

export class BotsStore extends Context.Service<
  BotsStore,
  {
    /** Bots in sidebar order (position, then createdAt). */
    readonly listBots: Effect.Effect<ReadonlyArray<Bot>, BotsError>;
    readonly getBot: (id: BotId) => Effect.Effect<Option.Option<Bot>, BotsError>;
    /** Fails with BotsError when the id exists. */
    readonly insertBot: (bot: Bot) => Effect.Effect<void, BotsError>;
    /** Replaces every column of an existing bot; fails when it does not exist. */
    readonly updateBot: (bot: Bot) => Effect.Effect<void, BotsError>;
    /** Deletes the bot and, by cascade, its memories. Deleting a missing bot succeeds. */
    readonly deleteBot: (id: BotId) => Effect.Effect<void, BotsError>;
    /** All memories, or one bot's, oldest first. */
    readonly listMemories: (botId?: BotId) => Effect.Effect<ReadonlyArray<BotMemory>, BotsError>;
    readonly getMemory: (id: BotMemoryId) => Effect.Effect<Option.Option<BotMemory>, BotsError>;
    /** Fails with BotsError when the id exists or the bot already has a memory with this text. */
    readonly insertMemory: (memory: BotMemory) => Effect.Effect<void, BotsError>;
    readonly updateMemory: (memory: BotMemory) => Effect.Effect<void, BotsError>;
    readonly deleteMemory: (id: BotMemoryId) => Effect.Effect<void, BotsError>;
    /** Empty string when never set. */
    readonly getAboutMe: Effect.Effect<string, BotsError>;
    readonly setAboutMe: (text: string) => Effect.Effect<void, BotsError>;
    readonly importBatch: (batch: BotsImportBatch) => Effect.Effect<void, BotsError>;
  }
>()("t3/bots/BotsStore") {}

/** `bots.sqlite` in the server state directory (`ServerConfig.stateDir`). */
export const layer: Layer.Layer<BotsStore> = Layer.effect(
  BotsStore,
  Effect.die("not implemented: BotsStore.layer"),
);

/** A migrated in-memory database, for tests. */
export const layerMemory: Layer.Layer<BotsStore> = Layer.effect(
  BotsStore,
  Effect.die("not implemented: BotsStore.layerMemory"),
);
