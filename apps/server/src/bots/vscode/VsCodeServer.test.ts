import { expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient } from "effect/http";

import * as VsCodeServer from "./VsCodeServer.ts";

const IDLE_MS = 60_000;

/** A launcher that counts starts and stops; each start is a new upstream. */
const makeLauncher = () => {
  const calls = { launches: 0, stops: 0 };
  const launcher: VsCodeServer.VsCodeLauncher = {
    launch: Effect.sync(() => {
      calls.launches += 1;
      return {
        http: HttpClient.make(() => Effect.die("no requests in this test")),
        openWebSocket: () => {
          throw new Error("no sockets in this test");
        },
      };
    }),
    stop: Effect.sync(() => {
      calls.stops += 1;
    }),
  };
  return { calls, launcher };
};

/** Long enough past `idle` for the next idle check to see it. */
const past = (idle: number) =>
  TestClock.adjust(idle + Duration.toMillis(VsCodeServer.idleCheckInterval(IDLE_MS)));

it.effect("starts on first use, stops once idle, and starts again on the next use", () =>
  Effect.gen(function* () {
    const { calls, launcher } = makeLauncher();
    const server = yield* VsCodeServer.make(launcher, IDLE_MS);

    const first = yield* server.upstream;
    expect(yield* server.upstream).toBe(first);
    expect(calls).toEqual({ launches: 1, stops: 0 });

    yield* TestClock.adjust(IDLE_MS / 2);
    expect(calls.stops).toBe(0);
    yield* past(IDLE_MS);
    expect(calls).toEqual({ launches: 1, stops: 1 });

    const second = yield* server.upstream;
    expect(second).not.toBe(first);
    expect(calls).toEqual({ launches: 2, stops: 1 });
  }).pipe(Effect.scoped),
);

it.effect("an open connection keeps it running; idling counts from when it closes", () =>
  Effect.gen(function* () {
    const { calls, launcher } = makeLauncher();
    const server = yield* VsCodeServer.make(launcher, IDLE_MS);
    yield* server.upstream;

    const connection = yield* Scope.make();
    yield* server.holdOpen.pipe(Scope.provide(connection));
    yield* past(IDLE_MS * 3);
    expect(calls.stops).toBe(0);

    yield* Scope.close(connection, Exit.void);
    yield* TestClock.adjust(IDLE_MS / 2);
    expect(calls.stops).toBe(0);
    yield* past(IDLE_MS);
    expect(calls.stops).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect("stops a running server when the T3 server shuts down", () =>
  Effect.gen(function* () {
    const { calls, launcher } = makeLauncher();
    const scope = yield* Scope.make();
    const server = yield* VsCodeServer.make(launcher, IDLE_MS).pipe(Scope.provide(scope));
    yield* server.upstream;
    yield* Scope.close(scope, Exit.void);
    expect(calls).toEqual({ launches: 1, stops: 1 });
  }),
);

it.effect("a lost server is started again on the next request", () =>
  Effect.gen(function* () {
    const { calls, launcher } = makeLauncher();
    const server = yield* VsCodeServer.make(launcher, IDLE_MS);
    const first = yield* server.upstream;
    yield* server.lost(first);
    expect(yield* server.upstream).not.toBe(first);
    expect(calls.launches).toBe(2);
  }).pipe(Effect.scoped),
);
