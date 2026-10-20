/**
 * Turns a bot's role, enabled memories and the owner profile into AppInstructions for each turn
 * of the bot's threads. RunExecutionService asks for them with Effect.serviceOption, so runtimes
 * built without this service (upstream tests) behave exactly as before.
 */
import type { AppInstructions } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { Bot, BotMemory, BotsError, ThreadId } from "@t3tools/contracts";

import type { BotsStore } from "./BotsStore.ts";

/** Section texts never exceed this, so adapters can deliver each section on its own. */
export const BOT_INSTRUCTION_SECTION_LIMIT = 3_500;

export interface BotInstructionInput {
  readonly bot: Bot;
  /** Only enabled memories, oldest first. */
  readonly memories: ReadonlyArray<BotMemory>;
  readonly aboutMe: string;
}

/**
 * Pure. Sections, in order: identity and role, owner profile, memories (with ids, so the bot can
 * forget one), and how to use the memory tools. Long texts split into numbered sections under
 * BOT_INSTRUCTION_SECTION_LIMIT. The fingerprint is a stable hash of every section.
 */
export function buildBotInstructions(_input: BotInstructionInput): AppInstructions {
  throw new Error("not implemented: buildBotInstructions");
}

export class BotsInstructions extends Context.Service<
  BotsInstructions,
  {
    /**
     * Instructions for any thread whose id parses as a bot thread (any generation, including
     * delegated work later bound to a bot), or undefined for every other thread and for a bot
     * that no longer exists.
     */
    readonly forThread: (
      threadId: ThreadId,
    ) => Effect.Effect<AppInstructions | undefined, BotsError>;
  }
>()("t3/bots/BotsInstructions") {}

/** Reads through BotsStore. */
export const layer: Layer.Layer<BotsInstructions, never, BotsStore> = Layer.effect(
  BotsInstructions,
  Effect.die("not implemented: BotsInstructions.layer"),
);
