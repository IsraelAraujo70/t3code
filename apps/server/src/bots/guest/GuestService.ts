/**
 * Everything a guest can do, and nothing else. The guest listener (GuestHttp) only decodes
 * requests and calls these methods.
 *
 * Invariants:
 * - Every bot id a guest names is checked against GuestStore's ownership on every call. Bots the
 *   guest does not own answer exactly like bots that do not exist.
 * - A send uses the bot's stored model selection; nothing a guest sends can choose a model,
 *   effort or any other turn option.
 * - A guest's bot only runs when its provider instance is that guest's Docker sandbox
 *   (sandboxInstance.isSandboxedFor). Otherwise sends fail closed.
 * - Guests read and write only the bot's current main thread, and see only user and assistant
 *   messages the user wrote or the bot answered: no tool calls, no other bots' messages.
 */
import {
  BotId,
  botThreadId,
  CommandId,
  GUEST_LIMITS,
  MessageId,
  ChatAttachmentId,
  type Bot,
  type ChatImageAttachment,
  type GuestBotsResponse,
  type GuestHistoryResponse,
  type GuestMessage,
  type GuestPushDeviceInput,
  type GuestPushDeviceRef,
  type GuestSendInput,
  type GuestSendResult,
  type GuestStreamEvent,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type ThreadId,
} from "@t3tools/contracts";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Base64 from "effect/encoding/Base64";

import {
  attachmentRelativePath,
  chatAttachmentStableKey,
  createDeterministicAttachmentId,
} from "../../attachmentStore.ts";
import * as ServerConfig from "../../config.ts";
import { parseBase64DataUrl } from "../../imageMime.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { isTerminalRunStatus } from "../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { BotsService } from "../BotsService.ts";
import { BotsStore } from "../BotsStore.ts";
import {
  fromGuest,
  GUEST_MESSAGE_ID_PREFIX,
  isGuestVisible,
  ownerName,
  withoutGuestPrefix,
} from "./guestSender.ts";
import { type GuestArtifact, GuestArtifacts } from "./GuestArtifacts.ts";
import { hashGuestToken } from "./guestToken.ts";
import { type GuestRecord, GuestStore } from "./GuestStore.ts";
import { conversationImages, imageRelativePath } from "./GuestTools.ts";
import { isSandboxedFor } from "./sandboxInstance.ts";

