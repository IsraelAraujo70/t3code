/**
 * Bots (friend fork). A bot is a named, long-lived agent with a standing role, a default model,
 * its own memory, and one main conversation. That conversation is an ordinary T3 thread whose id
 * is `bot:<botId>:<generation>`; resetting or rotating the conversation archives it and starts
 * the next generation. Bot records live in the server's `bots.sqlite`, never in orchestration state.
 */
import * as Effect from "effect/Effect";
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import {
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { KANBAN_RPCS, KANBAN_WS_METHODS } from "./kanban.ts";
import { ModelSelection } from "./modelSelection.ts";

export * from "./kanban.ts";

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Also accepts the `b_<hex>` ids that bots imported from the friend app still carry. */
export const BotId = Schema.String.check(Schema.isPattern(ID_PATTERN)).pipe(Schema.brand("BotId"));
export type BotId = typeof BotId.Type;

/** Also accepts the `mem_<hex>` ids that imported memories still carry. */
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

/**
 * How often the server starts a fresh conversation generation for a bot, after a handoff turn.
 * Rotation waits for a quiet moment and skips a generation with little activity.
 */
export const BotRotation = Schema.Literals(["off", "daily", "weekly"]);
export type BotRotation = typeof BotRotation.Type;

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
  rotation: BotRotation.pipe(Schema.withDecodingDefaultKey(Effect.succeed("daily" as const))),
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

/**
 * Languages voice sessions speak, each with its own prompts and framing. `pt-BR` keeps the prompts
 * measured with `voiceBench.ts`; add a language only with its own bench run.
 */
export const VOICE_LANGUAGES = ["en", "pt-BR"] as const;
export const VoiceLanguage = Schema.Literals(VOICE_LANGUAGES);
export type VoiceLanguage = typeof VoiceLanguage.Type;

/**
 * What the bots host was started with, for Settings to show what is on and how to turn the rest on.
 * Read from the host's environment; never carries a secret, a token or a token path.
 */
export const BotsHostStatus = Schema.Struct({
  /** The voice when `voiceReaderVoice` is unset: `T3CODE_VOICE_READER_VOICE`, else Codex's default. */
  defaultVoice: Schema.String,
  /** The language when `voiceLanguage` is unset: `T3CODE_VOICE_LANGUAGE`, else English. */
  defaultVoiceLanguage: VoiceLanguage,
  /** Where voice previews load from (`T3CODE_VOICE_SAMPLES_URL`); null hides them. */
  voiceSamplesUrl: Schema.NullOr(Schema.String),
  /** `OPENROUTER_API_KEY` is set: dictation and the kanban AI filter work on this host. */
  openRouter: Schema.Boolean,
  /** `T3CODE_FCM_SERVICE_ACCOUNT_FILE` is set. */
  androidPush: Schema.Boolean,
  /** Why push is off although configured (an unreadable key file), or null. */
  androidPushIssue: Schema.NullOr(Schema.String),
  /** The public origin webhook tasks use without T3 Connect, or null. */
  webhookPublicBaseUrl: Schema.NullOr(Schema.String),
  /** Linear sync interval; 0 when polling is off. */
  kanbanPollSeconds: Schema.Int,
  /** Host MCP servers forwarded to bots, by server name only. */
  hostMcp: Schema.Array(Schema.Struct({ botId: BotId, servers: Schema.Array(Schema.String) })),
});
export type BotsHostStatus = typeof BotsHostStatus.Type;

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
  /** Bots the user lets reach linked environments; only the user changes this list. */
  linkedEnvironmentBotIds: Schema.Array(BotId).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
  /** Bots that belong to a guest: never allowed linked environments. */
  guestBotIds: Schema.Array(BotId).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  /** Absent from servers built before it. */
  host: Schema.optionalKey(BotsHostStatus),
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
  rotation: Schema.optionalKey(BotRotation),
});
export type BotCreateInput = typeof BotCreateInput.Type;

export const BotUpdateInput = Schema.Struct({
  botId: BotId,
  name: Schema.optionalKey(BotName),
  role: Schema.optionalKey(BotRole),
  model: Schema.optionalKey(ModelSelection),
  canManageBots: Schema.optionalKey(Schema.Boolean),
  rotation: Schema.optionalKey(BotRotation),
});
export type BotUpdateInput = typeof BotUpdateInput.Type;

