import { assert, describe, it } from "@effect/vitest";
import {
  BotsError,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  VoiceSessionId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2StoredEvent,
  type ServerSettings as ServerSettingsValue,
  type VoiceSessionEvent,
  type VoiceSessionInput,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Duration from "effect/Duration";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { BOT_COMPACTION_MESSAGE_PREFIX } from "../compaction/botCompaction.ts";
import * as CodexRealtime from "./CodexRealtime.ts";
import * as VoiceSession from "./VoiceSession.ts";

const threadId = ThreadId.make("voice-test");
const messageId = MessageId.make("reply");
const read: VoiceSessionInput = { threadId, mode: { type: "read", messageId }, sdp: "offer" };
const conversation: VoiceSessionInput = { threadId, mode: { type: "conversation" }, sdp: "offer" };

const setup = Effect.fn("test.setup")(function* (
  env: Record<string, string> = {},
  reply = "full reply",
) {
  const realtimeEvents = yield* Queue.unbounded<CodexRealtime.RealtimeEvent>();
  const activity = yield* Queue.unbounded<VoiceSession.ThreadActivity, BotsError>();
  const spoken: string[] = [];
  const posted: string[] = [];
  const starts: Array<{ prompt: string; voice: string; delegationAckFiller: boolean }> = [];
  const lookups: Array<[ThreadId, MessageId]> = [];
  let subscriptions = 0;
  let opens = 0;
  let stops = 0;
  let postFailure: string | null = null;
  const delivered: string[] = [];
  let postGate: Deferred.Deferred<void> | null = null;
  // The test layer never reports changes; voice sessions follow them.
  const stored = yield* ServerSettings.ServerSettingsService.pipe(
    Effect.provide(ServerSettings.layerTest()),
  );
  const changes = yield* PubSub.unbounded<ServerSettingsValue>();
  const settings: ServerSettings.ServerSettingsService["Service"] = {
    ...stored,
    updateSettings: (patch) =>
      stored.updateSettings(patch).pipe(Effect.tap((next) => PubSub.publish(changes, next))),
    streamChanges: Stream.fromPubSub(changes),
  };
  const service = yield* VoiceSession.VoiceSessions.pipe(
    Effect.provide(
      VoiceSession.layer.pipe(
        Layer.provide(
          Layer.succeed(VoiceSession.VoiceThreads, {
            replyText: (thread, message) =>
              Effect.suspend(() => {
                lookups.push([thread, message]);
                return message === messageId
                  ? Effect.succeed(reply)
                  : Effect.fail(new BotsError({ message: "This message is not in that thread." }));
              }),
            post: (_thread, text) =>
              Effect.suspend(() => {
                posted.push(text);
                if (postFailure !== null)
                  return Effect.fail(new BotsError({ message: postFailure }));
                return (postGate === null ? Effect.void : Deferred.await(postGate)).pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      delivered.push(text);
                    }),
                  ),
                );
              }),
            activity: () =>
              Stream.suspend(() => {
                subscriptions++;
                return Stream.fromQueue(activity);
              }),
          }),
        ),
        Layer.provide(
          Layer.succeed(CodexRealtime.CodexRealtime, {
            open: Effect.sync(() => {
              opens++;
              return {
                startSession: (input: {
                  readonly prompt: string;
                  readonly voice: string;
                  readonly delegationAckFiller: boolean;
                }) =>
                  Effect.gen(function* () {
                    starts.push({
                      prompt: input.prompt,
                      voice: input.voice,
                      delegationAckFiller: input.delegationAckFiller,
                    });
                    const stop = Effect.sync(() => {
                      stops++;
                    });
                    yield* Effect.addFinalizer(() => stop);
                    return {
                      answerSdp: "answer",
                      events: Stream.fromQueue(realtimeEvents),
                      appendSpeech: (text: string) =>
                        Effect.sync(() => {
                          spoken.push(text);
                        }),
                      stop,
                    };
                  }),
              };
            }),
          }),
        ),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
        Layer.provide(Layer.succeed(ServerSettings.ServerSettingsService, settings)),
      ),
    ),
  );
  /** Opens a session and waits for its answer; `fiber` settles when the stream ends. */
  const open = Effect.fn("test.open")(function* (input: VoiceSessionInput) {
    const events = yield* Queue.unbounded<VoiceSessionEvent>();
    const fiber = yield* Effect.forkScoped(
      Stream.runForEach(service.session(input), (event) => Queue.offer(events, event)).pipe(
        Effect.exit,
      ),
    );
    const answer = yield* Queue.take(events);
    assert.strictEqual(answer.type, "answer");
    const sessionId = answer.type === "answer" ? answer.sessionId : VoiceSessionId.make("none");
    return { answer, events, ref: { sessionId }, fiber };
  });
  return {
    service,
    settings,
    realtimeEvents,
    activity,
    spoken,
    posted,
    starts,
    lookups,
    open,
    failPosts: (message: string) => {
      postFailure = message;
    },
    /** Posts after this wait for `gate`; `delivered` lists the posts that completed. */
    holdPosts: (gate: Deferred.Deferred<void>) => {
      postGate = gate;
    },
    delivered,
    subscriptions: () => subscriptions,
    opens: () => opens,
    stops: () => stops,
  };
});

const turnWindow = Duration.millis(VoiceSession.DEFAULT_TURN_SILENCE_MS);

