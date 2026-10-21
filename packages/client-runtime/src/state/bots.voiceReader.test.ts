import {
  AuthOrchestrationOperateScope,
  BOTS_WS_METHODS,
  EnvironmentId,
  ThreadId,
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
import { createBotsEnvironmentAtoms } from "./bots.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);
const env = EnvironmentId.make("env-1");
const state = { phase: "idle" };
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

const subscribe = Effect.fn(function* (operate: boolean) {
  let subscribed = 0;
  const rpcSession = {
    client: {
      [BOTS_WS_METHODS.voiceReaderSubscribe]: () =>
        Stream.fromEffect(
          Effect.sync(() => {
            subscribed++;
            return state;
          }),
        ).pipe(Stream.concat(Stream.never)),
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
  const voiceReader = createBotsEnvironmentAtoms(runtime).voiceReader({
    environmentId: env,
    input: { threadId: ThreadId.make("thread-1") },
  });
  yield* AtomRegistry.mount(registry, voiceReader);
  const result = yield* AtomRegistry.getResult(registry, voiceReader, {
    suspendOnWaiting: false,
  }).pipe(Effect.result);
  return { result, subscribed };
});

describe("voiceReader", () => {
  it.effect("subscribes when the session grants orchestration:operate", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { result, subscribed } = yield* subscribe(true);
        expect(result).toMatchObject({ _tag: "Success", success: state });
        expect(subscribed).toBe(1);
      }),
    ),
  );

  it.effect("is denied before reaching the server without orchestration:operate", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { result, subscribed } = yield* subscribe(false);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "EnvironmentAuthorizationError" },
        });
        expect(subscribed).toBe(0);
      }),
    ),
  );
});