export const BotRef = Schema.Struct({ botId: BotId });
export type BotRef = typeof BotRef.Type;

/** An earlier, archived conversation generation of a bot. */
export const BotHistoryEntry = Schema.Struct({
  generation: PositiveInt,
  threadId: ThreadId,
  startedAt: IsoDateTime,
  /** When it was archived; null when a generation was never archived (a crash mid-rotation). */
  endedAt: Schema.NullOr(IsoDateTime),
  /** What the bot wrote for its next conversation, when it got a handoff turn. */
  handoff: Schema.NullOr(Schema.String),
});
export type BotHistoryEntry = typeof BotHistoryEntry.Type;

/** A bot's earlier generations, newest first; the current one is the directory's homeThreadId. */
export const BotHistory = Schema.Struct({
  botId: BotId,
  generations: Schema.Array(BotHistoryEntry),
});
export type BotHistory = typeof BotHistory.Type;

/** Lets one bot use linked environments, or stops it. A guest's bot cannot be let. */
export const BotLinkedEnvironmentsInput = Schema.Struct({
  botId: BotId,
  linkedEnvironments: Schema.Boolean,
});
export type BotLinkedEnvironmentsInput = typeof BotLinkedEnvironmentsInput.Type;

/**
 * Takes a bot away from its guest and runs it on a host provider instance. Without `model` it keeps
 * its model and options on the first enabled host instance of the same driver.
 */
export const BotMakeRegularInput = Schema.Struct({
  botId: BotId,
  model: Schema.optionalKey(ModelSelection),
});
export type BotMakeRegularInput = typeof BotMakeRegularInput.Type;

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
  botHistory: "bots.bot.history",
  botRestartSession: "bots.bot.restartSession",
  botLinkedEnvironments: "bots.bot.linkedEnvironments",
  botMakeRegular: "bots.bot.makeRegular",
  memoryCreate: "bots.memory.create",
  memoryUpdate: "bots.memory.update",
  memoryDelete: "bots.memory.delete",
  ownerUpdate: "bots.owner.update",
  sectionCreate: "bots.section.create",
  sectionRename: "bots.section.rename",
  sectionDelete: "bots.section.delete",
  arrange: "bots.arrange",
  dictationTranscribe: "bots.dictation.transcribe",
  pushDeviceRegister: "bots.pushDevice.register",
  pushDeviceUnregister: "bots.pushDevice.unregister",
  voiceSession: "bots.voice.session",
  voiceReady: "bots.voice.ready",
  voiceReconnect: "bots.voice.reconnect",
  voiceReport: "bots.voice.report",
  ...KANBAN_WS_METHODS,
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
/** Loaded only when the user opens a bot's history, never with the directory. */
export const BotHistoryRpc = Rpc.make(BOTS_WS_METHODS.botHistory, {
  payload: BotRef,
  success: BotHistory,
  error: BotsRpcError,
});
/**
 * Stops the bot's idle provider process (Claude's `claude`, Codex's shared app-server) so the next
 * message starts a fresh one, which loads new MCP servers, skills and config, and resumes the same
 * provider conversation. Fails while the bot has a run that has not settled, or while its process
 * still works (a turn, or background work), so nothing in flight is cut off.
 */
