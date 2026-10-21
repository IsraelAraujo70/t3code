import { BotsError } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import {
  isChatGptAccount,
  makeRealtimeHost,
  type RealtimeRpc,
  type RealtimeNotifications as Payloads,
  VOICE_READER_NO_AGENT_MODEL,
  voiceReaderThreadStart,
} from "./CodexRealtime.ts";

const fakeRpc = Effect.gen(function* () {
  const calls: Array<{ method: string; params: unknown }> = [];
  const requests = yield* Queue.unbounded<string>();
  const responses = new Map<string, Effect.Effect<unknown, Error>>();
  type Handlers = { [M in keyof Payloads]: (payload: Payloads[M]) => Effect.Effect<void> };
  let handlers: Partial<Handlers> = {};
  const rpc: RealtimeRpc = {
    request: (method, params) =>
      Effect.gen(function* () {
        calls.push({ method, params });
        const response = responses.get(method);
        // The host lists voices once when it is made, before any session.
        if (method === "thread/realtime/listVoices")
          return yield* response ?? Effect.fail(new BotsError({ message: "unknown method" }));
        yield* Queue.offer(requests, method);
        if (response) return yield* response;
        // Like Codex: a requested stop is followed by `closed`.
        if (method === "thread/realtime/stop")
          yield* emit("thread/realtime/closed", { threadId: "thread", reason: "requested" });
      }),
    onNotification: (registered) =>
      Effect.sync(() => {
        handlers = registered;
      }),
  };
  const emit = <M extends keyof Payloads>(method: M, payload: Payloads[M]) =>
    handlers[method]?.(payload) ?? Effect.void;
  return { rpc, calls, requests, emit, responses };
});

const input = {
  offerSdp: "offer",
  prompt: "Read this aloud",
  voice: "porto",
  delegationAckFiller: true,
} as const;

it.effect("starts WebRTC v3 with the prompt and voice and returns the notified answer", () =>
  Effect.gen(function* () {
    const fake = yield* fakeRpc;
    const host = yield* makeRealtimeHost(fake.rpc, "thread");
    const pending = yield* host.startSession(input).pipe(Effect.forkChild);
    yield* Queue.take(fake.requests);
    yield* fake.emit("thread/realtime/sdp", { threadId: "thread", sdp: "answer" });
    const session = yield* Fiber.join(pending);
    assert.equal(session.answerSdp, "answer");
    assert.deepEqual(fake.calls[1], {
      method: "thread/realtime/start",
      params: {
        threadId: "thread",
        version: "v3",
        outputModality: "audio",
        includeStartupContext: false,
        clientManagedHandoffs: true,
        flushTranscriptTailOnSessionEnd: false,
        delegationAckFiller: true,
        prompt: input.prompt,
        voice: "porto",
        transport: { type: "webrtc", sdp: "offer" },
      },
    });
  }).pipe(Effect.scoped),
);

it.effect("sends a voice Codex offers and leaves out one it does not", () =>
  Effect.gen(function* () {
    const started = Effect.fn("test.started")(function* (offered: unknown, voice: string) {
      const fake = yield* fakeRpc;
      fake.responses.set("thread/realtime/listVoices", Effect.succeed(offered));
      const host = yield* makeRealtimeHost(fake.rpc, "thread");
      const pending = yield* host.startSession({ ...input, voice }).pipe(Effect.forkChild);
      yield* Queue.take(fake.requests);
      yield* fake.emit("thread/realtime/sdp", { threadId: "thread", sdp: "answer" });
      yield* Fiber.join(pending);
      const start = fake.calls.find((call) => call.method === "thread/realtime/start");
      return (start?.params as { voice?: string } | undefined)?.voice;
    });
    const v3 = { voices: { v1: ["cove"], v3: ["cove", "porto"] } };
    // Releases before the v3 list offer only v1 voices for v3.
    const v1Only = { voices: { v1: ["cove", "sol"] } };
    assert.equal(yield* started(v3, "porto"), "porto");
    assert.equal(yield* started(v1Only, "porto"), undefined);
    assert.equal(yield* started(v1Only, "sol"), "sol");
  }).pipe(Effect.scoped),
);