const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const wordsOf = (text: string) => text.split(/\s+/u).filter((word) => word !== "");
/** About 5,800 bytes: eight paragraphs of twelve sentences. */
const longReply = Array.from({ length: 8 }, (_, paragraph) =>
  Array.from(
    { length: 12 },
    (_, sentence) =>
      `Frase ${paragraph}.${sentence} fala do assunto número ${paragraph} com calma.`,
  ).join(" "),
).join("\n\n");

/** The fake voice says each appended speech: it starts, then finishes its turn. */
const sayNext = Effect.fn("test.sayNext")(function* (
  realtimeEvents: Queue.Queue<CodexRealtime.RealtimeEvent>,
) {
  yield* Queue.offerAll(realtimeEvents, [
    { type: "transcript", delta: "Parte" },
    { type: "transcript-done", text: "Parte" },
  ]);
  yield* Effect.yieldNow;
});

describe("speechParts", () => {
  it("keeps every word of a long reply in parts no longer than the limit", () => {
    const parts = VoiceSession.speechParts(longReply);
    assert.isAbove(parts.length, 2);
    for (const part of parts) assert.isAtMost(bytes(part), VoiceSession.SPEECH_PART_BYTES);
    assert.deepStrictEqual(wordsOf(parts.join(" ")), wordsOf(longReply));
    assert.deepStrictEqual(VoiceSession.speechParts("Curta.\n\nOutra."), ["Curta.\n\nOutra."]);
  });

  it("splits a paragraph longer than the limit between sentences", () => {
    const paragraph = longReply.replaceAll("\n\n", " ");
    const parts = VoiceSession.speechParts(paragraph);
    assert.isAbove(parts.length, 2);
    for (const part of parts) assert.match(part, /\.$/u);
    assert.deepStrictEqual(wordsOf(parts.join(" ")), wordsOf(paragraph));
  });

  it("keeps a code block whole, shortening one longer than a part", () => {
    const code = "```ts\nconst ttl = 1;\n\nawait set(ttl);\n```";
    assert.deepStrictEqual(VoiceSession.speechParts(`Antes.\n\n${code}\n\nDepois.`), [
      `Antes.\n\n${code}\n\nDepois.`,
    ]);
    const [long] = VoiceSession.speechParts(`\`\`\`\n${"x = 1\n".repeat(1_000)}\`\`\``);
    assert.isAtMost(bytes(long!), VoiceSession.SPEECH_PART_BYTES);
    assert.match(long!, /^```[\s\S]*```$/u);
  });

  it("never appends more than Codex speaks whole, even retried", () => {
    // Multibyte text, one unbroken word, and a paragraph without sentence ends.
    const reply = `${"ação ".repeat(4_000)}\n\n${"x".repeat(9_000)}\n\n${"palavra ".repeat(2_000)}`;
    for (const speech of [
      ...VoiceSession.voiceReaderSpeeches(reply),
      ...VoiceSession.voiceReplySpeeches(reply),
    ])
      assert.isAtMost(bytes(VoiceSession.retrySpeech(speech)), VoiceSession.CODEX_SPEECH_MAX_BYTES);
  });
});

const failureMessage = (exit: Exit.Exit<void, BotsError>) =>
  Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Fail"
    ? exit.cause.reasons[0].error.message
    : null;

