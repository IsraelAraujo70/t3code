import type {
  GUEST_API_ROUTES,
  GuestBotSummary,
  GuestBotsResponse,
  GuestHistoryResponse,
  GuestPushDeviceInput,
  GuestPushDeviceRef,
  GuestSendInput,
  GuestSendResult,
  VoiceReportInput,
  VoiceSessionRef,
} from "@t3tools/contracts";

import type { Pairing } from "./pairing";

export type BotId = GuestBotSummary["id"];

/** A copy of the contract's routes; `satisfies` fails the typecheck if they ever drift. */
const ROUTES = {
  bots: "/guest/v1/bots",
  messages: "/guest/v1/bots/:botId/messages",
  events: "/guest/v1/bots/:botId/events",
  attachment: "/guest/v1/bots/:botId/attachments/:attachmentId",
  html: "/guest/v1/bots/:botId/html/:attachmentId",
  pushRegister: "/guest/v1/push-devices",
  pushUnregister: "/guest/v1/push-devices/unregister",
  voice: "/guest/v1/bots/:botId/voice",
  voiceReady: "/guest/v1/voice/ready",
  voiceReport: "/guest/v1/voice/report",
} as const satisfies typeof GUEST_API_ROUTES;

export const ERROR_MESSAGES = {
  unauthorized: "Seu acesso expirou ou foi revogado. Peça um novo QR code.",
  offline: "Não consegui falar com o servidor. Confira sua internet e tente de novo.",
  timeout: "O servidor demorou demais para responder. Tente de novo em instantes.",
  tooLarge: "As fotos ficaram grandes demais. Tente mandar menos fotos de uma vez.",
  server: "O servidor teve um probleminha. Tente de novo em instantes.",
} as const;

export type GuestApiErrorKind = "unauthorized" | "network" | "rejected";

/** Every failure of a guest request; `message` is ready to show Bia. */
export class GuestApiError extends Error {
  readonly kind: GuestApiErrorKind;

  constructor(kind: GuestApiErrorKind, message: string) {
    super(message);
    this.name = "GuestApiError";
    this.kind = kind;
  }
}

/** Maps a non-2xx answer; the server's `{ error }` text is written to be shown to the guest. */
export function errorFromResponse(status: number, body: string): GuestApiError {
  if (status === 401) return new GuestApiError("unauthorized", ERROR_MESSAGES.unauthorized);
  if (status === 413) return new GuestApiError("rejected", ERROR_MESSAGES.tooLarge);
  let serverText: string | null = null;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
      const { error } = parsed;
      if (typeof error === "string" && error.trim().length > 0) serverText = error.trim();
    }
  } catch {
    // Not JSON (a proxy page, an empty body); fall back to the generic text.
  }
  if (serverText !== null) return new GuestApiError("rejected", serverText);
  return new GuestApiError(
    "rejected",
    status >= 500 ? ERROR_MESSAGES.server : `Algo deu errado (código ${status}).`,
  );
}

export function errorFromFailure(cause: unknown): GuestApiError {
  if (cause instanceof GuestApiError) return cause;
  if (cause instanceof SyntaxError) return new GuestApiError("rejected", ERROR_MESSAGES.server);
  const timedOut = cause instanceof Error && cause.name === "AbortError";
  return new GuestApiError("network", timedOut ? ERROR_MESSAGES.timeout : ERROR_MESSAGES.offline);
}

function botPath(route: string, botId: BotId): string {
  return route.replace(":botId", encodeURIComponent(botId));
}

export function authorizationHeader(pairing: Pairing): string {
  return `Bearer ${pairing.token}`;
}

export function eventsUrl(pairing: Pairing, botId: BotId): string {
  return pairing.server + botPath(ROUTES.events, botId);
}

export function voiceUrl(pairing: Pairing, botId: BotId): string {
  return pairing.server + botPath(ROUTES.voice, botId);
}

/** An expo-image source for an attachment; images need the same bearer token as the API. */
export function attachmentSource(
  pairing: Pairing,
  botId: BotId,
  attachmentId: string,
): { readonly uri: string; readonly headers: Record<string, string> } {
  return {
    uri:
      pairing.server +
      botPath(ROUTES.attachment, botId).replace(":attachmentId", encodeURIComponent(attachmentId)),
    headers: { Authorization: authorizationHeader(pairing) },
  };
}

/**
 * A WebView source for a page the bot published. The server sends it under a sandbox CSP, so the
 * page runs with an opaque origin: the token goes only with this one request.
 */
export function htmlSource(
  pairing: Pairing,
  botId: BotId,
  attachmentId: string,
): { readonly uri: string; readonly headers: Record<string, string> } {
  return {
    uri:
      pairing.server +
      botPath(ROUTES.html, botId).replace(":attachmentId", encodeURIComponent(attachmentId)),
    headers: { Authorization: authorizationHeader(pairing) },
  };
}

async function request<T>(
  pairing: Pairing,
  path: string,
  options: { readonly body?: unknown; readonly timeoutMs?: number } = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
  try {
    const response = await fetch(pairing.server + path, {
      method: options.body === undefined ? "GET" : "POST",
      headers: {
        Accept: "application/json",
        Authorization: authorizationHeader(pairing),
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw errorFromResponse(response.status, text);
    // The server decodes and encodes with the same contract; the app does not bundle Effect's
    // schemas just to decode them again.
    return JSON.parse(text) as T;
  } catch (cause) {
    throw errorFromFailure(cause);
  } finally {
    clearTimeout(timer);
  }
}

export function listBots(pairing: Pairing): Promise<GuestBotsResponse> {
  return request(pairing, ROUTES.bots);
}

export function loadHistory(pairing: Pairing, botId: BotId): Promise<GuestHistoryResponse> {
  return request(pairing, `${botPath(ROUTES.messages, botId)}?limit=50`);
}

export function sendMessage(
  pairing: Pairing,
  botId: BotId,
  input: GuestSendInput,
): Promise<GuestSendResult> {
  // Rebuilt field by field: the server rejects any extra property.
  const body: GuestSendInput = {
    text: input.text,
    ...(input.attachments && input.attachments.length > 0
      ? {
          attachments: input.attachments.map(({ name, mimeType, dataUrl }) => ({
            name,
            mimeType,
            dataUrl,
          })),
        }
      : {}),
  };
  return request(pairing, botPath(ROUTES.messages, botId), { body, timeoutMs: 120_000 });
}

export function registerPushDevice(
  pairing: Pairing,
  input: GuestPushDeviceInput,
): Promise<GuestPushDeviceRef> {
  return request(pairing, ROUTES.pushRegister, { body: input });
}

export function unregisterPushDevice(
  pairing: Pairing,
  ref: GuestPushDeviceRef,
): Promise<GuestPushDeviceRef> {
  return request(pairing, ROUTES.pushUnregister, { body: { token: ref.token } });
}

export function voiceReady(pairing: Pairing, ref: VoiceSessionRef): Promise<VoiceSessionRef> {
  return request(pairing, ROUTES.voiceReady, { body: { sessionId: ref.sessionId } });
}

export function voiceReport(pairing: Pairing, input: VoiceReportInput): Promise<unknown> {
  return request(pairing, ROUTES.voiceReport, { body: input });
}