it.effect(
  "reports the voice's words and finished user utterances of its own thread, then closed",
  () =>
    Effect.gen(function* () {
      const fake = yield* fakeRpc;
      const host = yield* makeRealtimeHost(fake.rpc, "thread");
      const pending = yield* host.startSession(input).pipe(Effect.forkChild);
      yield* Queue.take(fake.requests);
      yield* fake.emit("thread/realtime/sdp", { threadId: "thread", sdp: "answer" });
      const session = yield* Fiber.join(pending);
      yield* fake.emit("thread/realtime/transcript/delta", {
        threadId: "other",
        role: "assistant",
        delta: "ignored",
      });
      yield* fake.emit("thread/realtime/transcript/delta", {
        threadId: "thread",
        role: "user",
        delta: "ignored",
      });
      yield* fake.emit("thread/realtime/transcript/done", {
        threadId: "thread",
        role: "user",
        text: " Quanto é sete vezes oito ",
      });
      yield* fake.emit("thread/realtime/transcript/done", {
        threadId: "thread",
        role: "user",
        text: " ",
      });
      yield* fake.emit("thread/realtime/transcript/done", {
        threadId: "other",
        role: "user",
        text: "ignored",
      });
      yield* fake.emit("thread/realtime/transcript/delta", {
        threadId: "thread",
        role: "assistant",
        delta: "hello",
      });
      yield* fake.emit("thread/realtime/transcript/done", {
        threadId: "thread",
        role: "assistant",
        text: "hello",
      });
      yield* fake.emit("thread/realtime/error", { threadId: "thread", message: "late error" });
      yield* fake.emit("thread/realtime/closed", { threadId: "other", reason: "ignored" });
      yield* fake.emit("thread/realtime/closed", { threadId: "thread" });
      yield* fake.emit("thread/realtime/transcript/delta", {
        threadId: "thread",
        role: "assistant",
        delta: "after closed",
      });
      const events = yield* Stream.runCollect(session.events);
      assert.deepEqual(Array.from(events), [
        { type: "user-transcript", text: "Quanto é sete vezes oito" },
        { type: "transcript", delta: "hello" },
        { type: "transcript-done" },
        { type: "error", message: "late error" },
        { type: "closed", reason: null },
      ]);
    }).pipe(Effect.scoped),
);

it.effect("fails on realtime error before SDP", () =>
  Effect.gen(function* () {
    const fake = yield* fakeRpc;
    const host = yield* makeRealtimeHost(fake.rpc, "thread");
    const pending = yield* host.startSession(input).pipe(Effect.flip, Effect.forkChild);
    yield* Queue.take(fake.requests);
    yield* fake.emit("thread/realtime/error", { threadId: "thread", message: "unavailable" });
    const error = yield* Fiber.join(pending);
    assert.equal(error._tag, "BotsError");
    assert.equal(error.message, "Codex realtime failed: unavailable");
  }).pipe(Effect.scoped),
);

it.effect("times out without SDP after twenty seconds", () =>
  Effect.gen(function* () {
    const fake = yield* fakeRpc;
    const host = yield* makeRealtimeHost(fake.rpc, "thread");
    const pending = yield* host.startSession(input).pipe(Effect.flip, Effect.forkChild);
    yield* Queue.take(fake.requests);
    yield* TestClock.adjust("20 seconds");
    const error = yield* Fiber.join(pending);
    assert.equal(error._tag, "BotsError");
    assert.equal(error.message, "Codex realtime did not answer in time.");
  }).pipe(Effect.scoped),
);

it.effect("sends speech and stops exactly once across explicit stop and scope close", () =>
  Effect.gen(function* () {
    const fake = yield* fakeRpc;
    const host = yield* makeRealtimeHost(fake.rpc, "thread");
    const ready = yield* Deferred.make<void>();
    const done = yield* Deferred.make<void>();
    const worker = yield* Effect.gen(function* () {
      const session = yield* host.startSession(input);
      yield* session.appendSpeech("words");
      yield* session.stop;
      yield* session.stop;
      yield* Deferred.succeed(ready, undefined);
      yield* Deferred.await(done);
    }).pipe(Effect.scoped, Effect.forkChild);
    yield* Queue.take(fake.requests);
    yield* fake.emit("thread/realtime/sdp", { threadId: "thread", sdp: "answer" });
    yield* Deferred.await(ready);
    yield* Deferred.succeed(done, undefined);
    yield* Fiber.join(worker);
    assert.deepEqual(
      fake.calls.filter((call) => call.method === "thread/realtime/appendSpeech"),
      [{ method: "thread/realtime/appendSpeech", params: { threadId: "thread", text: "words" } }],
    );
    assert.equal(fake.calls.filter((call) => call.method === "thread/realtime/stop").length, 1);
  }).pipe(Effect.scoped),
);

