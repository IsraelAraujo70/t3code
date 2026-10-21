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
        yield* Queue.offer(requests, method);
        return yield* responses.get(method) ?? Effect.void;
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

const input = { offerSdp: "offer", prompt: "Read this aloud" };

it.effect("starts WebRTC v3 with the prompt and returns the notified answer", () =>
  Effect.gen(function* () {
    const fake = yield* fakeRpc;
    const host = yield* makeRealtimeHost(fake.rpc, "thread");
    const pending = yield* host.startSession(input).pipe(Effect.forkChild);
    yield* Queue.take(fake.requests);
    yield* fake.emit("thread/realtime/sdp", { threadId: "thread", sdp: "answer" });
    const session = yield* Fiber.join(pending);
    assert.equal(session.answerSdp, "answer");
    assert.deepEqual(fake.calls[0], {
      method: "thread/realtime/start",
      params: {
        threadId: "thread",
        version: "v3",
        outputModality: "audio",
        includeStartupContext: false,
        clientManagedHandoffs: true,
        flushTranscriptTailOnSessionEnd: false,
        delegationAckFiller: false,
        prompt: input.prompt,
        transport: { type: "webrtc", sdp: "offer" },
      },
    });
  }).pipe(Effect.scoped),
);

it.effect("filters transcripts and other threads and includes closed before ending", () =>
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
    yield* TestClock.adjust("5 seconds");
    yield* Fiber.join(stopping);
    yield* session.stop;
    assert.equal(fake.calls.filter((call) => call.method === "thread/realtime/stop").length, 1);
  }).pipe(Effect.scoped),
);