export const BotRestartSessionResult = Schema.Struct({
  botId: BotId,
  /** False when no process was running: the next message starts a fresh one anyway. */
  stopped: Schema.Boolean,
});
export type BotRestartSessionResult = typeof BotRestartSessionResult.Type;
export const BotRestartSessionRpc = Rpc.make(BOTS_WS_METHODS.botRestartSession, {
  payload: BotRef,
  success: BotRestartSessionResult,
  error: BotsRpcError,
});
export const BotLinkedEnvironmentsRpc = Rpc.make(BOTS_WS_METHODS.botLinkedEnvironments, {
  payload: BotLinkedEnvironmentsInput,
  success: BotLinkedEnvironmentsInput,
  error: BotsRpcError,
});
export const BotMakeRegularRpc = Rpc.make(BOTS_WS_METHODS.botMakeRegular, {
  payload: BotMakeRegularInput,
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

/**
 * Voice uses the Codex ChatGPT login, never an API key. The client owns WebRTC: `session` carries
 * its offer, the server emits one `answer`, and relays or speaks only after `ready`. On
 * `voice-changed` the client calls `reconnect` with a new offer and `ready` again.
 */

/** The v3 voices Codex 0.162 realtime offers. The `voiceReaderVoice` server setting picks one. */
export const REALTIME_VOICES = [
  "juniper",
  "maple",
  "spruce",
  "ember",
  "vale",
  "breeze",
  "arbor",
  "sol",
  "cove",
] as const;
export const RealtimeVoice = Schema.Literals(REALTIME_VOICES);
export type RealtimeVoice = typeof RealtimeVoice.Type;
export const VoiceSessionId = TrimmedNonEmptyString.check(Schema.isMaxLength(128)).pipe(
  Schema.brand("VoiceSessionId"),
);
export type VoiceSessionId = typeof VoiceSessionId.Type;

/** WebRTC SDP blobs are a few KB; the cap only bounds abuse. */
const VoiceSdp = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(65_536));

export const VoiceSessionMode = Schema.Union([
  Schema.Struct({ type: Schema.Literal("conversation") }),
  /** Reads one assistant message of the thread; the server loads its text, never the client. */
  Schema.Struct({ type: Schema.Literal("read"), messageId: MessageId }),
]);
export type VoiceSessionMode = typeof VoiceSessionMode.Type;

export const VoiceSessionInput = Schema.Struct({
  threadId: ThreadId,
  mode: VoiceSessionMode,
  sdp: VoiceSdp,
  /** The client handles `voice-changed`. Clients that predate it never receive one. */
  liveVoiceChange: Schema.optional(Schema.Boolean),
});
export type VoiceSessionInput = typeof VoiceSessionInput.Type;

export const VoiceSessionAnswer = Schema.Struct({
  type: Schema.Literal("answer"),
  sessionId: VoiceSessionId,
  sdp: VoiceSdp,
});
export type VoiceSessionAnswer = typeof VoiceSessionAnswer.Type;

export const VoiceSessionEvent = Schema.Union([
  /** First, exactly once. */
  VoiceSessionAnswer,
  /**
   * On every change: whether the thread's agent has work (a run, a queued message, or an utterance
   * being relayed), or, in a read, whether parts of the reply have yet to start being spoken.
   */
  Schema.Struct({ type: Schema.Literal("bot"), working: Schema.Boolean }),
  /** Conversations whose client sent `liveVoiceChange`: reconnect to hear the new voice. */
  Schema.Struct({ type: Schema.Literal("voice-changed") }),
]);
export type VoiceSessionEvent = typeof VoiceSessionEvent.Type;

export const VoiceSessionRef = Schema.Struct({ sessionId: VoiceSessionId });
export type VoiceSessionRef = typeof VoiceSessionRef.Type;

export const VoiceSessionRpc = Rpc.make(BOTS_WS_METHODS.voiceSession, {
  payload: VoiceSessionInput,
  success: VoiceSessionEvent,
  error: BotsRpcError,
  stream: true,
});
export const VoiceReconnectInput = Schema.Struct({ sessionId: VoiceSessionId, sdp: VoiceSdp });
export type VoiceReconnectInput = typeof VoiceReconnectInput.Type;
/** The answer for the new peer. */
export const VoiceReconnectAnswer = Schema.Struct({ sdp: VoiceSdp });
export type VoiceReconnectAnswer = typeof VoiceReconnectAnswer.Type;

/** Swaps in a realtime session with the current voice for the client's new peer. */
export const VoiceReconnectRpc = Rpc.make(BOTS_WS_METHODS.voiceReconnect, {
  payload: VoiceReconnectInput,
  success: VoiceReconnectAnswer,
  error: BotsRpcError,
});

/**
 * The peer connected. Fails unless the session is open and waiting for its first peer, or for the
 * peer of a `reconnect`.
 */
export const VoiceReadyRpc = Rpc.make(BOTS_WS_METHODS.voiceReady, {
  payload: VoiceSessionRef,
  success: VoiceSessionRef,
  error: BotsRpcError,
});

/**
 * One diagnostic observation from a voice client: `t` (client epoch ms) plus inbound audio
 * counters, a gate change, or a data-channel event. Keys are free-form so the client can add
 * fields without a contract change; the server only logs them.
 */
export const VoiceDiagnosticEntry = Schema.Record(
  Schema.String.check(Schema.isMaxLength(64)),
  Schema.Union([Schema.Number, Schema.Boolean, Schema.String.check(Schema.isMaxLength(256))]),
);
export type VoiceDiagnosticEntry = typeof VoiceDiagnosticEntry.Type;

export const VoiceReportInput = Schema.Struct({
  sessionId: VoiceSessionId,
  entries: Schema.Array(VoiceDiagnosticEntry).check(Schema.isMaxLength(1_000)),
});
export type VoiceReportInput = typeof VoiceReportInput.Type;

/** What a session's client observed, for the server log; accepted also right after it ends. */
export const VoiceReportRpc = Rpc.make(BOTS_WS_METHODS.voiceReport, {
  payload: VoiceReportInput,
  error: BotsRpcError,
});

/** Every bots RPC, spread into the server's WsRpcGroup. */
export const BOTS_RPCS = [
  BotsDirectorySubscribeRpc,
  BotCreateRpc,
  BotUpdateRpc,
  BotDeleteRpc,
  BotResetConversationRpc,
  BotHistoryRpc,
  BotRestartSessionRpc,
  BotLinkedEnvironmentsRpc,
  BotMakeRegularRpc,
  BotMemoryCreateRpc,
  BotMemoryUpdateRpc,
  BotMemoryDeleteRpc,
  BotsOwnerUpdateRpc,
  BotSectionCreateRpc,
  BotSectionRenameRpc,
  BotSectionDeleteRpc,
  BotsArrangeRpc,
  DictationTranscribeRpc,
  BotPushDeviceRegisterRpc,
  BotPushDeviceUnregisterRpc,
  VoiceSessionRpc,
  VoiceReadyRpc,
  VoiceReconnectRpc,
  VoiceReportRpc,
  ...KANBAN_RPCS,
] as const;

/** Mutations: guarded on clients and enforced on the server. */
export const BOTS_GUARDED_RPC_SCOPES = {
  [BOTS_WS_METHODS.botCreate]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.botUpdate]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.botDelete]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.botResetConversation]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.botRestartSession]: AuthOrchestrationOperateScope,
  // Lets a bot act on the user's other machines: the user's session only, never a tool.
  [BOTS_WS_METHODS.botLinkedEnvironments]: AuthOrchestrationOperateScope,
  // Moves a guest's bot out of its sandbox onto the host: the user's session only, never a tool.
  [BOTS_WS_METHODS.botMakeRegular]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.memoryCreate]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.memoryUpdate]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.memoryDelete]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.ownerUpdate]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.sectionCreate]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.sectionRename]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.sectionDelete]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.arrange]: AuthOrchestrationOperateScope,
  // Transcribing reads an upload the same session made and spends the server's key.
  [BOTS_WS_METHODS.dictationTranscribe]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.pushDeviceRegister]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.pushDeviceUnregister]: AuthOrchestrationOperateScope,
  // Voice spends the server's ChatGPT realtime allowance and posts to threads.
  [BOTS_WS_METHODS.voiceSession]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.voiceReady]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.voiceReconnect]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.voiceReport]: AuthOrchestrationOperateScope,
  // Kanban: Linear credentials and writes to the user's Linear workspaces.
  [BOTS_WS_METHODS.kanbanAccountAdd]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.kanbanAccountRename]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.kanbanAccountDelete]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.kanbanLinearTeams]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.kanbanProjectLink]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.kanbanProjectUnlink]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.kanbanWorkspaceBots]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.kanbanBotAllWorkspaces]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.kanbanTicketCreate]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.kanbanTicketMove]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.kanbanTicketDelete]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.kanbanTicketLinkThread]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.kanbanTicketUnlinkThread]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.kanbanSync]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.kanbanTicketUpdate]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.kanbanTicketComment]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.kanbanTicketDeleteComment]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.kanbanTicketStartThread]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.kanbanViewSave]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.kanbanViewDelete]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.kanbanViewReorder]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.kanbanViewImportLinear]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.kanbanLabelCreate]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.kanbanLabelDelete]: AuthOrchestrationOperateScope,
  // Reads Linear with the server's key and spends its OpenRouter allowance.
  [BOTS_WS_METHODS.kanbanTicketDetail]: AuthOrchestrationOperateScope,
  [BOTS_WS_METHODS.kanbanAiFilter]: AuthOrchestrationOperateScope,
} as const;