describe("VoiceSessions read", () => {
  it.effect("speaks the requested message once ready and ends after the transcript grace", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const { answer, ref, fiber } = yield* h.open(read);
      assert.strictEqual(answer.type === "answer" && answer.sdp, "answer");
      assert.deepStrictEqual(h.lookups, [[threadId, messageId]]);
      assert.deepStrictEqual(h.spoken, []);
      yield* h.service.ready(ref);
      assert.deepStrictEqual(h.spoken, [VoiceSession.voiceReaderSpeeches("full reply")[0]!]);
      assert.deepStrictEqual(h.starts, [
        { prompt: VoiceSession.VOICE_READER_PROMPT, voice: "cove", delegationAckFiller: false },
      ]);
      assert.strictEqual(h.subscriptions(), 0);
      yield* Queue.offerAll(h.realtimeEvents, [
        { type: "transcript", delta: "Resumo" },
        { type: "transcript-done", text: "Resumo" },
      ]);
      yield* TestClock.adjust(VoiceSession.SPEECH_END_GRACE);
      assert.isTrue(Exit.isSuccess(yield* Fiber.join(fiber)));
      assert.strictEqual(h.stops(), 1);
    }),
  );

  it.effect("reads a long reply whole, part by part, and ends only after the last part", () =>
    Effect.gen(function* () {
      const h = yield* setup({}, longReply);
      const speeches = VoiceSession.voiceReaderSpeeches(longReply);
      assert.isAbove(speeches.length, 2);
      const { ref, events, fiber } = yield* h.open(read);
      yield* h.service.ready(ref);
      assert.deepStrictEqual(h.spoken, speeches.slice(0, 1));
      assert.deepStrictEqual(yield* Queue.take(events), { type: "bot", working: true });
      for (let next = 1; next < speeches.length; next++) {
        yield* sayNext(h.realtimeEvents);
        assert.deepStrictEqual(h.spoken, speeches.slice(0, next + 1));
      }
      // The last part started: nothing is left, which the client waits for to finish.
      yield* Queue.offer(h.realtimeEvents, { type: "transcript", delta: "Última" });
      assert.deepStrictEqual(yield* Queue.take(events), { type: "bot", working: false });
      // A part's end with more to say does not start the grace.
      yield* TestClock.adjust(VoiceSession.SPEECH_END_GRACE);
      assert.isUndefined(fiber.pollUnsafe());
      yield* Queue.offer(h.realtimeEvents, { type: "transcript-done", text: "Última" });
      yield* TestClock.adjust(VoiceSession.SPEECH_END_GRACE);
      assert.isTrue(Exit.isSuccess(yield* Fiber.join(fiber)));
    }),
  );

  it.effect("fails a read the voice never starts saying", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const { ref, fiber } = yield* h.open(read);
      yield* h.service.ready(ref);
      yield* TestClock.adjust(VoiceSession.SPEECH_START_TIMEOUT);
      assert.deepStrictEqual(h.spoken, [
        VoiceSession.voiceReaderSpeeches("full reply")[0]!,
        VoiceSession.retrySpeech(VoiceSession.voiceReaderSpeeches("full reply")[0]!),
      ]);
      yield* TestClock.adjust(VoiceSession.SPEECH_START_TIMEOUT);
      assert.strictEqual(
        failureMessage(yield* Fiber.join(fiber)),
        "The voice did not start reading.",
      );
      const spoken = yield* h.open(read);
      yield* h.service.ready(spoken.ref);
      yield* Queue.offer(h.realtimeEvents, { type: "transcript", delta: "A" });
      yield* TestClock.adjust(VoiceSession.SPEECH_START_TIMEOUT);
      yield* TestClock.adjust(VoiceSession.SPEECH_START_TIMEOUT);
      assert.isUndefined(spoken.fiber.pollUnsafe());
    }),
  );

  it.effect("starts realtime with the configured voice, else the default", () =>
    Effect.gen(function* () {
      for (const [env, expected] of [
        [{}, VoiceSession.DEFAULT_VOICE],
        [{ [VoiceSession.VOICE_ENV]: " Arbor " }, "arbor"],
        [{ [VoiceSession.VOICE_ENV]: "  " }, VoiceSession.DEFAULT_VOICE],
      ] as const) {
        const h = yield* setup(env);
        yield* h.open(read);
        assert.deepStrictEqual(
          h.starts.map((start) => start.voice),
          [expected],
        );
      }
    }),
  );

  it.effect("starts each session with the voice setting, which wins over the env voice", () =>
    Effect.gen(function* () {
      const h = yield* setup({ [VoiceSession.VOICE_ENV]: "arbor" });
      const voiceAfter = (voiceReaderVoice: "sol" | null) =>
        h.settings
          .updateSettings({ voiceReaderVoice })
          .pipe(Effect.andThen(h.open(read)), Effect.scoped);
      yield* h.open(read).pipe(Effect.scoped);
      yield* voiceAfter("sol");
      yield* voiceAfter(null);
      assert.deepStrictEqual(
        h.starts.map((start) => start.voice),
        ["arbor", "sol", "arbor"],
      );
    }),
  );

  it.effect("fails before starting Codex when the message lookup refuses", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const exit = yield* Stream.runDrain(
        h.service.session({ ...read, mode: { type: "read", messageId: MessageId.make("user") } }),
      ).pipe(Effect.exit);
      assert.strictEqual(failureMessage(exit), "This message is not in that thread.");
      assert.strictEqual(h.opens(), 0);
    }),
  );

  it.effect("becomes ready once and refuses unknown sessions", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const { ref } = yield* h.open(read);
      yield* h.service.ready(ref);
      assert.strictEqual((yield* Effect.result(h.service.ready(ref)))._tag, "Failure");
      const unknown = { sessionId: VoiceSessionId.make("unknown") };
      assert.strictEqual((yield* Effect.result(h.service.ready(unknown)))._tag, "Failure");
      assert.strictEqual(h.spoken.length, 1);
    }),
  );

  it.effect("fails a peer that never connects and bounds a read that never ends", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const first = yield* h.open(read);
      yield* TestClock.adjust(VoiceSession.CONNECT_TIMEOUT);
      assert.strictEqual(
        failureMessage(yield* Fiber.join(first.fiber)),
        "The voice connection did not come up.",
      );
      assert.strictEqual((yield* Effect.result(h.service.ready(first.ref)))._tag, "Failure");
      const second = yield* h.open(read);
      yield* h.service.ready(second.ref);
      yield* Queue.offer(h.realtimeEvents, { type: "transcript", delta: "Resumo" });
      yield* TestClock.adjust(VoiceSession.CONNECT_TIMEOUT);
      assert.isUndefined(second.fiber.pollUnsafe());
      yield* TestClock.adjust(VoiceSession.MAX_READ);
      assert.isTrue(Exit.isSuccess(yield* Fiber.join(second.fiber)));
      assert.strictEqual(h.stops(), 2);
    }),
  );

  it.effect(
    "fails on a realtime error, completes when realtime closes, and closes on hang-up",
    () =>
      Effect.gen(function* () {
        const h = yield* setup();
        const first = yield* h.open(read);
        yield* Queue.offer(h.realtimeEvents, { type: "error", message: "Voice failed" });
        assert.strictEqual(failureMessage(yield* Fiber.join(first.fiber)), "Voice failed");
        const second = yield* h.open(conversation);
        yield* h.service.ready(second.ref);
        yield* Queue.offer(h.realtimeEvents, { type: "closed", reason: null });
        assert.isTrue(Exit.isSuccess(yield* Fiber.join(second.fiber)));
        const third = yield* h.open(conversation);
        yield* h.service.ready(third.ref);
        yield* Fiber.interrupt(third.fiber);
        assert.strictEqual(h.stops(), 3);
        assert.strictEqual((yield* Effect.result(h.service.ready(third.ref)))._tag, "Failure");
      }),
  );
});

