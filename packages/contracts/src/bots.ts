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

export const BotSectionId = Schema.String.check(Schema.isPattern(ID_PATTERN)).pipe(
  Schema.brand("BotSectionId"),
);
export type BotSectionId = typeof BotSectionId.Type;

export const BOT_LIMITS = {
  name: 60,
  sectionName: 60,
  role: 20_000,
  memory: 4_000,
  /**
   * Enabled memories ride in every turn's system prompt, so a bot may save one only while the
   * enabled total stays within this many characters. The user's own edits are never refused.
   */
  memoryBudget: 8_000,
  aboutMe: 20_000,
} as const;

const boundedText = (max: number) => TrimmedNonEmptyString.check(Schema.isMaxLength(max));

export const BotName = boundedText(BOT_LIMITS.name);
export const BotSectionName = boundedText(BOT_LIMITS.sectionName);
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

/** Characters of enabled memory a bot carries in its prompt, measured against memoryBudget. */
export const enabledMemoryCharacters = (
  memories: ReadonlyArray<Pick<BotMemory, "text" | "enabled">>,
): number =>
  memories.reduce((total, memory) => (memory.enabled ? total + memory.text.length : total), 0);

export const Bot = Schema.Struct({
  id: BotId,
  name: BotName,
  role: BotRole,
  model: ModelSelection,
  /** Current conversation generation; the main thread is `botThreadId(id, homeGeneration)`. */
  homeGeneration: PositiveInt,
  /** The sidebar section holding the bot; null for the default "Bots" list. */
  sectionId: Schema.NullOr(BotSectionId),
  /** Sidebar order within its section, ascending. */
  position: Schema.Int,
  /** The user lets this bot create, edit and delete bots through its MCP tools. */
  canManageBots: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Bot = typeof Bot.Type;

/** A user-made group of bots in the sidebar. */
export const BotSection = Schema.Struct({
  id: BotSectionId,
  name: BotSectionName,
  /** Sidebar order, ascending. */
  position: Schema.Int,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type BotSection = typeof BotSection.Type;

export const BotDirectoryEntry = Schema.Struct({
  ...Bot.fields,
  homeThreadId: ThreadId,
  memories: Schema.Array(BotMemory),
});
export type BotDirectoryEntry = typeof BotDirectoryEntry.Type;

/**
 * Everything clients render: sections and bots in sidebar order, the bots with their memories,
 * plus the owner profile.
 */
export const BotDirectory = Schema.Struct({
  sections: Schema.Array(BotSection),
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
  role: BotRole,
  model: ModelSelection,
  canManageBots: Schema.optionalKey(Schema.Boolean),
});
export type BotCreateInput = typeof BotCreateInput.Type;

export const BotUpdateInput = Schema.Struct({
  botId: BotId,
  name: Schema.optionalKey(BotName),
  role: Schema.optionalKey(BotRole),
  model: Schema.optionalKey(ModelSelection),
  canManageBots: Schema.optionalKey(Schema.Boolean),
});
export type BotUpdateInput = typeof BotUpdateInput.Type;

export const BotRef = Schema.Struct({ botId: BotId });
export type BotRef = typeof BotRef.Type;

export const BotSectionCreateInput = Schema.Struct({ name: BotSectionName });
export type BotSectionCreateInput = typeof BotSectionCreateInput.Type;

export const BotSectionRenameInput = Schema.Struct({
  sectionId: BotSectionId,
  name: BotSectionName,
});
export type BotSectionRenameInput = typeof BotSectionRenameInput.Type;

export const BotSectionRef = Schema.Struct({ sectionId: BotSectionId });
export type BotSectionRef = typeof BotSectionRef.Type;

/**
 * The whole sidebar arrangement after a drag: every section in order, and every bot in order
 * with the section holding it. It must name exactly the stored sections and bots, so a client
 * working from a stale directory fails instead of dropping someone.
 */
export const BotsArrangeInput = Schema.Struct({
  sectionIds: Schema.Array(BotSectionId),
  bots: Schema.Array(Schema.Struct({ botId: BotId, sectionId: Schema.NullOr(BotSectionId) })),
});
export type BotsArrangeInput = typeof BotsArrangeInput.Type;

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
  sectionCreate: "bots.section.create",
  sectionRename: "bots.section.rename",
  sectionDelete: "bots.section.delete",
  arrange: "bots.arrange",
  dictationTranscribe: "bots.dictation.transcribe",
  pushDeviceRegister: "bots.pushDevice.register",
  pushDeviceUnregister: "bots.pushDevice.unregister",
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

export const BotSectionCreateRpc = Rpc.make(BOTS_WS_METHODS.sectionCreate, {
  payload: BotSectionCreateInput,
  success: BotSection,
  error: BotsRpcError,
});
export const BotSectionRenameRpc = Rpc.make(BOTS_WS_METHODS.sectionRename, {
  payload: BotSectionRenameInput,
  success: BotSection,
  error: BotsRpcError,
});
/** Its bots go back to the default "Bots" list. */
export const BotSectionDeleteRpc = Rpc.make(BOTS_WS_METHODS.sectionDelete, {
  payload: BotSectionRef,
  success: BotSectionRef,
  error: BotsRpcError,
});
export const BotsArrangeRpc = Rpc.make(BOTS_WS_METHODS.arrange, {
  payload: BotsArrangeInput,
  success: BotsArrangeInput,
  error: BotsRpcError,
});

/**
 * Dictation: the client uploads a recording as a pending `file` attachment, then asks the server
 * to transcribe it. Servers advertise the `dictation` capability only when they hold a
 * transcription key; any server may, not just the bots host. The server deletes the recording
 * once it answers, whether or not transcription succeeded.
 */
export const DictationTranscribeInput = Schema.Struct({
  attachmentId: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
});
export type DictationTranscribeInput = typeof DictationTranscribeInput.Type;

export const DictationTranscribeResult = Schema.Struct({
  /** Cleaned up for sending; the raw transcript when the cleanup step fails. */
  text: Schema.String,
});
export type DictationTranscribeResult = typeof DictationTranscribeResult.Type;

export const DictationTranscribeRpc = Rpc.make(BOTS_WS_METHODS.dictationTranscribe, {
  payload: DictationTranscribeInput,
  success: DictationTranscribeResult,
  error: BotsRpcError,
});

/**
 * Bot push: an Android device registers its FCM token with the bots host, which then sends a data
 * push when a bot replies or waits on the user. Registering is an upsert, so the app repeats it on
 * every connect and token rotation. The host drops a token FCM reports as unregistered.
 */
export const BotPushDeviceRef = Schema.Struct({
  token: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
});
export type BotPushDeviceRef = typeof BotPushDeviceRef.Type;

export const BotPushDeviceRegisterInput = Schema.Struct({
  ...BotPushDeviceRef.fields,
  /** Shown only in server logs, to tell devices apart. */
  label: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
});
export type BotPushDeviceRegisterInput = typeof BotPushDeviceRegisterInput.Type;

export const BotPushDeviceRegisterRpc = Rpc.make(BOTS_WS_METHODS.pushDeviceRegister, {
  payload: BotPushDeviceRegisterInput,
  success: BotPushDeviceRef,
  error: BotsRpcError,
});
export const BotPushDeviceUnregisterRpc = Rpc.make(BOTS_WS_METHODS.pushDeviceUnregister, {
  payload: BotPushDeviceRef,
  success: BotPushDeviceRef,
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
  BotSectionCreateRpc,
  BotSectionRenameRpc,
  BotSectionDeleteRpc,
  BotsArrangeRpc,
  DictationTranscribeRpc,
  BotPushDeviceRegisterRpc,
  BotPushDeviceUnregisterRpc,
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
  [BOTS_WS_METHODS.sectionCreate]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.sectionRename]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.sectionDelete]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.arrange]: AuthOrchestrationOperateScope,
  // Transcribing reads an upload the same session made and spends the server's key.
  [BOTS_WS_METHODS.dictationTranscribe]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.pushDeviceRegister]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.pushDeviceUnregister]: AuthOrchestrationOperateScope,
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

/**
 * Live view of the bots host's whole screen (the "Computer" right-panel tab). A WebSocket at
 * this path, served only by the bots host; viewing needs the `terminal:read` scope.
 *
 * Server → client: a JSON text message `ComputerStreamInfo` first and whenever the screen size
 * changes, then one binary JPEG per frame. The server keeps at most one frame in flight: it sends
 * the next frame only after the client answers `ComputerStreamAck` for the previous one, so a slow
 * viewer gets fewer frames instead of a growing backlog. Capture runs only while a viewer is
 * attached. A JSON `ComputerStreamError` precedes a close when capture cannot run.
 *
 * Taking control: the first text message is `ComputerStreamAccess`. When `canControl` is true
 * (the session also holds `terminal:operate`), the client may send `ComputerStreamInput`
 * messages, which the host replays as real pointer and keyboard input. Input from a viewer
 * without control is dropped.
 *
 * Query parameters: `maxWidth` (default 1600) and `quality` (1–100, default 70).
 */
export const COMPUTER_STREAM_PATH = "/api/computer-stream/ws";

export const ComputerStreamInfo = Schema.Struct({
  type: Schema.Literal("info"),
  /** Size of the JPEG frames. */
  width: Schema.Int,
  height: Schema.Int,
  /** Size of the captured screen in compositor pixels. */
  screenWidth: Schema.Int,
  screenHeight: Schema.Int,
});
export type ComputerStreamInfo = typeof ComputerStreamInfo.Type;

export const ComputerStreamError = Schema.Struct({
  type: Schema.Literal("error"),
  message: Schema.String,
});
export type ComputerStreamError = typeof ComputerStreamError.Type;

export const ComputerStreamAccess = Schema.Struct({
  type: Schema.Literal("access"),
  canControl: Schema.Boolean,
});
export type ComputerStreamAccess = typeof ComputerStreamAccess.Type;

export const ComputerStreamServerMessage = Schema.Union([
  ComputerStreamInfo,
  ComputerStreamError,
  ComputerStreamAccess,
]);
export type ComputerStreamServerMessage = typeof ComputerStreamServerMessage.Type;

export const ComputerStreamAck = Schema.Struct({ type: Schema.Literal("ack") });
export type ComputerStreamAck = typeof ComputerStreamAck.Type;

/** A position as a fraction of the frame (0 = left/top, 1 = right/bottom). */
const ComputerFraction = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }));