/** Every bots RPC's server scope. */
export const BOTS_RPC_SCOPES = {
  [BOTS_WS_METHODS.directorySubscribe]: AuthOrchestrationReadScope,
  [BOTS_WS_METHODS.botHistory]: AuthOrchestrationReadScope,
  [BOTS_WS_METHODS.kanbanSubscribe]: AuthOrchestrationReadScope,
  ...BOTS_GUARDED_RPC_SCOPES,
} as const;

type BotsWsMethod = (typeof BOTS_WS_METHODS)[keyof typeof BOTS_WS_METHODS];

/** The `rpc.aggregate` trace label of every bots RPC. */
export const BOTS_RPC_AGGREGATES = Object.fromEntries(
  Object.values(BOTS_WS_METHODS).map((method) => [method, "bots"]),
) as { readonly [Method in BotsWsMethod]: "bots" };

/**
 * Frames require acknowledgment before the next send to bound the backlog.
 * Viewing requires terminal:read; control also requires terminal:operate.
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

/**
 * APK requests with a stale commit return 409.
 * Both routes require orchestration:read via a header or wsTicket.
 */
export const MOBILE_UPDATE_PATH = "/api/friend/mobile-update";
export const MOBILE_UPDATE_APK_PATH = "/api/friend/mobile-update/apk";

