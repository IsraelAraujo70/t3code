import { type BotMemory, type BotsError, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import * as BotsService from "../BotsService.ts";
import { BotMemoryToolkit } from "./tools.ts";

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
