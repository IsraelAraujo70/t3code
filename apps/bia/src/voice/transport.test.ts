import type { BotId, MessageId, VoiceSessionId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { ERROR_MESSAGES } from "../api";
import { guestVoiceTransport, parseVoiceEvent, sameBiaVoiceTarget } from "./transport";

const pairing = { server: "http://100.64.0.1:3794", token: "t3g_token" };
const botId = "b_casa" as BotId;
const conversation = { pairing, botId, mode: { type: "conversation" } } as const;
const read = (messageId: string) => ({
  pairing,
  botId,
  mode: { type: "read" as const, messageId: messageId as MessageId },
});

/** Stands in for React Native's XMLHttpRequest: the test plays the server's side. */
class FakeRequest {
  static last: FakeRequest | null = null;
  method = "";
  url = "";
  headers: Record<string, string> = {};
  body: string | null = null;
  status = 0;
  responseText = "";
  aborted = false;
  private readonly listeners = new Map<string, Array<() => void>>();

  constructor() {
    FakeRequest.last = this;
  }
  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  addEventListener(type: string, listener: () => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  send(body: string) {
    this.body = body;
  }
  abort() {
    this.aborted = true;
  }
  emit(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
  /** The server writes `events` to an open 200 stream. */
  stream(...events: unknown[]) {
    this.status = 200;
    this.responseText += events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
    this.emit("progress");
  }
}

function open(target: Parameters<typeof guestVoiceTransport.session>[0]) {
  vi.stubGlobal("XMLHttpRequest", FakeRequest);
  const handlers = { onAnswer: vi.fn(), onBot: vi.fn(), onVoiceChange: vi.fn(), onEnd: vi.fn() };
  const end = guestVoiceTransport.session(target, "offer-sdp", handlers);
  const request = FakeRequest.last!;
  return { handlers, end, request, [Symbol.dispose]: () => vi.unstubAllGlobals() };
}

describe("guest voice transport", () => {
  it("posts only the mode and the offer, with Bia's token, to her bot's voice route", () => {
    using t = open(read("m1"));
    expect(t.request.method).toBe("POST");
    expect(t.request.url).toBe("http://100.64.0.1:3794/guest/v1/bots/b_casa/voice");
    expect(t.request.headers.Authorization).toBe("Bearer t3g_token");
    expect(JSON.parse(t.request.body!)).toEqual({
      mode: { type: "read", messageId: "m1" },
      sdp: "offer-sdp",
    });
  });

  it("hands over the answer and the bot's work, then ends once", () => {
    using t = open(conversation);
    t.request.stream({ type: "answer", sessionId: "s1", sdp: "answer-sdp" });
    t.request.responseText += ": keep-alive\n\n";
    t.request.stream({ type: "bot", working: true }, { type: "bot", working: false });
    expect(t.handlers.onAnswer).toHaveBeenCalledWith({
      type: "answer",
      sessionId: "s1",
      sdp: "answer-sdp",
    });
    expect(t.handlers.onBot.mock.calls).toEqual([[true], [false]]);
    t.request.emit("loadend");
    t.request.emit("loadend");
    expect(t.handlers.onEnd.mock.calls).toEqual([[null]]);
  });

  it("ends with the server's message, whether streamed or refused up front", () => {
    using streamed = open(conversation);
    streamed.request.stream({ type: "error", message: "A voz parou de funcionar. Tente de novo." });
    streamed.request.emit("loadend");
    expect(streamed.handlers.onEnd.mock.calls).toEqual([
      ["A voz parou de funcionar. Tente de novo."],
    ]);

    using refused = open(conversation);
    refused.request.status = 404;
    refused.request.responseText = JSON.stringify({ error: "Assistente não encontrado." });
    refused.request.emit("loadend");
    expect(refused.handlers.onEnd.mock.calls).toEqual([["Assistente não encontrado."]]);

    using revoked = open(conversation);
    revoked.request.status = 401;
    revoked.request.emit("loadend");
    expect(revoked.handlers.onEnd.mock.calls).toEqual([[ERROR_MESSAGES.unauthorized]]);

    using offline = open(conversation);
    offline.request.emit("loadend");
    expect(offline.handlers.onEnd.mock.calls).toEqual([[ERROR_MESSAGES.offline]]);
  });

  it("stays quiet once the controller ends the stream", () => {
    using t = open(conversation);
    t.end();
    expect(t.request.aborted).toBe(true);
    t.request.stream({ type: "bot", working: true });
    t.request.emit("loadend");
    expect(t.handlers.onBot).not.toHaveBeenCalled();
    expect(t.handlers.onEnd).not.toHaveBeenCalled();
  });
});

describe("parseVoiceEvent", () => {
  it("reads the guest voice events and nothing else", () => {
    expect(parseVoiceEvent('{"type":"answer","sessionId":"s","sdp":"x"}')).toEqual({
      type: "answer",
      sessionId: "s" as VoiceSessionId,
      sdp: "x",
    });
    expect(parseVoiceEvent('{"type":"bot","working":false}')).toEqual({
      type: "bot",
      working: false,
    });
    for (const data of [
      "not json",
      '{"type":"answer","sessionId":1,"sdp":"x"}',
      '{"type":"bot","working":"yes"}',
      '{"type":"voice-changed"}',
      "null",
    ])
      expect(parseVoiceEvent(data), data).toBeNull();
  });
});

describe("sameBiaVoiceTarget", () => {
  it("matches one bot's conversation, or one reply of it", () => {
    expect(sameBiaVoiceTarget(conversation, { ...conversation })).toBe(true);
    expect(sameBiaVoiceTarget(read("m1"), read("m1"))).toBe(true);
    expect(sameBiaVoiceTarget(read("m1"), read("m2"))).toBe(false);
    expect(sameBiaVoiceTarget(conversation, read("m1"))).toBe(false);
    expect(sameBiaVoiceTarget(conversation, { ...conversation, botId: "b_outro" as BotId })).toBe(
      false,
    );
  });
});
