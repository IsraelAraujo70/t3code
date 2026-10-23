/**
 * Guest API (friend fork). A guest is someone the bots host owner lets talk to a few bots of their
 * own through a separate, minimal listener (`T3CODE_GUEST_LISTEN`). Nothing of the regular T3 API
 * is reachable there: a guest lists their bots, reads and sends messages, follows replies live,
 * and registers phones for push. Every request carries `Authorization: Bearer <guest token>`; the
 * server stores only the token's hash and checks every bot id against the guest's ownership.
 *
 * A guest bot's model and effort live in the bot definition. No guest request carries them.
 */
import * as Schema from "effect/Schema";

import { BotId } from "./bots.ts";
import { IsoDateTime, MessageId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const GUEST_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/** Short, lowercase, chosen by the owner (`bia`). It also names the guest's sandbox volume. */
export const GuestId = Schema.String.check(Schema.isPattern(GUEST_ID_PATTERN)).pipe(
  Schema.brand("GuestId"),
);
export type GuestId = typeof GuestId.Type;

export const GUEST_API_PREFIX = "/guest/v1";

/** Every route of the guest listener. Anything else answers 404. */
export const GUEST_API_ROUTES = {
  /** GET → GuestBotsResponse */
  bots: `${GUEST_API_PREFIX}/bots`,
  /** GET ?limit= → GuestHistoryResponse; POST GuestSendInput → GuestSendResult */
  messages: `${GUEST_API_PREFIX}/bots/:botId/messages`,
  /** GET → text/event-stream of GuestStreamEvent, one JSON object per `data:` line */
  events: `${GUEST_API_PREFIX}/bots/:botId/events`,
  /** GET → the image bytes of an attachment on one of the bot's messages */
  attachment: `${GUEST_API_PREFIX}/bots/:botId/attachments/:attachmentId`,
  /** POST GuestPushDeviceInput → GuestPushDeviceRef */
  pushRegister: `${GUEST_API_PREFIX}/push-devices`,
  /** POST GuestPushDeviceRef → GuestPushDeviceRef */
  pushUnregister: `${GUEST_API_PREFIX}/push-devices/unregister`,
} as const;

export const GUEST_LIMITS = {
  text: 20_000,
  attachments: 4,
  /** Decoded bytes per image; the data URL is about 4/3 of this. */
  imageBytes: 8 * 1024 * 1024,
  historyDefault: 50,
  historyMax: 200,
} as const;

export const GuestBotSummary = Schema.Struct({
  id: BotId,
  name: Schema.String,
});
export type GuestBotSummary = typeof GuestBotSummary.Type;

export const GuestBotsResponse = Schema.Struct({
  guest: Schema.Struct({ id: GuestId, name: Schema.String }),
  bots: Schema.Array(GuestBotSummary),
});
export type GuestBotsResponse = typeof GuestBotsResponse.Type;

export const GuestAttachment = Schema.Struct({
  id: TrimmedNonEmptyString,
  name: Schema.String,
  mimeType: Schema.String,
});
export type GuestAttachment = typeof GuestAttachment.Type;

export const GuestMessage = Schema.Struct({
  id: MessageId,
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  attachments: Schema.Array(GuestAttachment),
  /** True while the bot is still writing this reply. */
  streaming: Schema.Boolean,
  createdAt: IsoDateTime,
});
export type GuestMessage = typeof GuestMessage.Type;

export const GuestHistoryResponse = Schema.Struct({
  /** Oldest first. */
  messages: Schema.Array(GuestMessage),
  /** The bot has a run that has not settled. */
  working: Schema.Boolean,
});
export type GuestHistoryResponse = typeof GuestHistoryResponse.Type;

export const GuestImageUpload = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
  mimeType: Schema.Literals(["image/jpeg", "image/png", "image/webp", "image/gif"]),
  /** `data:<mimeType>;base64,<bytes>` */
  dataUrl: TrimmedNonEmptyString.check(
    Schema.isMaxLength(Math.ceil((GUEST_LIMITS.imageBytes * 4) / 3) + 64),
  ),
});
export type GuestImageUpload = typeof GuestImageUpload.Type;

/**
 * Decoded with excess properties rejected, so a request that tries to pick a model, an effort or
 * anything else fails with 400 instead of being silently ignored.
 */
export const GuestSendInput = Schema.Struct({
  text: Schema.String.check(Schema.isMaxLength(GUEST_LIMITS.text)),
  attachments: Schema.optionalKey(
    Schema.Array(GuestImageUpload).check(Schema.isMaxLength(GUEST_LIMITS.attachments)),
  ),
});
export type GuestSendInput = typeof GuestSendInput.Type;

export const GuestSendResult = Schema.Struct({ messageId: MessageId });
export type GuestSendResult = typeof GuestSendResult.Type;

/**
 * The live stream of one bot's conversation. It starts with `working`, then sends every change:
 * a message (user or assistant, the whole text so far each time) and the working flag.
 */
export const GuestStreamEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("message"), message: GuestMessage }),
  Schema.Struct({ type: Schema.Literal("working"), working: Schema.Boolean }),
]);
export type GuestStreamEvent = typeof GuestStreamEvent.Type;

export const GuestPushDeviceRef = Schema.Struct({
  token: TrimmedNonEmptyString.check(Schema.isMaxLength(4096)),
});
export type GuestPushDeviceRef = typeof GuestPushDeviceRef.Type;

export const GuestPushDeviceInput = Schema.Struct({
  ...GuestPushDeviceRef.fields,
  label: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(128))),
});
export type GuestPushDeviceInput = typeof GuestPushDeviceInput.Type;

/** Every non-2xx answer of the guest listener. Messages are safe to show the guest. */
export const GuestErrorBody = Schema.Struct({ error: Schema.String });
export type GuestErrorBody = typeof GuestErrorBody.Type;

/** The URL scheme of the pairing payload the guest app scans or pastes. */
export const GUEST_PAIRING_SCHEME = "t3guest:";

/** `t3guest://pair?server=<origin>&token=<token>`; what the owner's QR code encodes. */
export function formatGuestPairing(input: { readonly server: string; readonly token: string }) {
  const params = new URLSearchParams({ server: input.server, token: input.token });
  return `${GUEST_PAIRING_SCHEME}//pair?${params.toString()}`;
}

/** Inverse of formatGuestPairing; null for anything else, including a non-http(s) server. */
export function parseGuestPairing(
  text: string,
): { readonly server: string; readonly token: string } | null {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return null;
  }
  if (url.protocol !== GUEST_PAIRING_SCHEME || url.hostname !== "pair") return null;
  const server = url.searchParams.get("server");
  const token = url.searchParams.get("token");
  if (server === null || token === null || token.length === 0) return null;
  let origin: URL;
  try {
    origin = new URL(server);
  } catch {
    return null;
  }
  if (origin.protocol !== "http:" && origin.protocol !== "https:") return null;
  return { server: origin.origin, token };
}
