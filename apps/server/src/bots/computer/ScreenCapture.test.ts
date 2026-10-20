import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import * as ScreenCapture from "./ScreenCapture.ts";

const monitor = (fields: Record<string, number | boolean>) => ({
  x: 0,
  y: 0,
  width: 1920,
  height: 1080,
  scale: 1,
  transform: 0,
  ...fields,
});
const oneMonitor = JSON.stringify([monitor({})]);

/** Fake grim and hyprctl: every grim run waits for the test to release it. */
const makeCommands = (monitorsJson: string) =>
  Effect.gen(function* () {
    const started = yield* Queue.unbounded<ReadonlyArray<string>>();
    const releases = yield* Queue.unbounded<"frame" | "fail">();
    const state = { monitorsJson, grimRuns: 0, monitorReads: 0 };
    const commands: ScreenCapture.ScreenCommands = {
      monitors: Effect.sync(() => {
        state.monitorReads++;
        return state.monitorsJson;
      }),
      grim: (args) =>
        Effect.gen(function* () {
          const run = ++state.grimRuns;
          yield* Queue.offer(started, args);
          if ((yield* Queue.take(releases)) === "fail") {
            return yield* new ScreenCapture.ScreenCaptureError({
              message: "grim is not installed.",
            });
          }
          return new Uint8Array([run]);
        }),
    };
    /** Lets the next capture finish and returns its grim arguments. */
    const capture = (result: "frame" | "fail" = "frame") =>
      Queue.take(started).pipe(Effect.tap(() => Queue.offer(releases, result)));
    return { commands, state, capture, started };
  });

it.effect("one capture per tick feeds every viewer and stops with the last viewer", () =>
  Effect.gen(function* () {
    const fake = yield* makeCommands(oneMonitor);
    const screen = yield* ScreenCapture.make(fake.commands);
    const watching = yield* Scope.make();
    const first = yield* screen
      .attach({ maxWidth: 960, quality: 50 })
      .pipe(Scope.provide(watching));
    const second = yield* screen
      .attach({ maxWidth: 1600, quality: 70 })
      .pipe(Scope.provide(watching));

    for (const run of [1, 2, 3]) {
      const args = yield* fake.capture();
      // The shared capture serves the most demanding viewer.
      expect(args).toEqual(["-t", "jpeg", "-q", "70", "-s", "0.8333", "-"]);
      const a = yield* first.next;
      const b = yield* second.next;
      expect(a).toBe(b);
      expect(a.jpeg).toEqual(new Uint8Array([run]));
      expect(a.info).toEqual({
        type: "info",
        width: 1600,
        height: 900,
        screenWidth: 1920,
        screenHeight: 1080,
      });
      yield* TestClock.adjust(ScreenCapture.FRAME_INTERVAL_MS);
    }
    yield* Queue.take(fake.started);
    expect(fake.state).toMatchObject({ grimRuns: 4, monitorReads: 1 });

    yield* Scope.close(watching, Exit.void);
    yield* TestClock.adjust(60_000);
    expect(fake.state).toMatchObject({ grimRuns: 4, monitorReads: 1 });

    // A new viewer starts capturing again.
    const third = yield* screen.attach({ maxWidth: 1920, quality: 70 });
    yield* fake.capture();
    expect((yield* third.next).jpeg).toEqual(new Uint8Array([5]));
  }).pipe(Effect.scoped),
);

it.effect("recomputes the scale when the screen geometry changes", () =>
  Effect.gen(function* () {
    const fake = yield* makeCommands(oneMonitor);
    const screen = yield* ScreenCapture.make(fake.commands);
    const viewer = yield* screen.attach({ maxWidth: 960, quality: 70 });

    expect(yield* fake.capture()).toContain("0.5");
    const before = yield* viewer.next;
    yield* TestClock.adjust(ScreenCapture.FRAME_INTERVAL_MS);
    yield* fake.capture();
    // Same geometry, same info object: viewers send it once.
    expect((yield* viewer.next).info).toBe(before.info);

    // A 2560 px monitor beside a 4K one at scale 2, and an output that is off.
    fake.state.monitorsJson = JSON.stringify([
      monitor({ width: 2560, height: 1440 }),
      monitor({ x: 2560, width: 3840, height: 2160, scale: 2 }),
      monitor({ x: 9000, disabled: true }),
    ]);
    yield* TestClock.adjust(ScreenCapture.GEOMETRY_TTL_MS);
    yield* fake.capture();
    yield* viewer.next;
    yield* TestClock.adjust(ScreenCapture.FRAME_INTERVAL_MS);
    const args = yield* fake.capture();
    expect(args[args.indexOf("-s") + 1]).toBe("0.2142");
    expect((yield* viewer.next).info).toEqual({
      type: "info",
      width: 960,
      height: 308,
      screenWidth: 4480,
      screenHeight: 1440,
    });
  }).pipe(Effect.scoped),
);

it.effect("never upscales past the sharpest output", () =>
  Effect.gen(function* () {
    expect(ScreenCapture.captureScale(yield* ScreenCapture.parseGeometry(oneMonitor), 3840)).toBe(
      1,
    );
    const hidpi = yield* ScreenCapture.parseGeometry(
      JSON.stringify([monitor({ width: 3840, height: 2160, scale: 2 })]),
    );
    expect(hidpi).toEqual({ left: 0, top: 0, width: 1920, height: 1080, maxScale: 2 });
    expect(ScreenCapture.captureScale(hidpi, 3840)).toBe(2);
    const rotated = yield* ScreenCapture.parseGeometry(JSON.stringify([monitor({ transform: 1 })]));
    expect(rotated).toMatchObject({ width: 1080, height: 1920 });
  }),
);

it.effect("a capture failure reaches the viewer and the next viewer retries", () =>
  Effect.gen(function* () {
    const fake = yield* makeCommands(oneMonitor);
    const screen = yield* ScreenCapture.make(fake.commands);
    const viewer = yield* screen.attach({ maxWidth: 1600, quality: 70 });
    yield* fake.capture("fail");
    const failure = yield* Effect.flip(viewer.next);
    expect(failure.message).toBe("grim is not installed.");

    const retry = yield* screen.attach({ maxWidth: 1600, quality: 70 });
    yield* fake.capture();
    expect((yield* retry.next).jpeg).toEqual(new Uint8Array([2]));
  }).pipe(Effect.scoped),
);

it("keeps only the desktop session variables for child processes", () => {
  const env = ScreenCapture.desktopEnv({
    PATH: "/usr/bin",
    HOME: "/home/someone",
    XDG_RUNTIME_DIR: "/run/user/1000",
    WAYLAND_DISPLAY: "wayland-0",
    HYPRLAND_INSTANCE_SIGNATURE: "sig",
    T3CODE_DEV_AUTH_TOKEN: "secret",
    OPENAI_API_KEY: "secret",
  });
  expect(env).toEqual({
    PATH: "/usr/bin",
    HOME: "/home/someone",
    XDG_RUNTIME_DIR: "/run/user/1000",
    WAYLAND_DISPLAY: "wayland-0",
    HYPRLAND_INSTANCE_SIGNATURE: "sig",
  });
});
