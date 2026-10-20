/**
 * Bots (friend fork). A bot is a named, long-lived agent with a standing role, a default model,
 * its own memory, and one main conversation. That conversation is an ordinary T3 thread whose id
 * is `bot:<botId>:<generation>`; resetting the conversation archives it and starts the next
 * generation. Bot records live in the server's `bots.sqlite`, never in orchestration state.
 */
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import { IsoDateTime, PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Kept compatible with friend's own ids (`b_<hex>`) so imports keep them. */
export const BotId = Schema.String.check(Schema.isPattern(ID_PATTERN)).pipe(Schema.brand("BotId"));
export type BotId = typeof BotId.Type;

/** Kept compatible with friend's own ids (`mem_<hex>`) so imports keep them. */
export const BotMemoryId = Schema.String.check(Schema.isPattern(ID_PATTERN)).pipe(
  Schema.brand("BotMemoryId"),
);
export type BotMemoryId = typeof BotMemoryId.Type;

export const BOT_LIMITS = {
  name: 60,
  emoji: 16,
  role: 20_000,
  memory: 4_000,
  aboutMe: 20_000,
} as const;

const boundedText = (max: number) => TrimmedNonEmptyString.check(Schema.isMaxLength(max));

export const BotName = boundedText(BOT_LIMITS.name);
export const BotEmoji = boundedText(BOT_LIMITS.emoji);
/** A role may be empty: the bot then works from its memories and the owner profile alone. */
export const BotRole = Schema.String.check(Schema.isMaxLength(BOT_LIMITS.role));
export const BotMemoryText = boundedText(BOT_LIMITS.memory);
export const BotsAboutMe = Schema.String.check(Schema.isMaxLength(BOT_LIMITS.aboutMe));

export const BotMemorySource = Schema.Literals(["user", "bot", "import"]);
export type BotMemorySource = typeof BotMemorySource.Type;

export const BotMemory = Schema.Struct({
  id: BotMemoryId,
  botId: BotId,
  text: BotMemoryText,
  source: BotMemorySource,
  enabled: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type BotMemory = typeof BotMemory.Type;

export const Bot = Schema.Struct({
  id: BotId,
  name: BotName,
  emoji: BotEmoji,
  role: BotRole,
  model: ModelSelection,
  /** Current conversation generation; the main thread is `botThreadId(id, homeGeneration)`. */
  homeGeneration: PositiveInt,
  /** Sidebar order, ascending. */
  position: Schema.Int,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Bot = typeof Bot.Type;

export const BotDirectoryEntry = Schema.Struct({
  ...Bot.fields,
  homeThreadId: ThreadId,
  memories: Schema.Array(BotMemory),
});
export type BotDirectoryEntry = typeof BotDirectoryEntry.Type;

/** Everything clients render: bots in sidebar order with their memories, plus the owner profile. */
export const BotDirectory = Schema.Struct({
  bots: Schema.Array(BotDirectoryEntry),
  aboutMe: BotsAboutMe,
});
export type BotDirectory = typeof BotDirectory.Type;

const BOT_THREAD_ID = /^bot:([A-Za-z0-9_-]{1,64}):([1-9]\d{0,8})$/;

/** The main thread id of a bot's conversation generation. */
export function botThreadId(botId: BotId, generation: number): ThreadId {
  return ThreadId.make(`bot:${botId}:${generation}`);
}

/** Inverse of botThreadId; null for every thread that is not a bot conversation. */
export function parseBotThreadId(
  threadId: string,
): { readonly botId: BotId; readonly generation: number } | null {
  const match = BOT_THREAD_ID.exec(threadId);
  if (match === null) return null;
  return { botId: BotId.make(match[1]!), generation: Number(match[2]) };
}

export const BotCreateInput = Schema.Struct({
  name: BotName,
  emoji: BotEmoji,
  role: BotRole,
  model: ModelSelection,
});
export type BotCreateInput = typeof BotCreateInput.Type;

export const BotUpdateInput = Schema.Struct({
  botId: BotId,
  name: Schema.optionalKey(BotName),
  emoji: Schema.optionalKey(BotEmoji),
  role: Schema.optionalKey(BotRole),
  model: Schema.optionalKey(ModelSelection),
  position: Schema.optionalKey(Schema.Int),
});
export type BotUpdateInput = typeof BotUpdateInput.Type;

export const BotRef = Schema.Struct({ botId: BotId });
export type BotRef = typeof BotRef.Type;

export const BotMemoryCreateInput = Schema.Struct({
  botId: BotId,
  text: BotMemoryText,
});
export type BotMemoryCreateInput = typeof BotMemoryCreateInput.Type;

export const BotMemoryUpdateInput = Schema.Struct({
  memoryId: BotMemoryId,
  text: Schema.optionalKey(BotMemoryText),
  enabled: Schema.optionalKey(Schema.Boolean),
});
export type BotMemoryUpdateInput = typeof BotMemoryUpdateInput.Type;

export const BotMemoryRef = Schema.Struct({ memoryId: BotMemoryId });
export type BotMemoryRef = typeof BotMemoryRef.Type;

export const BotsOwnerUpdateInput = Schema.Struct({ aboutMe: BotsAboutMe });
export type BotsOwnerUpdateInput = typeof BotsOwnerUpdateInput.Type;

/** Import from the friend app's database on the server's machine. Without `apply` it only plans. */
export const BotsImportInput = Schema.Struct({
  /** Absolute path; defaults to friend's `~/.local/share/friend/friend.db` on the server host. */
  path: Schema.optionalKey(TrimmedNonEmptyString),
  apply: Schema.Boolean,
});
export type BotsImportInput = typeof BotsImportInput.Type;

export const BotsImportBotPlan = Schema.Struct({
  sourceId: BotId,
  name: Schema.String,
  emoji: Schema.String,
  /** `exists`: a bot with this id is already here and is left untouched. */
  status: Schema.Literals(["new", "exists"]),
  model: Schema.NullOr(ModelSelection),
  memories: Schema.Int,
});
export type BotsImportBotPlan = typeof BotsImportBotPlan.Type;

export const BotsImportResult = Schema.Struct({
  path: Schema.String,
  applied: Schema.Boolean,
  bots: Schema.Array(BotsImportBotPlan),
  /** `replace` only when the local profile is empty; a non-empty local profile is never overwritten. */
  aboutMe: Schema.Literals(["none", "same", "replace", "keep-local"]),
  warnings: Schema.Array(Schema.String),
});
export type BotsImportResult = typeof BotsImportResult.Type;

export class BotsError extends Schema.TaggedError<BotsError>()("BotsError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export const BOTS_WS_METHODS = {
  directorySubscribe: "bots.directory.subscribe",
  botCreate: "bots.bot.create",
  botUpdate: "bots.bot.update",
  botDelete: "bots.bot.delete",
  botResetConversation: "bots.bot.resetConversation",
  memoryCreate: "bots.memory.create",
  memoryUpdate: "bots.memory.update",
  memoryDelete: "bots.memory.delete",
  ownerUpdate: "bots.owner.update",
  import: "bots.import",
} as const;

const BotsRpcError = Schema.Union([BotsError, EnvironmentAuthorizationError]);

export const BotsDirectorySubscribeRpc = Rpc.make(BOTS_WS_METHODS.directorySubscribe, {
  payload: Schema.Struct({}),
  success: BotDirectory,
  error: BotsRpcError,
  stream: true,
});
export const BotCreateRpc = Rpc.make(BOTS_WS_METHODS.botCreate, {
  payload: BotCreateInput,
  success: Bot,
  error: BotsRpcError,
});
export const BotUpdateRpc = Rpc.make(BOTS_WS_METHODS.botUpdate, {
  payload: BotUpdateInput,
  success: Bot,
  error: BotsRpcError,
});
export const BotDeleteRpc = Rpc.make(BOTS_WS_METHODS.botDelete, {
  payload: BotRef,
  success: BotRef,
  error: BotsRpcError,
});
export const BotResetConversationRpc = Rpc.make(BOTS_WS_METHODS.botResetConversation, {
  payload: BotRef,
  success: Bot,
  error: BotsRpcError,
});
export const BotMemoryCreateRpc = Rpc.make(BOTS_WS_METHODS.memoryCreate, {
  payload: BotMemoryCreateInput,
  success: BotMemory,
  error: BotsRpcError,
});
export const BotMemoryUpdateRpc = Rpc.make(BOTS_WS_METHODS.memoryUpdate, {
  payload: BotMemoryUpdateInput,
  success: BotMemory,
  error: BotsRpcError,
});
export const BotMemoryDeleteRpc = Rpc.make(BOTS_WS_METHODS.memoryDelete, {
  payload: BotMemoryRef,
  success: BotMemoryRef,
  error: BotsRpcError,
});
export const BotsOwnerUpdateRpc = Rpc.make(BOTS_WS_METHODS.ownerUpdate, {
  payload: BotsOwnerUpdateInput,
  success: BotsOwnerUpdateInput,
  error: BotsRpcError,
});
export const BotsImportRpc = Rpc.make(BOTS_WS_METHODS.import, {
  payload: BotsImportInput,
  success: BotsImportResult,
  error: BotsRpcError,
});

/** Every bots RPC, spread into the server's WsRpcGroup. */
export const BOTS_RPCS = [
  BotsDirectorySubscribeRpc,
  BotCreateRpc,
  BotUpdateRpc,
  BotDeleteRpc,
  BotResetConversationRpc,
  BotMemoryCreateRpc,
  BotMemoryUpdateRpc,
  BotMemoryDeleteRpc,
  BotsOwnerUpdateRpc,
  BotsImportRpc,
] as const;

/** Mutations: guarded on clients and enforced on the server. */
export const BOTS_GUARDED_RPC_SCOPES = {
  [BOTS_WS_METHODS.botCreate]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.botUpdate]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.botDelete]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.botResetConversation]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.memoryCreate]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.memoryUpdate]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.memoryDelete]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.ownerUpdate]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.import]: AuthOrchestrationOperateScope,
} as const;

/** Every bots RPC's server scope. */
export const BOTS_RPC_SCOPES = {
  [BOTS_WS_METHODS.directorySubscribe]: AuthOrchestrationReadScope,
  ...BOTS_GUARDED_RPC_SCOPES,
} as const;

type BotsWsMethod = (typeof BOTS_WS_METHODS)[keyof typeof BOTS_WS_METHODS];

/** The `rpc.aggregate` trace label of every bots RPC. */
export const BOTS_RPC_AGGREGATES = Object.fromEntries(
  Object.values(BOTS_WS_METHODS).map((method) => [method, "bots"]),
) as { readonly [Method in BotsWsMethod]: "bots" };