describe("VoiceSessions conversation", () => {
  it.effect("relays what the user says, reports the agent's work and speaks its replies", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const { ref, events } = yield* h.open(conversation);
      assert.deepStrictEqual(h.starts, [
        {
          prompt: VoiceSession.VOICE_CONVERSATION_PROMPT,
          voice: "cove",
          delegationAckFiller: true,
        },
      ]);
      // Nothing is followed or relayed before the peer is live.
      assert.strictEqual(h.subscriptions(), 0);
      yield* h.service.ready(ref);
      yield* Effect.yieldNow;
      assert.strictEqual(h.subscriptions(), 1);
      yield* Queue.offerAll(h.activity, [
        { type: "working", working: false },
        { type: "working", working: false },
      ]);
      yield* Queue.offer(h.realtimeEvents, { type: "user-transcript", text: "Quanto é 7 x 8?" });
      yield* TestClock.adjust(turnWindow);
      assert.deepStrictEqual(h.posted, ["🎙️ Quanto é 7 x 8?"]);
      yield* Queue.offerAll(h.activity, [
        { type: "working", working: true },
        { type: "reply", text: "56." },
        { type: "working", working: false },
        { type: "waiting-on-user" },
      ]);
      yield* Effect.yieldNow;
      // The notice waits until the voice has finished speaking the reply.
      assert.deepStrictEqual(h.spoken, [VoiceSession.voiceReplySpeeches("56.")[0]!]);
      yield* Queue.offerAll(h.realtimeEvents, [
        { type: "transcript", delta: "Cinquenta" },
        { type: "transcript-done", text: "Cinquenta" },
      ]);
      yield* Effect.yieldNow;
      assert.deepStrictEqual(h.spoken, [
        VoiceSession.voiceReplySpeeches("56.")[0]!,
        VoiceSession.WAITING_ON_USER_SPEECH,
      ]);
      // The agent's work lasts until the voice starts speaking the last of it.
      yield* Queue.offer(h.realtimeEvents, { type: "transcript", delta: "Preciso" });
      assert.deepStrictEqual(
        yield* Effect.all([Queue.take(events), Queue.take(events), Queue.take(events)]),
        [
          { type: "bot", working: false },
          { type: "bot", working: true },
          { type: "bot", working: false },
        ],
      );
      assert.strictEqual(yield* Queue.size(events), 0);
    }),
  );

  it.effect("speaks a long reply whole, one part after another", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const speeches = VoiceSession.voiceReplySpeeches(longReply);
      assert.isAbove(speeches.length, 2);
      const { ref } = yield* h.open(conversation);
      yield* h.service.ready(ref);
      yield* Effect.yieldNow;
      yield* Queue.offerAll(h.activity, [
        { type: "working", working: true },
        { type: "reply", text: longReply },
        { type: "working", working: false },
        { type: "waiting-on-user" },
      ]);
      yield* Effect.yieldNow;
      assert.deepStrictEqual(h.spoken, speeches.slice(0, 1));
      for (let next = 1; next < speeches.length; next++) yield* sayNext(h.realtimeEvents);
      yield* sayNext(h.realtimeEvents);
      assert.deepStrictEqual(h.spoken, [...speeches, VoiceSession.WAITING_ON_USER_SPEECH]);
    }),
  );

  it.effect("stops waiting on a reply the voice never starts saying", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const { ref, events } = yield* h.open(conversation);
      yield* h.service.ready(ref);
      yield* Effect.yieldNow;
      yield* Queue.offerAll(h.activity, [
        { type: "working", working: true },
        { type: "reply", text: "56." },
        { type: "working", working: false },
      ]);
      assert.deepStrictEqual(yield* Queue.take(events), { type: "bot", working: true });
      yield* TestClock.adjust(VoiceSession.SPEECH_START_TIMEOUT);
      yield* TestClock.adjust(VoiceSession.SPEECH_START_TIMEOUT);
      assert.deepStrictEqual(yield* Queue.take(events), { type: "bot", working: false });
      assert.deepStrictEqual(h.spoken, [
        VoiceSession.voiceReplySpeeches("56.")[0]!,
        VoiceSession.retrySpeech(VoiceSession.voiceReplySpeeches("56.")[0]!),
      ]);
    }),
  );

  it.effect("ends with the error when an utterance cannot be posted", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      h.failPosts("Couldn't send what you said.");
      const { ref, fiber } = yield* h.open(conversation);
      yield* h.service.ready(ref);
      yield* Queue.offer(h.realtimeEvents, { type: "user-transcript", text: "Oi" });
      yield* TestClock.adjust(turnWindow);
      assert.strictEqual(failureMessage(yield* Fiber.join(fiber)), "Couldn't send what you said.");
      assert.strictEqual(h.stops(), 1);
    }),
  );
});

