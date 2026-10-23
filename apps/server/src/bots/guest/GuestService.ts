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
import { BotsStore } from "../BotsStore.ts";
import { hashGuestToken } from "./guestToken.ts";
import { type GuestRecord, GuestStore } from "./GuestStore.ts";
import { isSandboxedFor } from "./sandboxInstance.ts";

/** An answer for the guest: `status` is the HTTP status, `message` is safe to show them. */
export class GuestApiError extends Schema.TaggedError<GuestApiError>()("GuestApiError", {
  status: Schema.Literals([400, 401, 404, 409, 413, 500]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface GuestAttachmentFile {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
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
    readonly attachment: (
      guest: GuestRecord,
      botId: string,
      attachmentId: string,
    ) => Effect.Effect<GuestAttachmentFile, GuestApiError>;
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
  new GuestApiError({ status: 401, message: "Missing, unknown or revoked guest token." });
const botNotFound = () => new GuestApiError({ status: 404, message: "Bot not found." });
const internal = (message: string) => (cause: unknown) =>
  new GuestApiError({ status: 500, message, cause });

const isBotId = Schema.is(BotId);

/** The messages a guest sees: what a person typed and what the bot answered. */
const isGuestVisible = (message: OrchestrationV2ConversationMessage) =>
  message.senderThreadId === undefined &&
  (message.role === "assistant" || (message.role === "user" && message.createdBy === "user"));

const toGuestMessage = (message: OrchestrationV2ConversationMessage): GuestMessage => ({
  id: message.id,
  role: message.role === "assistant" ? "assistant" : "user",
  text: message.text,
  attachments: message.attachments.flatMap((attachment) =>
    attachment.type === "image"
      ? [{ id: attachment.id, name: attachment.name, mimeType: attachment.mimeType }]
      : [],
  ),
  streaming: message.streaming,
  createdAt: DateTime.formatIso(message.createdAt),
});

/** A held queued run waits for a person, so it is not the bot working. */
const isWorking = (run: Pick<OrchestrationV2Run, "status" | "queueHeld">) =>
  !isTerminalRunStatus(run.status) && !(run.status === "queued" && run.queueHeld === true);

const make = Effect.gen(function* () {
  const guests = yield* GuestStore;
  const bots = yield* BotsStore;
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();

  const authenticate = Effect.fn("GuestService.authenticate")(function* (
    authorization: string | undefined,
  ) {
    const match = /^Bearer (\S+)$/.exec(authorization?.trim() ?? "");
    const hash = match === null ? null : hashGuestToken(match[1]!);
    if (hash === null) return yield* unauthorized();
    const guest = yield* guests
      .getGuestByTokenHash(hash)
      .pipe(Effect.mapError(internal("Could not check the guest token.")));
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
      .pipe(Effect.mapError(internal("Could not read the bot.")));
    if (Option.isNone(owner) || owner.value !== guest.id) return yield* botNotFound();
    const bot = yield* bots
      .getBot(rawBotId)
      .pipe(Effect.mapError(internal("Could not read the bot.")));
    return Option.isSome(bot) ? bot.value : yield* botNotFound();
  });

  const threadOf = (bot: Bot): ThreadId => botThreadId(bot.id, bot.homeGeneration);

  const readThread = (threadId: ThreadId) =>
    projections
      .getThreadRecords(threadId, ["messages", "runs"], { messageRoles: ["user", "assistant"] })
      .pipe(
        Effect.mapError((cause) =>
          cause._tag === "ProjectionStoreThreadNotFoundError"
            ? new GuestApiError({ status: 409, message: "This bot is still starting. Try again." })
            : new GuestApiError({
                status: 500,
                message: "Could not read the conversation.",
                cause,
              }),
        ),
      );

  const listBots = Effect.fn("GuestService.listBots")(function* (guest: GuestRecord) {
    const ids = yield* guests
      .listGuestBotIds(guest.id)
      .pipe(Effect.mapError(internal("Could not list your bots.")));
    const owned = yield* Effect.forEach(ids, (id) =>
      bots.getBot(id).pipe(Effect.mapError(internal("Could not list your bots."))),
    );
    return {
      guest: { id: guest.id, name: guest.name },
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
    const bot = yield* ownedBot(guest, botId);
    const { messages, runs } = yield* readThread(threadOf(bot));
    const visible = messages.filter(isGuestVisible);
    const count = Math.min(Math.max(1, Math.trunc(limit)), GUEST_LIMITS.historyMax);
    return {
      messages: visible.slice(-count).map(toGuestMessage),
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
            message: `${upload.name} is not a valid ${upload.mimeType} image.`,
          });
        }
        const bytes = yield* Effect.fromResult(Base64.decode(parsed.base64)).pipe(
          Effect.mapError(
            () =>
              new GuestApiError({ status: 400, message: `${upload.name} is not valid base64.` }),
          ),
        );
        if (bytes.byteLength === 0 || bytes.byteLength > GUEST_LIMITS.imageBytes) {
          return yield* new GuestApiError({
            status: 413,
            message: `${upload.name} is empty or larger than ${GUEST_LIMITS.imageBytes / 1024 / 1024} MB.`,
          });
        }
        const rawId = createDeterministicAttachmentId(
          threadId,
          chatAttachmentStableKey(messageId, index, bytes),
        );
        if (rawId === null) return yield* internal("Could not store the image.")(undefined);
        const attachment: ChatImageAttachment = {
          type: "image",
          id: ChatAttachmentId.make(rawId),
          name: upload.name,
          mimeType: upload.mimeType,
          sizeBytes: bytes.byteLength,
        };
        yield* fs
          .writeFile(path.join(config.attachmentsDir, attachmentRelativePath(attachment)!), bytes)
          .pipe(Effect.mapError(internal("Could not store the image.")));
        return attachment;
      }),
    );
  });

  const send = Effect.fn("GuestService.send")(function* (
    guest: GuestRecord,
    botId: string,
    input: GuestSendInput,
  ) {
    const bot = yield* ownedBot(guest, botId);
    const uploads = input.attachments ?? [];
    if (input.text.trim() === "" && uploads.length === 0) {
      return yield* new GuestApiError({ status: 400, message: "Write a message or add a photo." });
    }
    const { providerInstances } = yield* settings.getSettings.pipe(
      Effect.mapError(internal("Could not read the server settings.")),
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
        message: "This bot is not ready yet. Ask Israel to check it.",
      });
    }
    const threadId = threadOf(bot);
    const id = yield* randomUuidV4;
    const messageId = MessageId.make(`guest:${id}`);
    const attachments = yield* persistImages(threadId, messageId, uploads);
    yield* engine
      .dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`guest:${guest.id}:${id}`),
        threadId,
        messageId,
        text: input.text,
        attachments,
        // The bot definition decides the model and effort; the guest never does.
        modelSelection: bot.model,
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "server",
      })
      .pipe(Effect.mapError(internal("Could not send the message.")));
    return { messageId } satisfies GuestSendResult;
  });

  const events = Effect.fn("GuestService.events")(function* (guest: GuestRecord, botId: string) {
    const bot = yield* ownedBot(guest, botId);
    const threadId = threadOf(bot);
    // Taken before reading the runs, so a change between the two reads still replays.
    const afterSequence = yield* engine
      .getThreadEventSequence(threadId)
      .pipe(Effect.mapError(internal("Could not follow the conversation.")));
    const { runs } = yield* readThread(threadId);
    const active = new Set(runs.filter(isWorking).map((run) => run.id));
    let working = active.size > 0;
    const changes = (event: OrchestrationV2DomainEvent): GuestStreamEvent[] => {
      if (event.type === "message.updated") {
        return isGuestVisible(event.payload)
          ? [{ type: "message", message: toGuestMessage(event.payload) }]
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
    return Stream.make(initial).pipe(
      Stream.concat(
        engine.streamStoredEventsFrom({ threadId, afterSequence }).pipe(
          Stream.map((stored) => changes(stored.event)),
          Stream.flattenIterable,
          Stream.catchCause((cause) =>
            Stream.fromEffect(
              Effect.logWarning("A guest's live stream failed", { threadId, cause }),
            ).pipe(Stream.drain),
          ),
        ),
      ),
    );
  });

  const attachment = Effect.fn("GuestService.attachment")(function* (
    guest: GuestRecord,
    botId: string,
    attachmentId: string,
  ) {
    const bot = yield* ownedBot(guest, botId);
    const { messages } = yield* readThread(threadOf(bot));
    const found = messages
      .filter(isGuestVisible)
      .flatMap((message) => message.attachments)
      .find((candidate) => candidate.type === "image" && candidate.id === attachmentId);
    const relative = found === undefined ? null : attachmentRelativePath(found);
    if (found === undefined || relative === null) {
      return yield* new GuestApiError({ status: 404, message: "Image not found." });
    }
    const bytes = yield* fs
      .readFile(path.join(config.attachmentsDir, relative))
      .pipe(Effect.mapError(() => new GuestApiError({ status: 404, message: "Image not found." })));
    return { bytes, mimeType: found.mimeType } satisfies GuestAttachmentFile;
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
      .pipe(Effect.mapError(internal("Could not register this phone for notifications.")));
    return { token: input.token } satisfies GuestPushDeviceRef;
  });

  const unregisterPushDevice = Effect.fn("GuestService.unregisterPushDevice")(function* (
    guest: GuestRecord,
    input: GuestPushDeviceRef,
  ) {
    yield* guests
      .deletePushDevice(guest.id, input.token)
      .pipe(Effect.mapError(internal("Could not unregister this phone.")));
    return input;
  });

  return GuestService.of({
    authenticate,
    listBots,
    history,
    send,
    events,
    attachment,
    registerPushDevice,
    unregisterPushDevice,
  });
});

/** Needs GuestStore, BotsStore and the orchestration runtime beneath it. */
export const layer = Layer.effect(GuestService, make);
