import {
  AuthOrchestrationOperateScope,
  BOTS_WS_METHODS,
  EnvironmentId,
  MessageId,
  ThreadId,
  VoiceSessionId,
  type VoiceSessionEvent,
  type AuthSessionState,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { vi } from "vite-plus/test";

import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createBotsEnvironmentAtoms, createVoiceTransport } from "./bots.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);
const env = EnvironmentId.make("env-1");
const answer: VoiceSessionEvent = {
  type: "answer",
  sessionId: VoiceSessionId.make("session"),
  sdp: "answer-sdp",
};
const session = (operate: boolean): AuthSessionState => ({
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: operate ? [AuthOrchestrationOperateScope] : [],
  permissions: operate ? [AuthOrchestrationOperateScope] : [],
});

/** Opens a read session through the transport; the fake server answers and ends it. */
const read = Effect.fn(function* (operate: boolean) {
  const reads: unknown[] = [];
  const rpcSession = {
    client: {
      [BOTS_WS_METHODS.voiceSession]: (input: unknown) =>
        Stream.fromEffect(
          Effect.sync(() => {
            reads.push(input);
            return answer;
          }),
        ),
    },
  } as unknown as RpcSession;
  const supervisor = {
    target: { environmentId: env, label: "env" },
    session: yield* SubscriptionRef.make(Option.some(rpcSession)),
  } as unknown as EnvironmentSupervisor["Service"];
  const runtime = Atom.runtime(
    Layer.succeed(EnvironmentRegistry, {
      followStream: <A, E, R>(_id: EnvironmentId, stream: Stream.Stream<A, E, R>) =>
        stream.pipe(Stream.provideService(EnvironmentSupervisor, supervisor)),
    } as unknown as EnvironmentRegistry["Service"]),
  );
  const registry = AtomRegistry.make();
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  registry.set(sessions(env), AsyncResult.success(session(operate)));
  const transport = createVoiceTransport(registry, createBotsEnvironmentAtoms(runtime));
  const events: unknown[] = [];
  yield* Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        transport.session(
          {
            environmentId: env,
            threadId: ThreadId.make("thread-1"),
            mode: { type: "read", messageId: MessageId.make("message-1") },
          },
          "offer-sdp",
          {
            onAnswer: (value) => events.push(value),
            onBot: (working) => events.push({ working }),
            onEnd: (error) => {
              events.push({ end: error });
              resolve();
            },
          },
        );
      }),
  );
  return { events, reads };
});

describe("voice transport", () => {
  it.effect("opens the session when the session grants orchestration:operate", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, reads } = yield* read(true);
        expect(reads).toEqual([
          {
            threadId: "thread-1",
            mode: { type: "read", messageId: "message-1" },
            sdp: "offer-sdp",
          },
        ]);
        expect(events).toEqual([answer, { end: null }]);
      }),
    ),
  );

  it.effect("is denied before reaching the server without orchestration:operate", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { events, reads } = yield* read(false);
        expect(reads).toEqual([]);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ end: expect.any(String) });
        expect(events[0]).not.toEqual({ end: null });
      }),
    ),
  );
});