it.effect("accepts only a ChatGPT account", () =>
  Effect.sync(() => {
    assert.isTrue(isChatGptAccount({ type: "chatgpt" }));
    assert.isFalse(isChatGptAccount({ type: "apiKey" }));
    assert.isFalse(isChatGptAccount(null));
    assert.isFalse(isChatGptAccount(undefined));
  }),
);

it.effect("starts the voice's thread with no agent model and every MCP server off", () =>
  Effect.sync(() => {
    const start = voiceReaderThreadStart("/state/voice-reader", {
      whatsapp: { command: "wa" },
      "team.linear": { url: "https://linear" },
    });
    assert.equal(start.model, VOICE_READER_NO_AGENT_MODEL);
    assert.deepEqual(start.config, {
      mcp_servers: { whatsapp: { enabled: false }, "team.linear": { enabled: false } },
      features: { apps: false, plugins: false },
    });
    assert.deepEqual(voiceReaderThreadStart("/state/voice-reader", undefined).config, {
      mcp_servers: {},
      features: { apps: false, plugins: false },
    });
  }),
);

it.effect("wraps an unsupported realtime start and cleans up", () =>
  Effect.gen(function* () {
    const fake = yield* fakeRpc;
    fake.responses.set(
      "thread/realtime/start",
      Effect.fail(new BotsError({ message: "unsupported" })),
    );
    const host = yield* makeRealtimeHost(fake.rpc, "thread");
    const error = yield* host.startSession(input).pipe(Effect.flip);
    assert.equal(
      error.message,
      "This Codex can't start a realtime voice session: BotsError: unsupported",
    );
    assert.equal(fake.calls.filter((call) => call.method === "thread/realtime/stop").length, 1);
  }).pipe(Effect.scoped),
);

it.effect("bounds a stalled stop request at five seconds", () =>
  Effect.gen(function* () {
    const fake = yield* fakeRpc;
    fake.responses.set("thread/realtime/stop", Effect.never);
    const host = yield* makeRealtimeHost(fake.rpc, "thread");
    const pending = yield* host.startSession(input).pipe(Effect.forkChild);
    yield* Queue.take(fake.requests);
    yield* fake.emit("thread/realtime/sdp", { threadId: "thread", sdp: "answer" });
    const session = yield* Fiber.join(pending);
    const stopping = yield* session.stop.pipe(Effect.forkChild);
    yield* Queue.take(fake.requests);
    // Five for the stop request, then three waiting for a `closed` that never comes.
    yield* TestClock.adjust("8 seconds");
    yield* Fiber.join(stopping);
    yield* session.stop;
    assert.equal(fake.calls.filter((call) => call.method === "thread/realtime/stop").length, 1);
  }).pipe(Effect.scoped),
);

it.effect("keeps a late closed of a stopped session away from the next session", () =>
  Effect.gen(function* () {
    const fake = yield* fakeRpc;
    fake.responses.set("thread/realtime/stop", Effect.void);
    const host = yield* makeRealtimeHost(fake.rpc, "thread");
    const firstPending = yield* host.startSession(input).pipe(Effect.forkChild);
    yield* Queue.take(fake.requests);
    yield* fake.emit("thread/realtime/sdp", { threadId: "thread", sdp: "first" });
    const first = yield* Fiber.join(firstPending);
    const stopping = yield* first.stop.pipe(Effect.forkChild);
    yield* Queue.take(fake.requests);
    yield* TestClock.adjust("1 second");
    // Still routed to the first session: its `closed` has not arrived yet.
    assert.isUndefined(stopping.pollUnsafe());
    yield* fake.emit("thread/realtime/closed", { threadId: "thread", reason: "requested" });
    yield* Fiber.join(stopping);

    const secondPending = yield* host.startSession(input).pipe(Effect.forkChild);
    yield* Queue.take(fake.requests);
    yield* fake.emit("thread/realtime/sdp", { threadId: "thread", sdp: "second" });
    const second = yield* Fiber.join(secondPending);
    yield* fake.emit("thread/realtime/transcript/delta", {
      threadId: "thread",
      role: "assistant",
      delta: "olá",
    });
    yield* fake.emit("thread/realtime/closed", { threadId: "thread", reason: "requested" });
    const events = yield* Stream.runCollect(second.events);
    assert.equal(second.answerSdp, "second");
    assert.deepEqual(events, [
      { type: "transcript", delta: "olá" },
      { type: "closed", reason: "requested" },
    ]);
  }).pipe(Effect.scoped),
);
