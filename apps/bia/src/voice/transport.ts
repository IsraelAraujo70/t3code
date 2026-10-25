import type { GuestVoiceEvent, VoiceSessionId, VoiceSessionMode } from "@t3tools/contracts";
import type { VoiceTransport } from "@t3tools/client-runtime/voice";

import {
  authorizationHeader,
  ERROR_MESSAGES,
  errorFromResponse,
  voiceReady,
  voiceReport,
  voiceUrl,
  type BotId,
} from "../api";
import type { Pairing } from "../pairing";
import { readSseEvents } from "../sse";

/** A voice session in this app: a conversation with one of Bia's bots, or one reply read aloud. */
export interface BiaVoiceTarget {
  readonly pairing: Pairing;
  readonly botId: BotId;
  readonly mode: VoiceSessionMode;
}

export function sameBiaVoiceTarget(a: BiaVoiceTarget, b: BiaVoiceTarget): boolean {
  if (a.pairing.server !== b.pairing.server || a.pairing.token !== b.pairing.token) return false;
  if (a.botId !== b.botId) return false;
  if (a.mode.type === "read" && b.mode.type === "read")
    return a.mode.messageId === b.mode.messageId;
  return a.mode.type === b.mode.type;
}

/** One `data:` payload as a voice event, or null when it is not one the app understands. */
export function parseVoiceEvent(data: string): GuestVoiceEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || !("type" in value)) return null;
  if (
    value.type === "answer" &&
    "sessionId" in value &&
    typeof value.sessionId === "string" &&
    "sdp" in value &&
    typeof value.sdp === "string"
  )
    // The server encodes with the contract; the app does not bundle Effect's schemas to brand it.
    return { type: "answer", sessionId: value.sessionId as VoiceSessionId, sdp: value.sdp };
  if (value.type === "bot" && "working" in value && typeof value.working === "boolean")
    return { type: "bot", working: value.working };
  if (value.type === "error" && "message" in value && typeof value.message === "string")
    return { type: "error", message: value.message };
  return null;
}

/** Keep-alives arrive every 25 seconds; a socket that stays silent longer died on the way. */
const IDLE_TIMEOUT_MS = 75_000;

/**
 * Voice signaling over the guest API. The session is one POST whose response streams its events,
 * read like the bot streams from the XHR's growing `responseText`.
 */
export const guestVoiceTransport: VoiceTransport<BiaVoiceTarget> = {
  session: (target, sdp, { onAnswer, onBot, onEnd }) => {
    const request = new XMLHttpRequest();
    let cursor = 0;
    let finished = false;
    let idle: ReturnType<typeof setTimeout> | null = null;
    const finish = (error: string | null) => {
      if (finished) return;
      finished = true;
      if (idle !== null) clearTimeout(idle);
      request.abort();
      onEnd(error);
    };
    const touch = () => {
      if (idle !== null) clearTimeout(idle);
      idle = setTimeout(() => finish(ERROR_MESSAGES.offline), IDLE_TIMEOUT_MS);
    };
    const read = () => {
      if (finished || request.status !== 200) return;
      touch();
      const next = readSseEvents(request.responseText, cursor);
      cursor = next.cursor;
      for (const data of next.data) {
        const event = parseVoiceEvent(data);
        if (event === null) continue;
        if (event.type === "answer") onAnswer(event);
        else if (event.type === "bot") onBot(event.working);
        else finish(event.message);
        if (finished) return;
      }
    };
    request.open("POST", voiceUrl(target.pairing, target.botId));
    request.setRequestHeader("Accept", "text/event-stream");
    request.setRequestHeader("Authorization", authorizationHeader(target.pairing));
    request.setRequestHeader("Content-Type", "application/json");
    // A progress listener added before send makes React Native deliver the body as it arrives.
    request.addEventListener("progress", read);
    request.addEventListener("loadend", () => {
      if (finished) return;
      read();
      if (request.status === 200) finish(null);
      else if (request.status === 0) finish(ERROR_MESSAGES.offline);
      else finish(errorFromResponse(request.status, request.responseText).message);
    });
    touch();
    // Rebuilt field by field: the server rejects any extra property.
    const mode =
      target.mode.type === "read"
        ? { type: "read", messageId: target.mode.messageId }
        : { type: "conversation" };
    request.send(JSON.stringify({ mode, sdp }));
    return () => {
      finished = true;
      if (idle !== null) clearTimeout(idle);
      request.abort();
    };
  },
  ready: async (target, sessionId) => {
    await voiceReady(target.pairing, { sessionId });
  },
  reconnect: () => Promise.reject(new Error("Guest voice sessions keep their voice.")),
  report: async (target, sessionId, entries) => {
    await voiceReport(target.pairing, { sessionId, entries });
  },
};