describe("VoiceSessions voice change", () => {
  const live = Effect.fn("test.liveVoiceChange")(function* (liveVoiceChange: boolean) {
    const h = yield* setup();
    const session = yield* h.open({ ...conversation, liveVoiceChange });
    yield* h.service.ready(session.ref);
    yield* Effect.yieldNow;
    return { ...h, ...session };
  });

  it.effect(
    "swaps an open conversation's realtime session, and its next reply uses the new voice",
    () =>
      Effect.gen(function* () {
        const h = yield* live(true);
        yield* h.settings.updateSettings({ voiceReaderVoice: "sol" });
        assert.deepStrictEqual(yield* Queue.take(h.events), { type: "voice-changed" });
        // Another settings change before the client reconnects asks only once.
        yield* h.settings.updateSettings({ voiceReaderVoice: "sol" });

        assert.deepStrictEqual(
          yield* h.service.reconnect({ sessionId: h.ref.sessionId, sdp: "second offer" }),
          { sdp: "answer" },
        );
        assert.deepStrictEqual(
          h.starts.map((start) => [
            start.voice,
            start.prompt === VoiceSession.VOICE_CONVERSATION_PROMPT,
          ]),
          [
            ["cove", true],
            ["sol", true],
          ],
        );
        assert.strictEqual(h.stops(), 1);

        // A reply that completes while the new peer connects waits for it, then is spoken once.
        yield* Queue.offerAll(h.activity, [
          { type: "working", working: true },
          { type: "reply", text: "56." },
          { type: "working", working: false },
        ]);
        yield* Effect.yieldNow;
        assert.deepStrictEqual(h.spoken, []);
        yield* h.service.ready(h.ref);
        assert.deepStrictEqual(h.spoken, [VoiceSession.voiceReplySpeeches("56.")[0]!]);
        assert.strictEqual(
          (yield* h.service.ready(h.ref).pipe(Effect.flip)).message,
          "This voice session is already live.",
        );

        // What the user says to the new session still reaches the thread.
        yield* Queue.offer(h.realtimeEvents, { type: "user-transcript", text: "Valeu" });
        yield* TestClock.adjust(turnWindow);
        assert.deepStrictEqual(h.posted, ["🎙️ Valeu"]);
        assert.isUndefined(h.fiber.pollUnsafe());
        // Idle at the swap, working on the reply until the (silent) fake voice gives it up, then
        // relaying the user's turn.
        assert.deepStrictEqual(yield* Queue.takeAll(h.events), [
          { type: "bot", working: false },
          { type: "bot", working: true },
          { type: "bot", working: false },
          { type: "bot", working: true },
        ]);
      }),
  );

  it.effect("ends a conversation whose new peer never connects", () =>
    Effect.gen(function* () {
      const h = yield* live(true);
      yield* h.service.reconnect({ sessionId: h.ref.sessionId, sdp: "second offer" });
      yield* TestClock.adjust(VoiceSession.CONNECT_TIMEOUT);
      assert.strictEqual(
        failureMessage(yield* Fiber.join(h.fiber)),
        "The voice did not come back after changing.",
      );
    }),
  );

  it.effect("leaves a client that did not ask for it, and reads, on their voice", () =>
    Effect.gen(function* () {
      const h = yield* live(false);
      yield* h.settings.updateSettings({ voiceReaderVoice: "sol" });
      yield* Effect.yieldNow;
      assert.strictEqual(yield* Queue.size(h.events), 0);
      assert.strictEqual(
        (yield* h.service
          .reconnect({ sessionId: h.ref.sessionId, sdp: "second offer" })
          .pipe(Effect.flip)).message,
        "This voice session cannot change its voice.",
      );
      const reading = yield* h.open({ ...read, liveVoiceChange: true });
      yield* h.settings.updateSettings({ voiceReaderVoice: "maple" });
      yield* Effect.yieldNow;
      assert.strictEqual(yield* Queue.size(reading.events), 0);
    }),
  );
});

