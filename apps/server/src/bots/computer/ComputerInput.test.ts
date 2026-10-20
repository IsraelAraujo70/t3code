import { expect, it } from "@effect/vitest";
import type { ComputerStreamInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ComputerInput from "./ComputerInput.ts";
import * as ScreenCapture from "./ScreenCapture.ts";

// A 1920x1080 output left of and above a 2560x1440 one at scale 2 (1280x720 logical).
const twoMonitors = JSON.stringify([
  { x: -1920, y: -200, width: 1920, height: 1080, scale: 1 },
  { x: 0, y: 0, width: 2560, height: 1440, scale: 2 },
]);

/** The input service over fake commands: records every command instead of running it. */
const makeInput = (options: { readonly failing?: "hyprctl" } = {}) =>
  Effect.gen(function* () {
    let monitorReads = 0;
    const screen = yield* ScreenCapture.make({
      monitors: Effect.sync(() => {
        monitorReads++;
        return twoMonitors;
      }),
      grim: () => Effect.die("no capture in input tests"),
    });
    const commands: Array<ReadonlyArray<string>> = [];
    const input = yield* ComputerInput.make((command, args) =>
      Effect.suspend(() => {
        commands.push([command, ...args]);
        return command === options.failing
          ? Effect.fail(new ComputerInput.ComputerInputError({ message: `${command} failed` }))
          : Effect.void;
      }),
    ).pipe(Effect.provideService(ScreenCapture.ScreenCapture, screen));
    /** Replays the inputs and returns the commands they ran. */
    const replay = (...inputs: ReadonlyArray<ComputerStreamInput>) =>
      Effect.gen(function* () {
        commands.length = 0;
        for (const one of inputs) yield* input.replay(one);
        return [...commands];
      });
    return { replay, monitorReads: () => monitorReads };
  });

it.effect("maps frame fractions into the captured box, clamped inside it", () =>
  Effect.gen(function* () {
    const geometry = yield* ScreenCapture.parseGeometry(twoMonitors);
    expect(geometry).toEqual({ left: -1920, top: -200, width: 3200, height: 1080, maxScale: 2 });
    expect(ComputerInput.screenPoint(geometry, 0, 0)).toEqual({ x: -1920, y: -200 });
    expect(ComputerInput.screenPoint(geometry, 0.5, 0.5)).toEqual({ x: -320, y: 340 });
    // The far edge is one pixel inside, never the next output's first pixel.
    expect(ComputerInput.screenPoint(geometry, 1, 1)).toEqual({ x: 1279, y: 879 });
  }),
);

it.effect("a left click moves exactly, then presses and releases", () =>
  Effect.gen(function* () {
    const fake = yield* makeInput();
    expect(
      yield* fake.replay({ type: "pointer", action: "click", x: 0.5, y: 0.5, button: "left" }),
    ).toEqual([
      ["hyprctl", "dispatch", "movecursor", "-320", "340"],
      ["ydotool", "click", "0xC0"],
    ]);
  }),
);

it.effect("a right drag presses, moves, and releases in order", () =>
  Effect.gen(function* () {
    const fake = yield* makeInput();
    expect(
      yield* fake.replay(
        { type: "pointer", action: "down", x: 0, y: 0, button: "right" },
        { type: "pointer", action: "move", x: 0.25, y: 0.5, button: "right" },
        { type: "pointer", action: "up", x: 0.25, y: 0.5, button: "right" },
      ),
    ).toEqual([
      ["hyprctl", "dispatch", "movecursor", "-1920", "-200"],
      ["ydotool", "click", "0x41"],
      ["hyprctl", "dispatch", "movecursor", "-1120", "340"],
      ["hyprctl", "dispatch", "movecursor", "-1120", "340"],
      ["ydotool", "click", "0x81"],
    ]);
    // Every event reads the cached geometry, not hyprctl.
    expect(fake.monitorReads()).toBe(1);
  }),
);

it.effect("scrolls at the pointer, down for a positive deltaY", () =>
  Effect.gen(function* () {
    const fake = yield* makeInput();
    expect(yield* fake.replay({ type: "wheel", x: 0.5, y: 0.5, deltaX: -2, deltaY: 3 })).toEqual([
      ["hyprctl", "dispatch", "movecursor", "-320", "340"],
      ["ydotool", "mousemove", "--wheel", "-x", "-2", "-y", "-3"],
    ]);
  }),
);

it.effect("types keys with modifiers held and text as one literal argument", () =>
  Effect.gen(function* () {
    const fake = yield* makeInput();
    expect(yield* fake.replay({ type: "key", key: "T", modifiers: ["ctrl", "shift"] })).toEqual([
      ["wtype", "-M", "ctrl", "-M", "shift", "-k", "t", "-m", "shift", "-m", "ctrl"],
    ]);
    expect(yield* fake.replay({ type: "key", key: "Enter", modifiers: [] })).toEqual([
      ["wtype", "-k", "Return"],
    ]);
    expect(yield* fake.replay({ type: "key", key: "a", modifiers: ["meta"] })).toEqual([
      ["wtype", "-M", "logo", "-k", "a", "-m", "logo"],
    ]);
    expect(yield* fake.replay({ type: "key", key: "A", modifiers: ["shift"] })).toEqual([
      ["wtype", "--", "A"],
    ]);
    expect(yield* fake.replay({ type: "key", key: "F12", modifiers: [] })).toEqual([
      ["wtype", "-k", "F12"],
    ]);
    expect(yield* fake.replay({ type: "key", key: "Dead", modifiers: [] })).toEqual([]);
    expect(yield* fake.replay({ type: "text", text: "-rf now and then" })).toEqual([
      ["wtype", "--", "-rf now and then"],
    ]);
  }),
);

it.effect("a failed command is logged and later input still runs", () =>
  Effect.gen(function* () {
    const fake = yield* makeInput({ failing: "hyprctl" });
    expect(
      yield* fake.replay(
        { type: "pointer", action: "click", x: 0, y: 0, button: "left" },
        { type: "text", text: "still here" },
      ),
    ).toEqual([
      ["hyprctl", "dispatch", "movecursor", "-1920", "-200"],
      ["wtype", "--", "still here"],
    ]);
  }),
);
