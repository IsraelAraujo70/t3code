import { expect, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  AuthSessionId,
  AuthTerminalOperateScope,
  AuthTerminalReadScope,
  COMPUTER_STREAM_PATH,
  type AuthEnvironmentScope,
  type ComputerStreamInput,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { HttpRouter } from "effect/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as ComputerInput from "./ComputerInput.ts";
import { routes, serveViewer, viewerOptions, viewerReplay } from "./ComputerStream.ts";
import * as ScreenCapture from "./ScreenCapture.ts";

const oneMonitor = JSON.stringify([{ x: 0, y: 0, width: 1920, height: 1080, scale: 1 }]);
const ack = JSON.stringify({ type: "ack" });
const click: ComputerStreamInput = {
  type: "pointer",
  action: "click",
  x: 0.5,
  y: 0.5,
  button: "left",
};

/** The input service over a runner that records commands instead of sending input. */
const makeInput = (screen: ScreenCapture.ScreenCapture["Service"]) =>
  Effect.gen(function* () {
    const commands = yield* Queue.unbounded<ReadonlyArray<string>>();
    const input = yield* ComputerInput.make((command, args) =>
      Queue.offer(commands, [command, ...args]).pipe(Effect.asVoid),
    ).pipe(Effect.provideService(ScreenCapture.ScreenCapture, screen));
    return { input, commands };
  });

/** Fake grim and hyprctl: every grim run waits for the test to release it. */
const makeCommands = Effect.gen(function* () {
  const started = yield* Queue.unbounded<void>();
  const releases = yield* Queue.unbounded<"frame" | "fail">();
  let runs = 0;
  const commands: ScreenCapture.ScreenCommands = {
    monitors: Effect.succeed(oneMonitor),
    grim: () =>
      Effect.gen(function* () {
        const run = ++runs;
        yield* Queue.offer(started, undefined);
        if ((yield* Queue.take(releases)) === "fail") {
          return yield* new ScreenCapture.ScreenCaptureError({
            message: "grim is not installed. The Computer view needs grim on a Hyprland desktop.",
          });
        }
        return new Uint8Array([run]);
      }),
  };
  /** Waits until a capture is running. */
  const capturing = Queue.take(started);
  const release = (result: "frame" | "fail" = "frame") => Queue.offer(releases, result);
  /** Lets the next capture finish, after the frame interval when one has already run. */
  const capture = (result: "frame" | "fail" = "frame") =>
    capturing.pipe(Effect.andThen(release(result)));
  const nextTick = TestClock.adjust(ScreenCapture.FRAME_INTERVAL_MS);
  return { commands, capturing, release, capture, nextTick };
});

/** A socket stand-in: what the server sent, and batches the viewer sends back. */
const makeSocket = Effect.gen(function* () {
  const sent = yield* Queue.unbounded<Uint8Array | string>();
  const incoming = yield* Queue.unbounded<ReadonlyArray<string>>();
  return {
    sent,
    reply: (...messages: ReadonlyArray<string>) => Queue.offer(incoming, messages),
    send: (data: Uint8Array | string) => Queue.offer(sent, data).pipe(Effect.asVoid),
    pull: Queue.take(incoming),
  };
});

it.effect("sends info first, then one frame per ack, skipping stale frames", () =>
  Effect.gen(function* () {
    const fake = yield* makeCommands;
    const screen = yield* ScreenCapture.make(fake.commands);
    const socket = yield* makeSocket;
    const viewer = yield* screen.attach({ maxWidth: 1920, quality: 70 });
    yield* Effect.forkScoped(serveViewer(viewer, socket.send, socket.pull, undefined));

    yield* fake.capture();
    expect(JSON.parse(String(yield* Queue.take(socket.sent)))).toEqual({
      type: "access",
      canControl: false,
    });
    expect(JSON.parse(String(yield* Queue.take(socket.sent)))).toEqual({
      type: "info",
      width: 1920,
      height: 1080,
      screenWidth: 1920,
      screenHeight: 1080,
    });
    expect(yield* Queue.take(socket.sent)).toEqual(new Uint8Array([1]));

    // Frames 2 and 3 are captured while frame 1 is unacknowledged.
    for (let i = 0; i < 2; i++) {
      yield* fake.nextTick;
      yield* fake.capture();
    }
    yield* fake.nextTick;
    yield* fake.capturing;
    expect(yield* Queue.size(socket.sent)).toBe(0);

    // Only a contract ack releases a frame, and it is the newest one.
    yield* socket.reply("not json", JSON.stringify({ type: "mouse" }), ack);
    expect(yield* Queue.take(socket.sent)).toEqual(new Uint8Array([3]));

    // Extra acks in one batch must not pay for a later frame.
    yield* socket.reply(ack, ack);
    yield* fake.release();
    expect(yield* Queue.take(socket.sent)).toEqual(new Uint8Array([4]));
    yield* fake.nextTick;
    yield* fake.capture();
    yield* fake.nextTick;
    yield* fake.capturing;
    expect(yield* Queue.size(socket.sent)).toBe(0);
    yield* socket.reply(ack);
    expect(yield* Queue.take(socket.sent)).toEqual(new Uint8Array([5]));
  }).pipe(Effect.scoped),
);

it.effect("a capture failure is sent as an error and ends the stream", () =>
  Effect.gen(function* () {
    const fake = yield* makeCommands;
    const screen = yield* ScreenCapture.make(fake.commands);
    const socket = yield* makeSocket;
    const viewer = yield* screen.attach({ maxWidth: 1920, quality: 70 });
    const served = yield* Effect.forkScoped(
      serveViewer(viewer, socket.send, socket.pull, undefined),
    );

    yield* fake.capture("fail");
    yield* Fiber.join(served);
    expect(yield* Queue.takeAll(socket.sent)).toEqual([
      JSON.stringify({ type: "access", canControl: false }),
      JSON.stringify({
        type: "error",
        message: "grim is not installed. The Computer view needs grim on a Hyprland desktop.",
      }),
    ]);
  }).pipe(Effect.scoped),
);

it.effect("a controlling viewer's input is replayed while its frame awaits an ack", () =>
  Effect.gen(function* () {
    const fake = yield* makeCommands;
    const screen = yield* ScreenCapture.make(fake.commands);
    const { input, commands } = yield* makeInput(screen);
    const socket = yield* makeSocket;
    const viewer = yield* screen.attach({ maxWidth: 1920, quality: 70 });
    const replay = viewerReplay([AuthTerminalReadScope, AuthTerminalOperateScope], input);
    yield* Effect.forkScoped(serveViewer(viewer, socket.send, socket.pull, replay));

    expect(yield* Queue.take(socket.sent)).toBe(
      JSON.stringify({ type: "access", canControl: true }),
    );
    yield* fake.capture();
    yield* Queue.take(socket.sent);
    expect(yield* Queue.take(socket.sent)).toEqual(new Uint8Array([1]));

    // Frame 1 is unacknowledged; the click still runs, and garbage is dropped.
    yield* socket.reply("{", JSON.stringify(click));
    expect(yield* Queue.take(commands)).toEqual([
      "hyprctl",
      "dispatch",
      "movecursor",
      "960",
      "540",
    ]);
    expect(yield* Queue.take(commands)).toEqual(["ydotool", "click", "0xC0"]);

    yield* fake.nextTick;
    yield* fake.capture();
    yield* socket.reply(ack);
    expect(yield* Queue.take(socket.sent)).toEqual(new Uint8Array([2]));
  }).pipe(Effect.scoped),
);

it.effect("a viewer without terminal:operate cannot control the host", () =>
  Effect.gen(function* () {
    const fake = yield* makeCommands;
    const screen = yield* ScreenCapture.make(fake.commands);
    const { input, commands } = yield* makeInput(screen);
    const socket = yield* makeSocket;
    const viewer = yield* screen.attach({ maxWidth: 1920, quality: 70 });
    const replay = viewerReplay([AuthTerminalReadScope], input);
    yield* Effect.forkScoped(serveViewer(viewer, socket.send, socket.pull, replay));

    expect(yield* Queue.take(socket.sent)).toBe(
      JSON.stringify({ type: "access", canControl: false }),
    );
    yield* fake.capture();
    yield* Queue.take(socket.sent);
    expect(yield* Queue.take(socket.sent)).toEqual(new Uint8Array([1]));

    // The ack in the same batch still works; the input is gone.
    yield* socket.reply(JSON.stringify(click), JSON.stringify({ type: "text", text: "hi" }), ack);
    yield* fake.nextTick;
    yield* fake.capture();
    expect(yield* Queue.take(socket.sent)).toEqual(new Uint8Array([2]));
    expect(yield* Queue.size(commands)).toBe(0);
  }).pipe(Effect.scoped),
);

it("clamps the requested frame size and quality", () => {
  expect(viewerOptions(new URLSearchParams())).toEqual({ maxWidth: 1600, quality: 70 });
  expect(viewerOptions(new URLSearchParams("maxWidth=10&quality=500"))).toEqual({
    maxWidth: 320,
    quality: 100,
  });
  expect(viewerOptions(new URLSearchParams("maxWidth=99999&quality=0"))).toEqual({
    maxWidth: 3840,
    quality: 1,
  });
  expect(viewerOptions(new URLSearchParams("maxWidth=wide&quality="))).toEqual({
    maxWidth: 1600,
    quality: 70,
  });
});

it.effect.each([
  { env: {}, scopes: [AuthTerminalReadScope], status: 404, authenticated: false },
  {
    env: { T3CODE_BOTS_HOST: "1" },
    scopes: [AuthOrchestrationReadScope],
    status: 403,
    authenticated: true,
  },
])("answers $status before streaming (%#)", (testCase) =>
  Effect.gen(function* () {
    const fake = yield* makeCommands;
    const authRequests: string[] = [];
    const auth = Layer.mock(EnvironmentAuth.EnvironmentAuth, {
      authenticateWebSocketUpgrade: (request) => {
        authRequests.push(request.originalUrl);
        return Effect.succeed({
          sessionId: AuthSessionId.make("computer-test"),
          subject: "computer-test",
          method: "bearer-access-token",
          scopes: testCase.scopes satisfies ReadonlyArray<AuthEnvironmentScope>,
        });
      },
    });
    const handler = yield* Effect.acquireRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          routes.pipe(
            Layer.provide(
              Layer.mock(ComputerInput.ComputerInput, { replay: () => Effect.die("no input") }),
            ),
            Layer.provide(
              Layer.effect(ScreenCapture.ScreenCapture, ScreenCapture.make(fake.commands)),
            ),
            Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: testCase.env }))),
            Layer.provideMerge(auth),
          ),
          { disableLogger: true },
        ),
      ),
      ({ dispose }) => Effect.promise(dispose),
    );
    const response = yield* Effect.promise(() =>
      handler.handler(
        new Request(`http://t3.test${COMPUTER_STREAM_PATH}?wsTicket=one-use`, {
          headers: { upgrade: "websocket" },
        }),
      ),
    );
    expect(response.status).toBe(testCase.status);
    expect(authRequests.length > 0).toBe(testCase.authenticated);
  }).pipe(Effect.scoped),
);