describe("VoiceSessions conversation turns", () => {
  /** Realtime's deltas for `text` as it is spoken, word by word. */
  const deltas = (text: string): CodexRealtime.RealtimeEvent[] =>
    text.split(" ").map((word) => ({ type: "user-transcript-delta", delta: ` ${word}` }));

  const live = Effect.fn("test.live")(function* (env: Record<string, string> = {}) {
    const h = yield* setup(env);
    const session = yield* h.open(conversation);
    yield* h.service.ready(session.ref);
    yield* Effect.yieldNow;
    const offer = (events: ReadonlyArray<CodexRealtime.RealtimeEvent>) =>
      Queue.offerAll(h.realtimeEvents, events).pipe(Effect.andThen(Effect.yieldNow));
    /** One utterance: its deltas, then its final transcript. */
    const say = (text: string) => offer([...deltas(text), { type: "user-transcript", text }]);
    return { ...h, ...session, offer, say };
  });

  it.effect("posts a thought spoken in pieces as one message once the user stays silent", () =>
    Effect.gen(function* () {
      const h = yield* live();
      yield* h.say("Quanto é");
      yield* TestClock.adjust(Duration.seconds(2));
      yield* h.say("sete vezes");
      yield* TestClock.adjust(Duration.seconds(2));
      yield* h.say("oito?");
      yield* TestClock.adjust(Duration.millis(VoiceSession.DEFAULT_TURN_SILENCE_MS - 1));
      assert.deepStrictEqual(h.posted, []);
      yield* TestClock.adjust(Duration.millis(1));
      assert.deepStrictEqual(h.posted, ["🎙️ Quanto é sete vezes oito?"]);
      yield* TestClock.adjust(turnWindow);
      assert.deepStrictEqual(h.posted, ["🎙️ Quanto é sete vezes oito?"]);
    }),
  );

  it.effect("posts pieces further apart than the window as separate messages", () =>
    Effect.gen(function* () {
      const h = yield* live();
      yield* h.say("Primeira.");
      yield* TestClock.adjust(turnWindow);
      yield* TestClock.adjust(Duration.seconds(5));
      yield* h.say("Segunda.");
      yield* TestClock.adjust(turnWindow);
      assert.deepStrictEqual(h.posted, ["🎙️ Primeira.", "🎙️ Segunda."]);
    }),
  );

  it.effect("waits while the user keeps speaking", () =>
    Effect.gen(function* () {
      const h = yield* live();
      for (const word of ["Me", "diz", "o", "placar."]) {
        yield* TestClock.adjust(Duration.millis(VoiceSession.DEFAULT_TURN_SILENCE_MS - 1));
        yield* h.offer(deltas(word));
      }
      assert.deepStrictEqual(h.posted, []);
      yield* TestClock.adjust(turnWindow);
      assert.deepStrictEqual(h.posted, ["🎙️ Me diz o placar."]);
    }),
  );

  it.effect("posts an utterance whose final transcript is late, and only once", () =>
    Effect.gen(function* () {
      const h = yield* live();
      yield* h.say("Quanto é sete vezes oito,");
      yield* TestClock.adjust(Duration.seconds(2));
      yield* h.offer(deltas("mais dois?"));
      yield* TestClock.adjust(turnWindow);
      assert.deepStrictEqual(h.posted, ["🎙️ Quanto é sete vezes oito, mais dois?"]);
      yield* h.offer([{ type: "user-transcript", text: "mais dois?" }]);
      yield* TestClock.adjust(turnWindow);
      assert.deepStrictEqual(h.posted, ["🎙️ Quanto é sete vezes oito, mais dois?"]);
    }),
  );

  it.effect("finishes posting a turn when the user speaks again meanwhile", () =>
    Effect.gen(function* () {
      const h = yield* live();
      const gate = yield* Deferred.make<void>();
      h.holdPosts(gate);
      yield* h.say("Oi");
      yield* TestClock.adjust(turnWindow);
      assert.deepStrictEqual(h.posted, ["🎙️ Oi"]);
      yield* h.offer(deltas("de novo"));
      // Let the session hear the speech while the post is still in flight.
      for (let i = 0; i < 10; i++) yield* Effect.yieldNow;
      yield* Deferred.succeed(gate, undefined);
      for (let i = 0; i < 10; i++) yield* Effect.yieldNow;
      assert.deepStrictEqual(h.delivered, ["🎙️ Oi"]);
    }),
  );

  it.effect("posts what the user said when the call ends before the window passes", () =>
    Effect.gen(function* () {
      const hungUp = yield* live();
      yield* hungUp.say("Antes de");
      yield* hungUp.offer(deltas("desligar"));
      yield* Fiber.interrupt(hungUp.fiber);
      assert.deepStrictEqual(hungUp.posted, ["🎙️ Antes de desligar"]);
      yield* TestClock.adjust(turnWindow);
      assert.deepStrictEqual(hungUp.posted, ["🎙️ Antes de desligar"]);

      const dropped = yield* live();
      yield* dropped.say("Caiu");
      yield* dropped.offer([{ type: "closed", reason: null }]);
      assert.isTrue(Exit.isSuccess(yield* Fiber.join(dropped.fiber)));
      assert.deepStrictEqual(dropped.posted, ["🎙️ Caiu"]);
    }),
  );

  it.effect("reads the window from the environment, else the default", () =>
    Effect.gen(function* () {
      for (const [value, ms] of [
        ["3000", 3_000],
        ["soon", VoiceSession.DEFAULT_TURN_SILENCE_MS],
        ["0", VoiceSession.DEFAULT_TURN_SILENCE_MS],
      ] as const) {
        const h = yield* live({ [VoiceSession.TURN_SILENCE_ENV]: value });
        yield* h.say(value);
        yield* TestClock.adjust(Duration.millis(ms - 1));
        assert.deepStrictEqual(h.posted, []);
        yield* TestClock.adjust(Duration.millis(1));
        assert.deepStrictEqual(h.posted, [`🎙️ ${value}`]);
      }
    }),
  );
});