/** An answer for the guest: `status` is the HTTP status, `message` is shown to them, in Portuguese. */
export class GuestApiError extends Schema.TaggedError<GuestApiError>()("GuestApiError", {
  status: Schema.Literals([400, 401, 404, 409, 413, 429, 500]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface GuestAttachmentFile {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}

/** A guest's voice session on one of their bots, everything it reaches through GuestService. */
export interface GuestVoiceConversation {
  readonly threadId: ThreadId;
  /** Sends text exactly as `send` does: ownership and sandbox checked again, as the guest. */
  readonly post: (text: string) => Effect.Effect<void, GuestApiError>;
  /** Completes once the guest's token is revoked or the bot stops being theirs. */
  readonly revoked: Effect.Effect<void>;
}

/** A page a guest bot published, ready to serve under the html route's sandbox CSP. */
export interface GuestHtmlPage {
  readonly html: string;
}

export class GuestService extends Context.Service<
  GuestService,
  {
    /** The guest holding this bearer token; 401 for a missing, unknown or revoked token. */
    readonly authenticate: (
      authorization: string | undefined,
    ) => Effect.Effect<GuestRecord, GuestApiError>;
    readonly listBots: (guest: GuestRecord) => Effect.Effect<GuestBotsResponse, GuestApiError>;
    readonly history: (
      guest: GuestRecord,
      botId: string,
      limit: number,
    ) => Effect.Effect<GuestHistoryResponse, GuestApiError>;
    readonly send: (
      guest: GuestRecord,
      botId: string,
      input: GuestSendInput,
    ) => Effect.Effect<GuestSendResult, GuestApiError>;
    /** Checks ownership before the stream starts, so a refused bot never opens a stream. */
    readonly events: (
      guest: GuestRecord,
      botId: string,
    ) => Effect.Effect<Stream.Stream<GuestStreamEvent>, GuestApiError>;
    /** An image a person sent in the conversation, or one the bot's tools generated there. */
    readonly attachment: (
      guest: GuestRecord,
      botId: string,
      attachmentId: string,
    ) => Effect.Effect<GuestAttachmentFile, GuestApiError>;
    /** The bot's conversation for voice; refused like `send` for a bot outside the sandbox. */
    readonly voiceConversation: (
      guest: GuestRecord,
      botId: string,
    ) => Effect.Effect<GuestVoiceConversation, GuestApiError>;
    /** A page the bot published in the conversation; 404 for anything else. */
    readonly html: (
      guest: GuestRecord,
      botId: string,
      attachmentId: string,
    ) => Effect.Effect<GuestHtmlPage, GuestApiError>;
    readonly registerPushDevice: (
      guest: GuestRecord,
      input: GuestPushDeviceInput,
    ) => Effect.Effect<GuestPushDeviceRef, GuestApiError>;
    readonly unregisterPushDevice: (
      guest: GuestRecord,
      input: GuestPushDeviceRef,
    ) => Effect.Effect<GuestPushDeviceRef, GuestApiError>;
  }
>()("t3/bots/guest/GuestService") {}

const unauthorized = () =>
  new GuestApiError({
    status: 401,
    message: "Seu acesso expirou ou foi revogado. Peça um novo QR code.",
  });
const botNotFound = () => new GuestApiError({ status: 404, message: "Assistente não encontrado." });
const internal = (message: string) => (cause: unknown) =>
  new GuestApiError({ status: 500, message, cause });

const isBotId = Schema.is(BotId);

/** Assistant replies as they are; user messages marked guest or owner, the guest's unprefixed. */
const toGuestMessage = (
  guest: Pick<GuestRecord, "name">,
  message: OrchestrationV2ConversationMessage,
): GuestMessage => {
  if (message.role === "assistant") return { ...baseMessage(message), role: "assistant" };
  const byGuest = message.id.startsWith(GUEST_MESSAGE_ID_PREFIX);
  return {
    ...baseMessage(message),
    role: "user",
    sender: byGuest ? "guest" : "owner",
    text: byGuest ? withoutGuestPrefix(guest.name, message.text) : message.text,
  };
};

const baseMessage = (message: OrchestrationV2ConversationMessage) => ({
  id: message.id,
  text: message.text,
  attachments: message.attachments.flatMap((attachment) =>
    attachment.type === "image"
      ? [{ id: attachment.id, name: attachment.name, mimeType: attachment.mimeType }]
      : [],
  ),
  streaming: message.streaming,
  createdAt: DateTime.formatIso(message.createdAt),
});

/**
 * What a bot's tool made, as an assistant message of its own: an image, or a page. Its id is
 * derived from the artifact, so history and the live stream agree on it.
 */
export const artifactMessage = (artifact: GuestArtifact): GuestMessage => ({
  id: MessageId.make(`artifact:${artifact.id}`),
  role: "assistant",
  text: "",
  attachments:
    artifact.kind === "image"
      ? [{ id: artifact.id, name: artifact.name, mimeType: artifact.mimeType }]
      : [],
  ...(artifact.kind === "html"
    ? { html: { id: artifact.id, title: artifact.name, height: artifact.height ?? 400 } }
    : {}),
  streaming: false,
  createdAt: artifact.createdAt,
});

/** Breaks "ultrathink", which Claude Code reads anywhere as a request for deeper reasoning. */
const withoutKeywords = (text: string) =>
  text.replace(/ultrathink/gi, (word) => `${word.slice(0, 5)}\u200b${word.slice(5)}`);

/**
 * Guest text as plain text for the bot, so nothing in it changes how the bot runs. Claude Code
 * runs a message that starts with "/" as one of its commands (`/model` would switch the bot's
 * model), and raises reasoning depth for "ultrathink". Zero-width spaces defuse both.
 */
export const asPlainText = (text: string) => {
  const plain = withoutKeywords(text);
  return /^\s*\//.test(plain) ? `\u200b${plain}` : plain;
};

/** Live streams one guest may hold open at once (a phone keeps one per bot). */
const MAX_STREAMS_PER_GUEST = 8;
/** How soon an open stream notices a revoked token or a bot given to someone else. */
const STREAM_REVALIDATE = "5 seconds";

/** A held queued run waits for a person, so it is not the bot working. */
const isWorking = (run: Pick<OrchestrationV2Run, "status" | "queueHeld">) =>
  !isTerminalRunStatus(run.status) && !(run.status === "queued" && run.queueHeld === true);

const make = Effect.gen(function* () {
  const guests = yield* GuestStore;
  const artifacts = yield* GuestArtifacts;
  const bots = yield* BotsStore;
  const botsService = yield* BotsService;
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const owner = yield* ownerName;
  const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();

  const authenticate = Effect.fn("GuestService.authenticate")(function* (
    authorization: string | undefined,
  ) {
    const match = /^Bearer (\S+)$/.exec(authorization?.trim() ?? "");
    const hash = match === null ? null : hashGuestToken(match[1]!);
    if (hash === null) return yield* unauthorized();
    const guest = yield* guests
      .getGuestByTokenHash(hash)
      .pipe(Effect.mapError(internal("Não consegui conferir seu acesso.")));
    return Option.isSome(guest) ? guest.value : yield* unauthorized();
  });

  /** The bot, only when this guest owns it. */
  const ownedBot = Effect.fn("GuestService.ownedBot")(function* (
    guest: GuestRecord,
    rawBotId: string,
  ) {
    if (!isBotId(rawBotId)) return yield* botNotFound();
    const owner = yield* guests
      .guestOfBot(rawBotId)
      .pipe(Effect.mapError(internal("Não consegui abrir este assistente.")));
    if (Option.isNone(owner) || owner.value !== guest.id) return yield* botNotFound();
    const bot = yield* bots
      .getBot(rawBotId)
      .pipe(Effect.mapError(internal("Não consegui abrir este assistente.")));
    return Option.isSome(bot) ? bot.value : yield* botNotFound();
  });

  const threadOf = (bot: Bot): ThreadId => botThreadId(bot.id, bot.homeGeneration);

  /** The owned bot with its conversation launched: one the guest CLI wrote while the server ran has none yet. */
  const ownedConversation = Effect.fn("GuestService.ownedConversation")(function* (
    guest: GuestRecord,
    rawBotId: string,
  ) {
    const bot = yield* ownedBot(guest, rawBotId);
    return yield* botsService
      .ensureConversation({ botId: bot.id })
      .pipe(Effect.mapError(internal("Não consegui começar a conversa.")));
  });

  const readThread = (threadId: ThreadId) =>
    projections
      .getThreadRecords(threadId, ["messages", "runs"], { messageRoles: ["user", "assistant"] })
      .pipe(
        Effect.mapError((cause) =>
          cause._tag === "ProjectionStoreThreadNotFoundError"
            ? new GuestApiError({
                status: 409,
                message: "Este assistente ainda está começando. Tente de novo.",
              })
            : new GuestApiError({
                status: 500,
                message: "Não consegui ler a conversa.",
                cause,
              }),
        ),
      );

  const listBots = Effect.fn("GuestService.listBots")(function* (guest: GuestRecord) {
    const ids = yield* guests
      .listGuestBotIds(guest.id)
      .pipe(Effect.mapError(internal("Não consegui listar seus assistentes.")));
    const owned = yield* Effect.forEach(ids, (id) =>
      bots.getBot(id).pipe(Effect.mapError(internal("Não consegui listar seus assistentes."))),
    );
    return {
      guest: { id: guest.id, name: guest.name },
      ...(Option.isSome(owner) ? { ownerName: owner.value } : {}),
      bots: owned.flatMap((bot) =>
        Option.isSome(bot) ? [{ id: bot.value.id, name: bot.value.name }] : [],
      ),
    } satisfies GuestBotsResponse;
  });

  const history = Effect.fn("GuestService.history")(function* (
    guest: GuestRecord,
    botId: string,
    limit: number,
  ) {
    const bot = yield* ownedConversation(guest, botId);
    const { messages, runs } = yield* readThread(threadOf(bot));
    const made = yield* artifacts
      .listForThread(threadOf(bot))
      .pipe(Effect.mapError(internal("Não consegui ler a conversa.")));
    const all = [
      ...messages.filter(isGuestVisible).map((message) => toGuestMessage(guest, message)),
      ...made.map(artifactMessage),
    ].toSorted((left, right) => left.createdAt.localeCompare(right.createdAt));
    const count = Math.min(Math.max(1, Math.trunc(limit)), GUEST_LIMITS.historyMax);
    return {
      messages: all.slice(-count),
      working: runs.some(isWorking),
    } satisfies GuestHistoryResponse;
  });

  const persistImages = Effect.fn("GuestService.persistImages")(function* (
    threadId: ThreadId,
    messageId: MessageId,
    uploads: NonNullable<GuestSendInput["attachments"]>,
  ) {
    return yield* Effect.forEach(uploads, (upload, index) =>
      Effect.gen(function* () {
        const parsed = parseBase64DataUrl(upload.dataUrl);
        if (parsed === null || parsed.mimeType !== upload.mimeType) {
          return yield* new GuestApiError({
            status: 400,
            message: `${upload.name} não é uma imagem ${upload.mimeType} válida.`,
          });
        }
        const bytes = yield* Effect.fromResult(Base64.decode(parsed.base64)).pipe(
          Effect.mapError(
            () =>
              new GuestApiError({
                status: 400,
                message: `${upload.name} veio corrompida. Tente enviar de novo.`,
              }),
          ),
        );
        if (bytes.byteLength === 0 || bytes.byteLength > GUEST_LIMITS.imageBytes) {
          return yield* new GuestApiError({
            status: 413,
            message: `${upload.name} está vazia ou tem mais de ${GUEST_LIMITS.imageBytes / 1024 / 1024} MB.`,
          });
        }
        const rawId = createDeterministicAttachmentId(
          threadId,
          chatAttachmentStableKey(messageId, index, bytes),
        );
        if (rawId === null) return yield* internal("Não consegui guardar a foto.")(undefined);
        const attachment: ChatImageAttachment = {
          type: "image",
          id: ChatAttachmentId.make(rawId),
          // The adapter quotes the name in the prompt.
          name: withoutKeywords(upload.name),
          mimeType: upload.mimeType,
          sizeBytes: bytes.byteLength,
        };
        yield* fs
          .writeFile(path.join(config.attachmentsDir, attachmentRelativePath(attachment)!), bytes)
          .pipe(Effect.mapError(internal("Não consegui guardar a foto.")));
        return attachment;
      }),
    );
  });

  /** Fails closed unless the bot runs in this guest's sandbox. */
  const requireSandbox = Effect.fn("GuestService.requireSandbox")(function* (
    guest: GuestRecord,
    bot: Bot,
  ) {
    const { providerInstances } = yield* settings.getSettings.pipe(
      Effect.mapError(internal("O servidor teve um probleminha. Tente de novo.")),
    );
    const sandboxed = yield* isSandboxedFor(
      providerInstances,
      bot.model.instanceId,
      guest.id,
      home,
    ).pipe(Effect.provide(services));
    if (!sandboxed) {
      yield* Effect.logWarning("Refused a guest message: the bot does not run in the sandbox", {
        guestId: guest.id,
        botId: bot.id,
        instanceId: bot.model.instanceId,
      });
      return yield* new GuestApiError({
        status: 409,
        message: "Este assistente ainda não está pronto. Peça para o Israel dar uma olhada.",
      });
    }
  });

  const send = Effect.fn("GuestService.send")(function* (
    guest: GuestRecord,
    botId: string,
    input: GuestSendInput,
  ) {
    const bot = yield* ownedConversation(guest, botId);
    const uploads = input.attachments ?? [];
    if (input.text.trim() === "" && uploads.length === 0) {
      return yield* new GuestApiError({
        status: 400,
        message: "Escreva uma mensagem ou escolha uma foto.",
      });
    }
    yield* requireSandbox(guest, bot);
    const threadId = threadOf(bot);
    const id = yield* randomUuidV4;
    const messageId = MessageId.make(`${GUEST_MESSAGE_ID_PREFIX}${id}`);
    const attachments = yield* persistImages(threadId, messageId, uploads);
    yield* engine
      .dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`guest:${guest.id}:${id}`),
        threadId,
        messageId,
        // The bot (and the owner, in T3) tells the guest from the owner by this prefix.
        text: fromGuest(guest.name, asPlainText(input.text)),
        attachments,
        // The bot definition decides the model and effort; the guest never does.
        modelSelection: bot.model,
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "server",
      })
      .pipe(Effect.mapError(internal("Não consegui enviar a mensagem.")));
    return { messageId } satisfies GuestSendResult;
  });

  const openStreams = new Map<GuestRecord["id"], number>();

  /** The guest still holds this token and still owns the bot. */
  const stillAuthorized = (guest: GuestRecord, bot: Bot) =>
    Effect.all([guests.getGuest(guest.id), guests.guestOfBot(bot.id)]).pipe(
      Effect.map(
        ([current, owner]) =>
          Option.isSome(current) &&
          current.value.tokenHash !== null &&
          current.value.tokenHash === guest.tokenHash &&
          Option.isSome(owner) &&
          owner.value === guest.id,
      ),
      Effect.orElseSucceed(() => false),
    );

  /** Completes once the stream's guest or bot stops being authorized. */
  const revoked = (guest: GuestRecord, bot: Bot): Effect.Effect<void> =>
    Effect.sleep(STREAM_REVALIDATE).pipe(
      Effect.andThen(stillAuthorized(guest, bot)),
      Effect.flatMap((ok) => (ok ? revoked(guest, bot) : Effect.void)),
    );

  const events = Effect.fn("GuestService.events")(function* (guest: GuestRecord, botId: string) {
    if ((openStreams.get(guest.id) ?? 0) >= MAX_STREAMS_PER_GUEST) {
      return yield* new GuestApiError({
        status: 429,
        message: "Muitas conversas abertas ao mesmo tempo. Feche o app e abra de novo.",
      });
    }
    const bot = yield* ownedConversation(guest, botId);
    const threadId = threadOf(bot);
    // Taken before reading the runs, so a change between the two reads still replays.
    const afterSequence = yield* engine
      .getThreadEventSequence(threadId)
      .pipe(Effect.mapError(internal("Não consegui acompanhar a conversa.")));
    const { runs } = yield* readThread(threadId);
    const active = new Set(runs.filter(isWorking).map((run) => run.id));
    let working = active.size > 0;
    const changes = (event: OrchestrationV2DomainEvent): GuestStreamEvent[] => {
      if (event.type === "message.updated") {
        return isGuestVisible(event.payload)
          ? [{ type: "message", message: toGuestMessage(guest, event.payload) }]
          : [];
      }
      if (event.type !== "run.updated") return [];
      if (isWorking(event.payload)) active.add(event.payload.id);
      else active.delete(event.payload.id);
      if (working === active.size > 0) return [];
      working = active.size > 0;
      return [{ type: "working", working }];
    };
    const initial: GuestStreamEvent = { type: "working", working };
    const made = artifacts.recorded.pipe(
      Stream.filter((artifact) => artifact.threadId === threadId),
      Stream.map((artifact): GuestStreamEvent => ({
        type: "message",
        message: artifactMessage(artifact),
      })),
    );
    const live = Stream.make(initial).pipe(
      Stream.concat(
        Stream.merge(
          engine.streamStoredEventsFrom({ threadId, afterSequence }).pipe(
            Stream.map((stored) => changes(stored.event)),
            Stream.flattenIterable,
            Stream.catchCause((cause) =>
              Stream.fromEffect(
                Effect.logWarning("A guest's live stream failed", { threadId, cause }),
              ).pipe(Stream.drain),
            ),
          ),
          made,
          { haltStrategy: "left" },
        ),
      ),
      Stream.interruptWhen(revoked(guest, bot)),
    );
    // Counted while the response body streams, so a stream that never starts holds no slot.
    return Stream.unwrap(
      Effect.sync(() => {
        openStreams.set(guest.id, (openStreams.get(guest.id) ?? 0) + 1);
        return live.pipe(
          Stream.ensuring(
            Effect.sync(() => {
              const left = (openStreams.get(guest.id) ?? 1) - 1;
              if (left <= 0) openStreams.delete(guest.id);
              else openStreams.set(guest.id, left);
            }),
          ),
        );
      }),
    );
  });

  const attachment = Effect.fn("GuestService.attachment")(function* (
    guest: GuestRecord,
    botId: string,
    attachmentId: string,
  ) {
    const bot = yield* ownedConversation(guest, botId);
    const { messages } = yield* readThread(threadOf(bot));
    const made = yield* artifacts
      .listForThread(threadOf(bot))
      .pipe(Effect.mapError(internal("Não consegui ler a conversa.")));
    const found = conversationImages(messages, made).find(
      (candidate) => candidate.id === attachmentId,
    );
    const relative = found === undefined ? null : imageRelativePath(found);
    if (found === undefined || relative === null) {
      return yield* new GuestApiError({ status: 404, message: "Imagem não encontrada." });
    }
    const bytes = yield* fs
      .readFile(path.join(config.attachmentsDir, relative))
      .pipe(
        Effect.mapError(
          () => new GuestApiError({ status: 404, message: "Imagem não encontrada." }),
        ),
      );
    return { bytes, mimeType: found.mimeType } satisfies GuestAttachmentFile;
  });

  const voiceConversation = Effect.fn("GuestService.voiceConversation")(function* (
    guest: GuestRecord,
    botId: string,
  ) {
    const bot = yield* ownedConversation(guest, botId);
    yield* requireSandbox(guest, bot);
    return {
      threadId: threadOf(bot),
      post: (text: string) => send(guest, bot.id, { text }).pipe(Effect.asVoid),
      revoked: revoked(guest, bot),
    } satisfies GuestVoiceConversation;
  });

  const html = Effect.fn("GuestService.html")(function* (
    guest: GuestRecord,
    botId: string,
    attachmentId: string,
  ) {
    const bot = yield* ownedConversation(guest, botId);
    const artifact = yield* artifacts
      .get(threadOf(bot), attachmentId)
      .pipe(Effect.mapError(internal("Não consegui abrir a página.")));
    const notFound = new GuestApiError({ status: 404, message: "Página não encontrada." });
    if (Option.isNone(artifact) || artifact.value.kind !== "html") return yield* notFound;
    const page = yield* fs
      .readFileString(path.join(config.attachmentsDir, `${artifact.value.id}.html`))
      .pipe(Effect.mapError(() => notFound));
    return { html: page } satisfies GuestHtmlPage;
  });

  const registerPushDevice = Effect.fn("GuestService.registerPushDevice")(function* (
    guest: GuestRecord,
    input: GuestPushDeviceInput,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* guests
      .upsertPushDevice({
        token: input.token,
        guestId: guest.id,
        label: input.label ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .pipe(Effect.mapError(internal("Não consegui ativar as notificações neste celular.")));
    return { token: input.token } satisfies GuestPushDeviceRef;
  });

  const unregisterPushDevice = Effect.fn("GuestService.unregisterPushDevice")(function* (
    guest: GuestRecord,
    input: GuestPushDeviceRef,
  ) {
    yield* guests
      .deletePushDevice(guest.id, input.token)
      .pipe(Effect.mapError(internal("Não consegui desativar as notificações deste celular.")));
    return input;
  });

  return GuestService.of({
    authenticate,
    listBots,
    history,
    send,
    events,
    attachment,
    voiceConversation,
    html,
    registerPushDevice,
    unregisterPushDevice,
  });
});

/** Needs GuestStore, BotsStore and the orchestration runtime beneath it. */
export const layer = Layer.effect(GuestService, make);
