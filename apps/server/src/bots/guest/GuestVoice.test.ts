import { assert, describe, it } from "@effect/vitest";
import {
  BotsError,
  GuestId,
  ThreadId,
  VoiceSessionId,
  type GuestVoiceEvent,
  type VoiceReportInput,
  type VoiceSessionEvent,
  type VoiceSessionInput,
  type VoiceSessionRef,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as VoiceSession from "../voice/VoiceSession.ts";
import { GuestApiError, GuestService } from "./GuestService.ts";
import type { GuestRecord } from "./GuestStore.ts";
import * as GuestVoice from "./GuestVoice.ts";

const guest = (id: string): GuestRecord => ({
  id: GuestId.make(id),
  name: id,
  tokenHash: `hash-${id}`,
  tokenCreatedAt: null,
  createdAt: "2026-10-25T00:00:00.000Z",
  updatedAt: "2026-10-25T00:00:00.000Z",
});
const bia = guest("bia");
const ana = guest("ana");
const biaThread = ThreadId.make("bot:b_bia:1");

const setup = Effect.fn("test.setup")(function* () {
  const revoked = yield* Deferred.make<void>();
  const posted: string[] = [];
  let refusePosts: GuestApiError | null = null;
  const opened: Array<{
    input: VoiceSessionInput;
    post: (text: string) => Effect.Effect<void, BotsError>;
  }> = [];
  const readies: VoiceSessionRef[] = [];
  const reports: VoiceReportInput[] = [];
  /** Each opened session's events after its answer; failing one fails that session. */
  const sessions: Array<Queue.Queue<VoiceSessionEvent, BotsError | Cause.Done>> = [];
  const service = yield* GuestVoice.GuestVoice.pipe(
    Effect.provide(
      GuestVoice.layer.pipe(
        Layer.provide(
          Layer.mock(GuestService)({
            voiceConversation: (who, botId) =>
              who.id === bia.id && botId === "b_bia"
                ? Effect.succeed({
                    threadId: biaThread,
                    post: (text: string) =>
                      refusePosts === null
                        ? Effect.sync(() => {
                            posted.push(text);
                          })
                        : Effect.fail(refusePosts),
                    revoked: Deferred.await(revoked),
                  })
                : Effect.fail(
                    new GuestApiError({ status: 404, message: "Assistente não encontrado." }),
                  ),
          }),
        ),
        Layer.provide(
          Layer.succeed(VoiceSession.VoiceSessions, {
            session: (input, options) =>
              Stream.unwrap(
                Effect.gen(function* () {
                  const events = yield* Queue.unbounded<
                    VoiceSessionEvent,
                    BotsError | Cause.Done
                  >();
                  const sessionId = VoiceSessionId.make(`session-${opened.length + 1}`);
                  opened.push({ input, post: options?.post ?? (() => Effect.void) });
                  sessions.push(events);
                  const answer: VoiceSessionEvent = { type: "answer", sessionId, sdp: "answer" };
                  return Stream.make(answer).pipe(Stream.concat(Stream.fromQueue(events)));
                }),
              ),
            ready: (input) =>
              Effect.sync(() => {
                readies.push(input);
                return input;
              }),
            reconnect: () => Effect.fail(new BotsError({ message: "unused" })),
            report: (input) =>
              Effect.sync(() => {
                reports.push(input);
              }),
          }),
        ),
      ),
    ),
  );

  /** Opens a session for `who` and reads its answer; `fiber` ends with the stream. */
  const open = Effect.fn("test.open")(function* (who: GuestRecord) {
    const stream = yield* service.session(who, "b_bia", {
      mode: { type: "conversation" },
      sdp: "offer",
    });
    const events = yield* Queue.unbounded<GuestVoiceEvent>();
    const fiber = yield* Effect.forkScoped(
      Stream.runForEach(stream, (event) => Queue.offer(events, event)),
    );
    const answer = yield* Queue.take(events);
    assert.strictEqual(answer.type, "answer");
    const sessionId = answer.type === "answer" ? answer.sessionId : VoiceSessionId.make("none");
    return { events, fiber, ref: { sessionId } };
  });

  return {
    service,
    open,
    opened,
    sessions,
    posted,
    readies,
    reports,
    revoke: Deferred.succeed(revoked, undefined),
    refusePosts: (error: GuestApiError) => {
      refusePosts = error;
    },
  };
});

const statusOf = <A>(exit: Exit.Exit<A, GuestApiError>) =>
  Exit.isFailure(exit) && exit.cause.reasons[0]?._tag === "Fail"
    ? exit.cause.reasons[0].error.status
    : null;

describe("GuestVoice", () => {
  it.effect("opens voice only on the guest's own bot, on its conversation thread", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      for (const [who, botId] of [
        [ana, "b_bia"],
        [bia, "b_ana"],
      ] as const) {
        const exit = yield* h.service
          .session(who, botId, { mode: { type: "conversation" }, sdp: "offer" })
          .pipe(Effect.exit);
        assert.strictEqual(statusOf(exit), 404);
      }
      assert.deepStrictEqual(h.opened, []);

      yield* h.open(bia);
      assert.deepStrictEqual(
        h.opened.map((session) => session.input),
        [{ threadId: biaThread, mode: { type: "conversation" }, sdp: "offer" }],
      );
    }),
  );

  it.effect("posts what the guest said through the guest's send", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      yield* h.open(bia);
      yield* h.opened[0]!.post("🎙️ Oi");
      assert.deepStrictEqual(h.posted, ["🎙️ Oi"]);
    }),
  );

  it.effect("lets only the session's guest make it ready or report on it", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const { ref } = yield* h.open(bia);
      const report = { sessionId: ref.sessionId, entries: [{ t: 1, final: true }] };
      assert.strictEqual(statusOf(yield* h.service.ready(ana, ref).pipe(Effect.exit)), 404);
      assert.strictEqual(statusOf(yield* h.service.report(ana, report).pipe(Effect.exit)), 404);
      const unknown = { sessionId: VoiceSessionId.make("session-unknown") };
      assert.strictEqual(statusOf(yield* h.service.ready(bia, unknown).pipe(Effect.exit)), 404);
      assert.deepStrictEqual(h.readies, []);
      assert.deepStrictEqual(h.reports, []);

      assert.deepStrictEqual(yield* h.service.ready(bia, ref), ref);
      yield* h.service.report(bia, report);
      assert.deepStrictEqual(h.readies, [ref]);
      assert.deepStrictEqual(h.reports, [report]);
    }),
  );

  it.effect("takes an ended session's last report for a while, and no ready", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const { ref, fiber } = yield* h.open(bia);
      yield* Queue.end(h.sessions[0]!);
      yield* Fiber.join(fiber);
      const report = { sessionId: ref.sessionId, entries: [{ t: 1, end: "ok" }] };
      assert.strictEqual(statusOf(yield* h.service.ready(bia, ref).pipe(Effect.exit)), 404);
      yield* h.service.report(bia, report);
      assert.strictEqual(statusOf(yield* h.service.report(ana, report).pipe(Effect.exit)), 404);
      yield* TestClock.adjust(Duration.millis(GuestVoice.REPORT_GRACE_MS + 1));
      assert.strictEqual(statusOf(yield* h.service.report(bia, report).pipe(Effect.exit)), 404);
    }),
  );

  it.effect("ends a guest's session when they open another", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const first = yield* h.open(bia);
      const second = yield* h.open(bia);
      assert.isTrue(Exit.isSuccess(yield* Fiber.await(first.fiber)));
      assert.strictEqual(statusOf(yield* h.service.ready(bia, first.ref).pipe(Effect.exit)), 404);
      assert.isUndefined(second.fiber.pollUnsafe());
      assert.deepStrictEqual(yield* h.service.ready(bia, second.ref), second.ref);
    }),
  );

  it.effect("ends the session once the guest's access is revoked", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const { ref, fiber } = yield* h.open(bia);
      yield* h.revoke;
      assert.isTrue(Exit.isSuccess(yield* Fiber.await(fiber)));
      assert.strictEqual(statusOf(yield* h.service.ready(bia, ref).pipe(Effect.exit)), 404);
    }),
  );

  it.effect("ends a failed session with an error the guest can read", () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const failed = yield* h.open(bia);
      yield* Queue.offer(h.sessions[0]!, { type: "bot", working: true });
      yield* Queue.fail(
        h.sessions[0]!,
        new BotsError({ message: "The voice connection did not come up." }),
      );
      yield* Fiber.join(failed.fiber);
      assert.deepStrictEqual(yield* Queue.takeAll(failed.events), [
        { type: "bot", working: true },
        { type: "error", message: GuestVoice.VOICE_FAILED_MESSAGE },
      ]);

      // A refused send says why, in the guest's words.
      const refused = yield* h.open(bia);
      const reason = "Este assistente ainda não está pronto. Peça para o Israel dar uma olhada.";
      h.refusePosts(new GuestApiError({ status: 409, message: reason }));
      const postError = yield* Effect.flip(h.opened[1]!.post("🎙️ Oi"));
      yield* Queue.fail(h.sessions[1]!, postError);
      yield* Fiber.join(refused.fiber);
      assert.deepStrictEqual(yield* Queue.takeAll(refused.events), [
        { type: "error", message: reason },
      ]);
    }),
  );
});