describe("handoffReducer", () => {
  it("holds speech while the realtime session is replaced, and speaks what never started", () => {
    const appended = VoiceSession.handoffReducer(VoiceSession.idleHandoff, {
      type: "speak",
      speech: "first",
    });
    assert.strictEqual(appended.append?.speech, "first");
    const paused = VoiceSession.handoffReducer(appended.state, { type: "pause" });
    const queued = VoiceSession.handoffReducer(paused.state, { type: "speak", speech: "second" });
    assert.isNull(queued.append);
    assert.isTrue(VoiceSession.handoffWorking(queued.state));
    const resumed = VoiceSession.handoffReducer(queued.state, { type: "resume" });
    assert.strictEqual(resumed.append?.speech, "first");
    assert.deepStrictEqual(resumed.state.queued, ["second"]);
  });

  const run = (...inputs: ReadonlyArray<VoiceSession.HandoffInput>) =>
    inputs.reduce<{ state: VoiceSession.Handoff; appended: string[]; lost: string[] }>(
      (acc, input) => {
        const step = VoiceSession.handoffReducer(acc.state, input);
        return {
          state: step.state,
          appended: step.append ? [...acc.appended, step.append.speech] : acc.appended,
          lost: step.lost ? [...acc.lost, step.lost] : acc.lost,
        };
      },
      { state: VoiceSession.idleHandoff, appended: [], lost: [] },
    );

  it("keeps the agent working from its reply until the voice starts saying it", () => {
    const handed = run(
      { type: "running", running: true },
      { type: "speak", speech: "reply" },
      { type: "running", running: false },
    );
    assert.deepStrictEqual(handed.appended, ["reply"]);
    assert.isTrue(VoiceSession.handoffWorking(handed.state));
    const spoken = VoiceSession.handoffReducer(handed.state, { type: "voice-talking" });
    assert.isFalse(VoiceSession.handoffWorking(spoken.state));
  });

  it("holds a reply that arrives mid-turn until the voice is quiet", () => {
    // The voice starts answering by itself; the reply must not be folded into that turn.
    const midTurn = run({ type: "voice-talking" }, { type: "speak", speech: "reply" });
    assert.deepStrictEqual(midTurn.appended, []);
    assert.isTrue(VoiceSession.handoffWorking(midTurn.state));
    const after = run(
      { type: "voice-talking" },
      { type: "speak", speech: "reply" },
      { type: "speak", speech: "notice" },
      { type: "voice-done" },
    );
    assert.deepStrictEqual(after.appended, ["reply"]);
    const next = run(
      { type: "voice-talking" },
      { type: "speak", speech: "reply" },
      { type: "speak", speech: "notice" },
      { type: "voice-done" },
      { type: "voice-talking" },
      { type: "voice-done" },
    );
    assert.deepStrictEqual(next.appended, ["reply", "notice"]);
  });

  it("holds what the user says until the latest silence window passes, in order", () => {
    let state = VoiceSession.idleHandoff;
    const windows: number[] = [];
    for (const input of [
      { type: "user-delta", delta: " Quanto" },
      { type: "user-delta", delta: " é" },
      { type: "user-said", text: "Quanto é" },
      // An utterance realtime reports only once it ends.
      { type: "user-said", text: "sete vezes oito?" },
    ] as const) {
      const step = VoiceSession.handoffReducer(state, input);
      assert.isNull(step.post);
      if (step.listen !== null) windows.push(step.listen);
      state = step.state;
    }
    // The first utterance's final transcript is not new speech.
    assert.strictEqual(windows.length, 3);
    // A window that later speech restarted passes without posting.
    const stale = VoiceSession.handoffReducer(state, { type: "silence", silence: windows[1]! });
    assert.isNull(stale.post);
    const ended = VoiceSession.handoffReducer(state, { type: "silence", silence: windows[2]! });
    assert.strictEqual(ended.post, "Quanto é sete vezes oito?");
    assert.isNull(VoiceSession.handoffReducer(ended.state, { type: "hang-up" }).post);
    assert.isFalse(VoiceSession.handoffWorking(state));
  });

  it("posts what was heard when the call ends", () => {
    const heard = VoiceSession.handoffReducer(VoiceSession.idleHandoff, {
      type: "user-delta",
      delta: " Oi",
    });
    assert.strictEqual(VoiceSession.handoffReducer(heard.state, { type: "hang-up" }).post, "Oi");
    assert.isNull(VoiceSession.handoffReducer(VoiceSession.idleHandoff, { type: "hang-up" }).post);
  });

  it("appends unspoken text once more, then gives it up; stale timeouts change nothing", () => {
    const first = VoiceSession.handoffReducer(VoiceSession.idleHandoff, {
      type: "speak",
      speech: "reply",
    });
    const retry = VoiceSession.handoffReducer(first.state, {
      type: "start-timeout",
      attempt: first.append!.attempt,
    });
    assert.deepStrictEqual(retry.append?.speech, "reply");
    const stale = VoiceSession.handoffReducer(retry.state, {
      type: "start-timeout",
      attempt: first.append!.attempt,
    });
    assert.strictEqual(stale.state, retry.state);
    const lost = VoiceSession.handoffReducer(retry.state, {
      type: "start-timeout",
      attempt: retry.append!.attempt,
    });
    assert.strictEqual(lost.lost, "reply");
    assert.isNull(lost.append);
    assert.isFalse(VoiceSession.handoffWorking(lost.state));
  });
});