const GitCommitSha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/));
const Sha256Hex = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/));

export const MobileUpdateBuild = Schema.Struct({
  /** Full sha of the commit the APK was built from. */
  commit: GitCommitSha,
  shortCommit: TrimmedNonEmptyString,
  /** Committer date of `commit`. */
  commitDate: IsoDateTime,
  builtAt: IsoDateTime,
  /** APK size in bytes. */
  size: NonNegativeInt,
  /** Lowercase hex sha256 of the APK. */
  sha256: Sha256Hex,
});
export type MobileUpdateBuild = typeof MobileUpdateBuild.Type;

export const MobileUpdateInfo = Schema.Struct({ latest: Schema.NullOr(MobileUpdateBuild) });
export type MobileUpdateInfo = typeof MobileUpdateInfo.Type;

/**
 * The fork's Mac app updates itself the same way: `GET DESKTOP_UPDATE_PATH` answers a
 * `MobileUpdateInfo` (`size` and `sha256` describe the zip) and `GET DESKTOP_UPDATE_ZIP_PATH`
 * sends the zipped `.app`, with the same `?commit=` check and the same auth.
 */
export const DESKTOP_UPDATE_PATH = "/api/friend/desktop-update";
export const DESKTOP_UPDATE_ZIP_PATH = "/api/friend/desktop-update/zip";

/**
 * What the Mac app's preload exposes as `window.friendDesktopSelfUpdate` (only in a packaged Mac
 * build without upstream's update feed). The renderer checks the bots host and asks for the
 * update; the main process downloads, verifies, swaps the bundle and relaunches.
 */
export interface FriendDesktopSelfUpdateBridge {
  /** The commit this app was built from. */
  readonly embedded: { readonly commit: string; readonly commitDate: string };
  /** Where an earlier download of `build` sits, if it is still there. */
  readonly downloaded: (build: MobileUpdateBuild) => Promise<string | null>;
  /** Downloads `url` (the zip route with a fresh ticket) and returns the local path. */
  readonly download: (
    build: MobileUpdateBuild,
    url: string,
    onProgress: (fraction: number | null) => void,
  ) => Promise<string>;
  readonly inspect: (path: string) => Promise<{ readonly sha256: string; readonly size: number }>;
  /** Checks the zip against `build` again, installs it, and relaunches the app. */
  readonly install: (path: string, build: MobileUpdateBuild) => Promise<void>;
}