export const ComputerPointerButton = Schema.Literals(["left", "right", "middle"]);
export type ComputerPointerButton = typeof ComputerPointerButton.Type;

/**
 * `move` only moves the cursor. `down`/`up` press and release (drags send move between them);
 * `click` is a full press and release at the position.
 */
export const ComputerPointerInput = Schema.Struct({
  type: Schema.Literal("pointer"),
  action: Schema.Literals(["move", "down", "up", "click"]),
  x: ComputerFraction,
  y: ComputerFraction,
  button: ComputerPointerButton,
});
export type ComputerPointerInput = typeof ComputerPointerInput.Type;

/** Scroll at a position. Deltas are in wheel notches; positive `deltaY` scrolls down. */
export const ComputerWheelInput = Schema.Struct({
  type: Schema.Literal("wheel"),
  x: ComputerFraction,
  y: ComputerFraction,
  deltaX: Schema.Int.check(Schema.isBetween({ minimum: -20, maximum: 20 })),
  deltaY: Schema.Int.check(Schema.isBetween({ minimum: -20, maximum: 20 })),
});
export type ComputerWheelInput = typeof ComputerWheelInput.Type;

export const ComputerKeyModifier = Schema.Literals(["ctrl", "alt", "shift", "meta"]);
export type ComputerKeyModifier = typeof ComputerKeyModifier.Type;

/**
 * One key press with modifiers held. `key` is a DOM `KeyboardEvent.key` value ("a", "Enter",
 * "ArrowLeft", "F5"); the host maps it to its own key names and ignores keys it does not know.
 */
export const ComputerKeyInput = Schema.Struct({
  type: Schema.Literal("key"),
  key: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(32)),
  modifiers: Schema.Array(ComputerKeyModifier),
});
export type ComputerKeyInput = typeof ComputerKeyInput.Type;

/** Literal text typed into the focused window, for phone keyboards and paste. */
export const ComputerTextInput = Schema.Struct({
  type: Schema.Literal("text"),
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
});
export type ComputerTextInput = typeof ComputerTextInput.Type;

export const ComputerStreamInput = Schema.Union([
  ComputerPointerInput,
  ComputerWheelInput,
  ComputerKeyInput,
  ComputerTextInput,
]);
export type ComputerStreamInput = typeof ComputerStreamInput.Type;

/** Everything a viewer sends. */
export const ComputerStreamClientMessage = Schema.Union([ComputerStreamAck, ComputerStreamInput]);
export type ComputerStreamClientMessage = typeof ComputerStreamClientMessage.Type;
