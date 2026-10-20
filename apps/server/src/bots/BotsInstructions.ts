/**
 * Turns a bot's role, enabled memories and the owner profile into AppInstructions for each turn
 * of the bot's threads. RunExecutionService asks for them with Effect.serviceOption, so runtimes
 * built without this service (upstream tests) behave exactly as before.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- buildBotInstructions is pure and synchronous; Effect's Crypto hashes inside an Effect.
import * as NodeCrypto from "node:crypto";

import type { AppInstructions } from "@t3tools/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  parseBotThreadId,
  type Bot,
  type BotMemory,
  type BotsError,
  type ThreadId,
} from "@t3tools/contracts";

import { BotsStore } from "./BotsStore.ts";

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
export function buildBotInstructions(input: BotInstructionInput): AppInstructions {
  const { bot, memories } = input;
  const identity = `You are ${bot.emoji} ${bot.name}, one of the user's bots in T3 Code. This thread is your ongoing conversation with the user.`;
  const role = bot.role.trim();
  const aboutMe = input.aboutMe.trim();
  const sections = [
    {
      key: "bot",
      title: "Who you are",
      text: role.length > 0 ? `${identity}\n\n${role}` : identity,
    },
    ...(aboutMe.length > 0 ? [{ key: "owner", title: "About the user", text: aboutMe }] : []),
    ...(memories.length > 0
      ? [
          {
            key: "memories",
            title: "Your memories",
            text: memories.map((memory) => `- [${memory.id}] ${memory.text}`).join("\n"),
          },
        ]
      : []),
    {
      key: "memory-tools",
      title: "Memory tools",
      text: "Save durable facts about the user and your work with memory_save. When a memory is wrong or stale, remove it with memory_forget using the id in brackets. Never store secrets such as passwords, tokens, or keys.",
    },
  ].flatMap(splitSection);
  const fingerprint = NodeCrypto.createHash("sha256")
    .update(JSON.stringify(sections.map((section) => [section.key, section.text])))
    .digest("hex");
  return { fingerprint, sections };
}

type Section = AppInstructions["sections"][number];

/** Splits on line boundaries, hard-splitting a single line longer than the limit. */
function splitSection(section: Section): ReadonlyArray<Section> {
  if (section.text.length <= BOT_INSTRUCTION_SECTION_LIMIT) return [section];
  const chunks: Array<string> = [];
  let current = "";
  for (const line of section.text.split("\n")) {
    const pieces: Array<string> = [];
    for (let start = 0; start < line.length; start += BOT_INSTRUCTION_SECTION_LIMIT) {
      pieces.push(line.slice(start, start + BOT_INSTRUCTION_SECTION_LIMIT));
    }
    if (pieces.length === 0) pieces.push("");
    for (const piece of pieces) {
      const joined = current.length === 0 ? piece : `${current}\n${piece}`;
      if (joined.length <= BOT_INSTRUCTION_SECTION_LIMIT) current = joined;
      else {
        chunks.push(current);
        current = piece;
      }
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks.map((text, index) => ({
    key: `${section.key}-${index + 1}`,
    title: `${section.title} (${index + 1}/${chunks.length})`,
    text,
  }));
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
  Effect.gen(function* () {
    const store = yield* BotsStore;
    return BotsInstructions.of({
      forThread: (threadId) =>
        Effect.gen(function* () {
          const parsed = parseBotThreadId(threadId);
          if (parsed === null) return undefined;
          const bot = yield* store.getBot(parsed.botId);
          if (Option.isNone(bot)) return undefined;
          const memories = yield* store.listMemories(parsed.botId);
          const aboutMe = yield* store.getAboutMe;
          return buildBotInstructions({
            bot: bot.value,
            memories: memories.filter((memory) => memory.enabled),
            aboutMe,
          });
        }),
    });
  }),
);