describe("VoiceThreads", () => {
  const otherThreadId = ThreadId.make("voice-other");
  const runId = RunId.make("run-1");

  const fixtures = (now: DateTime.Utc) => {
    const thread = (id: ThreadId): OrchestrationV2DomainEvent => ({
      id: EventId.make(`created:${id}`),
      threadId: id,
      occurredAt: now,
      type: "thread.created",
      payload: {
        id,
        projectId: ProjectId.make("project:voice"),
        title: "Voice",
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6" },
        createdBy: "user",
        creationSource: "web",
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: "/workspace",
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    });
    const message = (
      thread: ThreadId,
      id: string,
      role: "user" | "assistant",
      text: string,
      run: RunId | null = null,
    ): OrchestrationV2DomainEvent => ({
      id: EventId.make(`message:${id}`),
      threadId: thread,
      occurredAt: now,
      type: "message.updated",
      payload: {
        id: MessageId.make(id),
        threadId: thread,
        runId: run,
        nodeId: null,
        role,
        text,
        attachments: [],
        streaming: false,
        createdBy: role === "user" ? "user" : "agent",
        creationSource: "web",
        createdAt: now,
        updatedAt: now,
      },
    });
    const run = (
      id: RunId,
      status: "running" | "completed",
      userMessageId: string,
      ordinal = 1,
    ): OrchestrationV2DomainEvent => ({
      id: EventId.make(`run:${id}:${status}`),
      threadId,
      occurredAt: now,
      type: "run.updated",
      payload: {
        id,
        threadId,
        ordinal,
        providerInstanceId: ProviderInstanceId.make("codex"),
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6" },
        providerThreadId: null,
        userMessageId: MessageId.make(userMessageId),
        rootNodeId: null,
        activeAttemptId: null,
        status,
        requestedAt: now,
        startedAt: now,
        completedAt: status === "completed" ? now : null,
        checkpointId: null,
        contextHandoffId: null,
      },
    });
    return { thread, message, run };
  };

  /** VoiceThreads over a real projection and a fake orchestrator whose live tail we feed. */
  const threadsHarness = Effect.fn("test.threadsHarness")(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const tail = yield* Queue.unbounded<OrchestrationV2StoredEvent>();
    const posted: unknown[] = [];
    let sequence = 0;
    const threads = yield* VoiceSession.VoiceThreads.pipe(
      Effect.provide(
        VoiceSession.layerThreads.pipe(
          Layer.provide(
            Layer.mock(Orchestrator.OrchestratorV2)({
              dispatch: (command) =>
                Effect.sync(() => {
                  posted.push(command);
                  return { sequence: 0 };
                }) as never,
              getThreadEventSequence: () => Effect.succeed(sequence),
              streamStoredEventsFrom: () => Stream.fromQueue(tail),
            }),
          ),
          Layer.provide(Layer.succeed(ProjectionStore.ProjectionStoreV2, store)),
        ),
      ),
    );
    /** Commits an event to the projection, then delivers it on the live tail. */
    const commit = (event: OrchestrationV2DomainEvent) =>
      store
        .apply(event)
        .pipe(Effect.andThen(Queue.offer(tail, { sequence: ++sequence, commandId: null, event })));
    return { threads, store, commit, posted };
  });

  const layerTest = Layer.mergeAll(ProjectionStore.layer).pipe(
    Layer.provideMerge(SqlitePersistence.layerMemory),
  );

  it.effect("returns only an assistant message of the requested thread", () =>
    Effect.gen(function* () {
      const h = yield* threadsHarness();
      const f = fixtures(yield* DateTime.now);
      yield* Effect.forEach(
        [
          f.thread(threadId),
          f.thread(otherThreadId),
          f.message(threadId, "question", "user", "What changed?"),
          f.message(threadId, "answer", "assistant", "The fix landed."),
          f.message(threadId, "blank", "assistant", "  "),
          f.message(otherThreadId, "elsewhere", "assistant", "Another thread's reply."),
        ],
        (event) => h.store.apply(event),
        { discard: true },
      );
      const refused = (thread: ThreadId, id: string) =>
        h.threads.replyText(thread, MessageId.make(id)).pipe(
          Effect.flip,
          Effect.map((error) => error.message),
        );
      assert.strictEqual(
        yield* h.threads.replyText(threadId, MessageId.make("answer")),
        "The fix landed.",
      );
      assert.strictEqual(
        yield* refused(threadId, "elsewhere"),
        "This message is not in that thread.",
      );
      assert.strictEqual(
        yield* refused(threadId, "question"),
        "Only agent replies can be read aloud.",
      );
      assert.strictEqual(yield* refused(threadId, "blank"), "This reply has no text to read.");
      assert.strictEqual(
        yield* refused(ThreadId.make("voice-missing"), "answer"),
        "This message is not in that thread.",
      );
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("follows the agent's work and each completed reply exactly once", () =>
    Effect.gen(function* () {
      const h = yield* threadsHarness();
      const f = fixtures(yield* DateTime.now);
      yield* h.store.apply(f.thread(threadId));
      yield* h.store.apply(f.run(runId, "running", "question"));
      const seen = yield* Queue.unbounded<VoiceSession.ThreadActivity>();
      yield* Effect.forkScoped(
        Stream.runForEach(h.threads.activity(threadId), (activity) => Queue.offer(seen, activity)),
      );
      assert.deepStrictEqual(yield* Queue.take(seen), { type: "working", working: true });
      yield* h.commit(f.message(threadId, "commentary", "assistant", "Looking…", runId));
      yield* h.commit(f.message(threadId, "final", "assistant", "It's 56.", runId));
      yield* h.commit(f.run(runId, "completed", "question"));
      // The same completion again (a replay) is not spoken twice.
      yield* h.commit(f.run(runId, "completed", "question"));
      const compaction = RunId.make("run-compaction");
      yield* h.commit(f.message(threadId, "summary", "assistant", "Saved.", compaction));
      yield* h.commit(f.run(compaction, "completed", `${BOT_COMPACTION_MESSAGE_PREFIX}x`, 2));
      const after: VoiceSession.ThreadActivity[] = [];
      for (let i = 0; i < 4; i++) after.push(yield* Queue.take(seen));
      assert.deepStrictEqual(after, [
        { type: "reply", text: "It's 56." },
        { type: "working", working: false },
        { type: "working", working: false },
        { type: "working", working: false },
      ]);
      assert.strictEqual(yield* Queue.size(seen), 0);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("posts an utterance as the user's message queued behind the current run", () =>
    Effect.gen(function* () {
      const h = yield* threadsHarness();
      yield* h.threads.post(threadId, "🎙️ Oi");
      assert.strictEqual(h.posted.length, 1);
      assert.deepInclude(h.posted[0] as object, {
        type: "message.dispatch",
        threadId,
        text: "🎙️ Oi",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "server",
      });
    }).pipe(Effect.provide(layerTest)),
  );
});
