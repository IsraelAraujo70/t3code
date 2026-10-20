import {
  type Bot,
  BOT_LIMITS,
  type BotMemory,
  type BotsError,
  botThreadId,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import * as BotsService from "../BotsService.ts";
import { BotManagementToolkit, BotMemoryToolkit } from "./tools.ts";

const botsFailure = (error: BotsError) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

const view = (memory: BotMemory) => ({
  id: memory.id,
  text: memory.text,
  enabled: memory.enabled,
  source: memory.source,
});

/**
 * The bot whose conversation is calling, from the trusted caller scope only. Tool arguments never
 * name a bot, so one bot cannot reach another's memories.
 */
const callerBot = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const bots = yield* BotsService.BotsService;
  const bot =
    scope.thread === undefined
      ? Option.none()
      : yield* bots.botForThread(scope.thread.threadId).pipe(Effect.mapError(botsFailure));
  if (Option.isNone(bot)) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "Memory is only available in a bot's conversation.",
    });
  }
  return { bot: bot.value, bots };
});

export const layer = McpToolAccess.toLayer(BotMemoryToolkit, {
  memory_list: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const { bot, bots } = yield* callerBot;
      const memories = yield* bots.memoriesOf(bot.id).pipe(Effect.mapError(botsFailure));
      return { memories: memories.map(view) };
    }),
  ),
  memory_save: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { bot, bots } = yield* callerBot;
      const memory = yield* bots
        .createMemory({ botId: bot.id, text: input.text }, "bot")
        .pipe(Effect.mapError(botsFailure));
      return view(memory);
    }),
  ),
  memory_forget: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { bot, bots } = yield* callerBot;
      const memories = yield* bots.memoriesOf(bot.id).pipe(Effect.mapError(botsFailure));
      if (!memories.some((memory) => memory.id === input.memoryId)) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `You have no memory ${input.memoryId}.`,
        });
      }
      return yield* bots
        .deleteMemory({ memoryId: input.memoryId })
        .pipe(Effect.mapError(botsFailure));
    }),
  ),
});

const botView = (bot: Bot) => ({
  id: bot.id,
  name: bot.name,
  role: bot.role,
  model: bot.model,
  canManageBots: bot.canManageBots,
  threadId: botThreadId(bot.id, bot.homeGeneration),
});

/**
 * The calling bot, only when the user let it manage bots. Like `callerBot`, the grant comes from
 * the trusted caller scope, and no tool can grant it: only the user does, in Settings.
 */
const callerManager = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const bots = yield* BotsService.BotsService;
  const bot =
    scope.thread === undefined
      ? Option.none()
      : yield* bots.botForThread(scope.thread.threadId).pipe(Effect.mapError(botsFailure));
  if (Option.isNone(bot) || !bot.value.canManageBots) {
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "Only a bot the user allowed to manage bots, in Settings → Bots, can use this tool.",
    });
  }
  return { manager: bot.value, bots };
});

export const managementLayer = McpToolAccess.toLayer(BotManagementToolkit, {
  bot_list: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const { bots } = yield* callerManager;
      const directory = yield* Stream.runHead(bots.directory).pipe(Effect.mapError(botsFailure));
      return {
        bots: Option.match(directory, { onNone: () => [], onSome: (d) => d.bots }).map(botView),
      };
    }),
  ),
  bot_create: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { bots } = yield* callerManager;
      // Checked before the bot exists, so a refused memory never leaves a half-made bot.
      const memories = [...new Set(input.memories ?? [])];
      const characters = memories.reduce((total, text) => total + text.length, 0);
      if (characters > BOT_LIMITS.memoryBudget) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: `Starting memories use ${characters} characters; a bot may hold ${BOT_LIMITS.memoryBudget}. Merge or shorten them.`,
        });
      }
      const bot = yield* bots
        .createBot({ name: input.name, role: input.role, model: input.model })
        .pipe(Effect.mapError(botsFailure));
      yield* Effect.forEach(
        memories,
        (text) =>
          bots.createMemory({ botId: bot.id, text }, "bot").pipe(Effect.mapError(botsFailure)),
        { discard: true },
      );
      return botView(bot);
    }),
  ),
  bot_update: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { bots } = yield* callerManager;
      const bot = yield* bots
        .updateBot({
          botId: input.botId,
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.role !== undefined ? { role: input.role } : {}),
          ...(input.model !== undefined ? { model: input.model } : {}),
        })
        .pipe(Effect.mapError(botsFailure));
      return botView(bot);
    }),
  ),
  bot_delete: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { manager, bots } = yield* callerManager;
      // Deleting itself would archive the conversation this turn is running in.
      if (input.botId === manager.id) {
        return yield* new OrchestratorMcpFailure({
          code: "invalid_request",
          message: "You cannot delete yourself. Ask the user to do it in Settings → Bots.",
        });
      }
      return yield* bots.deleteBot({ botId: input.botId }).pipe(Effect.mapError(botsFailure));
    }),
  ),
});
