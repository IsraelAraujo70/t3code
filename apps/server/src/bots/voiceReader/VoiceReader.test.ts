import { assert, describe, it } from "@effect/vitest";
import {
  BotsError,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  VoiceReaderUtteranceId,
  type OrchestrationV2DomainEvent,
  type VoiceReaderAnswer,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as CodexRealtime from "./CodexRealtime.ts";
import * as VoiceReader from "./VoiceReader.ts";

const threadId = ThreadId.make("voice-test");
const messageId = MessageId.make("reply");

const setup = Effect.fn("test.setup")(function* () {
  const events = yield* Queue.unbounded<CodexRealtime.RealtimeEvent>();
  const texts: string[] = [];
  const lookups: Array<[ThreadId, MessageId]> = [];
  let opens = 0;
  let stops = 0;
  const service = yield* VoiceReader.VoiceReader.pipe(
    Effect.provide(
      VoiceReader.layer.pipe(
        Layer.provide(
          Layer.succeed(VoiceReader.VoiceReaderMessages, {
            text: (thread, message) =>
              Effect.suspend(() => {
                lookups.push([thread, message]);
                return message === messageId
                  ? Effect.succeed("full reply")
                  : Effect.fail(new BotsError({ message: "This message is not in that thread." }));
              }),
          }),
        ),
        Layer.provide(
          Layer.succeed(CodexRealtime.CodexRealtime, {
            open: Effect.sync(() => {
              opens++;
              return {
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
              };
            }),
          }),
        ),
      ),
    ),
  );
  /** Starts a read and waits for its answer; `fiber` settles when the read's stream ends. */
  const read = Effect.fn("test.read")(function* () {
    const answers = yield* Queue.unbounded<VoiceReaderAnswer>();
    const fiber = yield* Effect.forkScoped(
      Stream.runForEach(service.read({ threadId, messageId, sdp: "offer" }), (answer) =>
        Queue.offer(answers, answer),
      ).pipe(Effect.exit),
    );
    const answer = yield* Queue.take(answers);
    return { answer, ref: { utteranceId: answer.utteranceId }, fiber };
  });
  return {
    service,
    events,
    texts,
    lookups,
    read,
    opens: () => opens,
    stops: () => stops,
  };
});

const failureMessage = (exit: Exit.Exit<void, BotsError>) =>
  Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Fail"
    ? exit.cause.reasons[0].error.message
    : null;

describe("VoiceReader", () => {
  it.effect("speaks the requested message and ends after the transcript grace", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const { answer, ref, fiber } = yield* h.read();
      assert.strictEqual(answer.sdp, "answer");
      assert.deepStrictEqual(h.lookups, [[threadId, messageId]]);
      yield* h.service.speak(ref);
      assert.deepStrictEqual(h.texts, [VoiceReader.voiceReaderSpeech("full reply")]);
      yield* Queue.offer(h.events, { type: "transcript-done" });
      yield* TestClock.adjust(VoiceReader.SPEECH_END_GRACE);
      assert.isTrue(Exit.isSuccess(yield* Fiber.join(fiber)));
      assert.strictEqual(h.stops(), 1);
    }),
  );

  it.effect("fails before starting Codex when the message lookup refuses", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const exit = yield* Stream.runDrain(
        h.service.read({ threadId, messageId: MessageId.make("user"), sdp: "offer" }),
      ).pipe(Effect.exit);
      assert.strictEqual(failureMessage(exit), "This message is not in that thread.");
      assert.strictEqual(h.opens(), 0);
    }),
  );

  it.effect("speaks once and refuses unknown utterances", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const { ref } = yield* h.read();
      yield* h.service.speak(ref);
      assert.strictEqual((yield* Effect.result(h.service.speak(ref)))._tag, "Failure");
      const unknown = { utteranceId: VoiceReaderUtteranceId.make("unknown") };
      assert.strictEqual((yield* Effect.result(h.service.speak(unknown)))._tag, "Failure");
      assert.strictEqual(h.texts.length, 1);
    }),
  );

  it.effect("fails a peer that never connects and bounds a session that never ends", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const first = yield* h.read();
      yield* TestClock.adjust(VoiceReader.CONNECT_TIMEOUT);
      assert.strictEqual(
        failureMessage(yield* Fiber.join(first.fiber)),
        "The voice connection did not come up.",
      );
      assert.strictEqual((yield* Effect.result(h.service.speak(first.ref)))._tag, "Failure");
      const second = yield* h.read();
      yield* h.service.speak(second.ref);
      yield* TestClock.adjust(VoiceReader.CONNECT_TIMEOUT);
      assert.isUndefined(second.fiber.pollUnsafe());
      yield* TestClock.adjust(VoiceReader.MAX_UTTERANCE);
      assert.isTrue(Exit.isSuccess(yield* Fiber.join(second.fiber)));
      assert.strictEqual(h.stops(), 2);
    }),
  );

  it.effect("fails on a realtime error and completes when realtime closes", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const first = yield* h.read();
      yield* Queue.offer(h.events, { type: "error", message: "Voice failed" });
      assert.strictEqual(failureMessage(yield* Fiber.join(first.fiber)), "Voice failed");
      const second = yield* h.read();
      yield* h.service.speak(second.ref);
      yield* Queue.offer(h.events, { type: "closed", reason: null });
      assert.isTrue(Exit.isSuccess(yield* Fiber.join(second.fiber)));
      assert.strictEqual(h.stops(), 2);
    }),
  );

  it.effect("closes the session when the client ends the read", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const { ref, fiber } = yield* h.read();
      yield* h.service.speak(ref);
      yield* Fiber.interrupt(fiber);
      assert.strictEqual(h.stops(), 1);
      assert.strictEqual((yield* Effect.result(h.service.speak(ref)))._tag, "Failure");
    }),
  );
});

describe("VoiceReaderMessages", () => {
  const otherThreadId = ThreadId.make("voice-other");
  const seed = (now: DateTime.Utc): ReadonlyArray<OrchestrationV2DomainEvent> => {
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
    ): OrchestrationV2DomainEvent => ({
      id: EventId.make(`message:${id}`),
      threadId: thread,
      occurredAt: now,
      type: "message.updated",
      payload: {
        id: MessageId.make(id),
        threadId: thread,
        runId: null,
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
    return [
      thread(threadId),
      thread(otherThreadId),
      message(threadId, "question", "user", "What changed?"),
      message(threadId, "answer", "assistant", "The fix landed."),
      message(threadId, "blank", "assistant", "  "),
      message(otherThreadId, "elsewhere", "assistant", "Another thread's reply."),
    ];
  };

  it.effect("returns only an assistant message of the requested thread", () =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      yield* Effect.forEach(seed(yield* DateTime.now), (event) => store.apply(event), {
        discard: true,
      });
      const messages = yield* VoiceReader.VoiceReaderMessages;
      const refused = (thread: ThreadId, id: string) =>
        messages.text(thread, MessageId.make(id)).pipe(
          Effect.flip,
          Effect.map((error) => error.message),
        );
      assert.strictEqual(
        yield* messages.text(threadId, MessageId.make("answer")),
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
    }).pipe(
      Effect.provide(
        Layer.mergeAll(VoiceReader.layerMessages, ProjectionStore.layer).pipe(
          Layer.provideMerge(SqlitePersistence.layerMemory),
        ),
      ),
    ),
  );
});
