import { assert, describe, it } from "@effect/vitest";
import {
  BotsError,
  MessageId,
  RunId,
  ThreadId,
  VoiceReaderUtteranceId,
  type VoiceReaderState,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { BOT_COMPACTION_MESSAGE_PREFIX } from "../compaction/botCompaction.ts";
import * as CodexRealtime from "./CodexRealtime.ts";
import * as VoiceReader from "./VoiceReader.ts";

const threadId = ThreadId.make("voice-test");
const setup = Effect.fn("test.setup")(function* () {
  const replies = yield* Queue.unbounded<VoiceReader.VoiceReaderReply>();
  const events = yield* Queue.unbounded<CodexRealtime.RealtimeEvent>();
  const states = yield* Queue.unbounded<VoiceReaderState>();
  const texts: string[] = [];
  let stops = 0;
  const service = yield* VoiceReader.VoiceReader.pipe(
    Effect.provide(
      VoiceReader.layer.pipe(
        Layer.provide(
          Layer.succeed(VoiceReader.VoiceReaderReplies, {
            completed: () => Stream.fromQueue(replies),
          }),
        ),
        Layer.provide(
          Layer.succeed(CodexRealtime.CodexRealtime, {
            open: Effect.succeed({
              startSession: () =>
                Effect.gen(function* () {
                  const stop = Effect.sync(() => {
                    stops++;
                  });
                  yield* Effect.addFinalizer(() => stop);
                  return {
                    answerSdp: "answer",
                    events: Stream.fromQueue(events),
                    appendSpeech: (text: string) =>
                      Effect.sync(() => {
                        texts.push(text);
                      }),
                    stop,
                  };
                }),
            }),
          }),
        ),
      ),
    ),
  );
  const consumer = yield* Effect.forkScoped(
    Stream.runForEach(service.subscribe({ threadId }), (state) => Queue.offer(states, state)),
  );
  const until = Effect.fn("test.until")(function* (
    predicate: (state: VoiceReaderState) => boolean,
  ) {
    while (true) {
      const state = yield* Queue.take(states);
      if (predicate(state)) return state;
    }
  });
  const offered = Effect.fn("test.offered")(function* (text = "full reply") {
    yield* Queue.offer(replies, { runId: text, text });
    const state = yield* until((s) => s.current?.phase === "offer");
    assert(state.current !== null);
    return { utteranceId: state.current.id };
  });
  const speaking = Effect.fn("test.speaking")(function* (text = "full reply") {
    const ref = yield* offered(text);
    assert.deepStrictEqual(yield* service.offer({ ...ref, sdp: "offer" }), { sdp: "answer" });
    yield* until((s) => s.current?.phase === "connecting");
    yield* service.speak(ref);
    yield* until((s) => s.current?.phase === "speaking");
    return ref;
  });
  return {
    service,
    replies,
    events,
    states,
    texts,
    stops: () => stops,
    consumer,
    until,
    offered,
    speaking,
  };
});

describe("VoiceReader", () => {
  it.effect("emits initial state after open and propagates an open failure", () =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>();
      const started = yield* Deferred.make<void>();
      const states = yield* Queue.unbounded<VoiceReaderState>();
      const error = new BotsError({ message: "Login required" });
      const service = yield* VoiceReader.VoiceReader.pipe(
        Effect.provide(
          VoiceReader.layer.pipe(
            Layer.provide(
              Layer.succeed(VoiceReader.VoiceReaderReplies, { completed: () => Stream.empty }),
            ),
            Layer.provide(
              Layer.succeed(CodexRealtime.CodexRealtime, {
                open: Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Deferred.await(ready)),
                  Effect.andThen(Effect.fail(error)),
                ),
              }),
            ),
          ),
        ),
      );
      const fiber = yield* Effect.forkScoped(
        Stream.runForEach(service.subscribe({ threadId }), (s) => Queue.offer(states, s)).pipe(
          Effect.result,
        ),
      );
      yield* Deferred.await(started);
      assert.strictEqual(yield* Queue.size(states), 0);
      yield* Deferred.succeed(ready, undefined);
      const result = yield* Fiber.join(fiber);
      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") assert.strictEqual(result.failure, error);
      const live = yield* setup();
      assert.deepStrictEqual(yield* Queue.take(live.states), {
        current: null,
        queued: 0,
        lastError: null,
      });
    }),
  );

  it.effect("speaks the full reply, accumulates transcript and stops once", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const text = "complete text\n".repeat(1000);
      const ref = yield* h.speaking(text);
      assert.deepStrictEqual(h.texts, [VoiceReader.voiceReaderSpeech(text)]);
      yield* Queue.offer(h.events, { type: "transcript", delta: "Olá " });
      yield* Queue.offer(h.events, { type: "transcript", delta: "mundo" });
      yield* h.until((s) => s.current?.transcript === "Olá mundo");
      yield* h.service.stop(ref);
      yield* h.until((s) => s.current === null);
      assert.strictEqual(h.stops(), 1);
      yield* h.service.stop(ref);
      assert.strictEqual(h.stops(), 1);
    }),
  );

  it.effect("queues replies and advances with a fresh id", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const first = yield* h.speaking();
      yield* Queue.offer(h.replies, { runId: "second", text: "second" });
      yield* h.until((s) => s.queued === 1);
      yield* h.service.stop(first);
      const next = yield* h.until((s) => s.current?.phase === "offer");
      assert(next.current !== null);
      assert.notStrictEqual(next.current.id, first.utteranceId);
      assert.strictEqual(next.queued, 0);
    }),
  );

  it.effect("rejects stale offers and ignores stale stops", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const ref = yield* h.offered();
      const stale = { utteranceId: VoiceReaderUtteranceId.make("unknown") };
      assert.strictEqual(
        (yield* Effect.result(h.service.offer({ ...stale, sdp: "offer" })))._tag,
        "Failure",
      );
      yield* h.service.stop(stale);
      yield* h.service.offer({ ...ref, sdp: "offer" });
      yield* h.until((s) => s.current?.phase === "connecting");
      assert.strictEqual(
        (yield* Effect.result(h.service.offer({ ...ref, sdp: "offer" })))._tag,
        "Failure",
      );
    }),
  );

  it.effect("times out an unanswered offer and advances", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const first = yield* h.offered();
      yield* Queue.offer(h.replies, { runId: "next", text: "next" });
      yield* h.until((s) => s.queued === 1);
      yield* TestClock.adjust(VoiceReader.OFFER_TIMEOUT);
      const next = yield* h.until((s) => s.current !== null && s.current.id !== first.utteranceId);
      assert.strictEqual(next.lastError, "The client did not answer the voice reader in time.");
    }),
  );

  it.effect("times out connecting and bounds speech without stale offer timers stopping it", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const ref = yield* h.offered();
      yield* h.service.offer({ ...ref, sdp: "offer" });
      yield* h.until((s) => s.current?.phase === "connecting");
      yield* TestClock.adjust(VoiceReader.CONNECT_TIMEOUT);
      assert.strictEqual(
        (yield* h.until((s) => s.current === null)).lastError,
        "The voice connection did not come up.",
      );
      yield* h.speaking();
      yield* TestClock.adjust(VoiceReader.CONNECT_TIMEOUT);
      assert.strictEqual(h.stops(), 1);
      yield* TestClock.adjust(VoiceReader.MAX_UTTERANCE);
      assert.strictEqual((yield* h.until((s) => s.current === null)).lastError, null);
      assert.strictEqual(h.stops(), 2);
    }),
  );

  it.effect("finishes after transcript grace without a client stop", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      yield* h.speaking();
      yield* Queue.offer(h.events, { type: "transcript-done" });
      yield* TestClock.adjust(VoiceReader.SPEECH_END_GRACE);
      const end = yield* h.until((s) => s.current === null);
      assert.strictEqual(end.lastError, null);
      assert.strictEqual(h.stops(), 1);
    }),
  );

  it.effect("handles error and closed events and clears an error after successful speech", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      yield* h.speaking();
      yield* Queue.offer(h.events, { type: "error", message: "Voice failed" });
      assert.strictEqual((yield* h.until((s) => s.current === null)).lastError, "Voice failed");
      yield* h.speaking();
      yield* Queue.offer(h.events, { type: "closed", reason: null });
      assert.strictEqual((yield* h.until((s) => s.current === null)).lastError, null);
      assert.strictEqual(h.stops(), 2);
    }),
  );

  it.effect("stops the active session when the subscription is interrupted", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const ref = yield* h.speaking();
      yield* Fiber.interrupt(h.consumer);
      assert.strictEqual(h.stops(), 1);
      assert.strictEqual(
        (yield* Effect.result(h.service.offer({ ...ref, sdp: "offer" })))._tag,
        "Failure",
      );
    }),
  );

  it("selects the latest nonempty reply and excludes compaction and incomplete runs", () => {
    const run = {
      id: RunId.make("run"),
      status: "completed",
      userMessageId: MessageId.make("user"),
    } as const;
    const messages = [
      { text: "latest\nfull", createdAt: DateTime.makeUnsafe("2026-10-21T12:00:00Z") },
      { text: " ", createdAt: DateTime.makeUnsafe("2026-10-21T13:00:00Z") },
      { text: "old", createdAt: DateTime.makeUnsafe("2026-10-21T11:00:00Z") },
    ];
    assert.deepStrictEqual(VoiceReader.voiceReaderReplyOf(run, messages), {
      runId: run.id,
      text: "latest\nfull",
    });
    assert.strictEqual(
      VoiceReader.voiceReaderReplyOf({ ...run, status: "running" }, messages),
      null,
    );
    assert.strictEqual(
      VoiceReader.voiceReaderReplyOf(
        { ...run, userMessageId: MessageId.make(`${BOT_COMPACTION_MESSAGE_PREFIX}x`) },
        messages,
      ),
      null,
    );
    assert.strictEqual(VoiceReader.voiceReaderReplyOf(run, []), null);
  });
});
