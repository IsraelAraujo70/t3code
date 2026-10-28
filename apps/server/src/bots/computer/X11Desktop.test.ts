import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as ComputerInput from "./ComputerInput.ts";
import * as ScreenCapture from "./ScreenCapture.ts";
import * as X11Desktop from "./X11Desktop.ts";

const dirs =
  (entries: Record<string, ReadonlyArray<string>>) =>
  (directory: string): ReadonlyArray<string> =>
    entries[directory] ?? [];

it("drives X11 only when no Wayland session exists", () => {
  const runtime = "/run/user/1000";
  const xvfb = dirs({ "/tmp/.X11-unix": ["X99", "X100"] });
  expect(X11Desktop.x11Display({}, runtime, xvfb)).toBe(":99");
  expect(X11Desktop.x11Display({ DISPLAY: ":5" }, runtime, xvfb)).toBe(":5");
  expect(X11Desktop.x11Display({ WAYLAND_DISPLAY: "wayland-1" }, runtime, xvfb)).toBeUndefined();
  const hyprland = dirs({ [runtime]: ["wayland-1", "hypr"], "/tmp/.X11-unix": ["X0"] });
  expect(X11Desktop.x11Display({}, runtime, hyprland)).toBeUndefined();
  expect(X11Desktop.x11Display({}, runtime, dirs({}))).toBeUndefined();
});

it.effect("reads the X screen as one monitor the capture service can size", () =>
  Effect.gen(function* () {
    const stdout = "xwininfo: Window id: 0x3b9 (the root window)\n  Width: 1920\n  Height: 1080\n";
    const json = X11Desktop.monitorsFromXwininfo(stdout);
    expect(json).toBeDefined();
    expect(yield* ScreenCapture.parseGeometry(json ?? "")).toEqual({
      left: 0,
      top: 0,
      width: 1920,
      height: 1080,
      maxScale: 1,
    });
    expect(X11Desktop.monitorsFromXwininfo("xwininfo: error")).toBeUndefined();
  }),
);

it("grabs one scaled JPEG frame with the requested quality", () => {
  const args = X11Desktop.ffmpegArgs(["-t", "jpeg", "-q", "70", "-s", "0.6667", "-"], ":99");
  expect(args).toContain("x11grab");
  expect(args.slice(args.indexOf("-i"), args.indexOf("-i") + 2)).toEqual(["-i", ":99"]);
  expect(args).toContain("scale=round(iw*0.6667/2)*2:-2");
  expect(args.slice(args.indexOf("-q:v"), args.indexOf("-q:v") + 2)).toEqual(["-q:v", "11"]);
  expect(args.at(-1)).toBe("-");
  expect(X11Desktop.ffmpegArgs(["-t", "jpeg", "-q", "100", "-s", "1", "-"], ":0")).not.toContain(
    "-vf",
  );
});

it("replays the input service's commands with xdotool", () => {
  const point = { x: 640, y: 360 };
  expect(X11Desktop.xdotoolArgs("hyprctl", ComputerInput.moveCursorArgs("lua", point))).toEqual([
    "mousemove",
    "--",
    "640",
    "360",
  ]);
  expect(X11Desktop.xdotoolArgs("hyprctl", ComputerInput.moveCursorArgs("legacy", point))).toEqual([
    "mousemove",
    "--",
    "640",
    "360",
  ]);
  expect(
    X11Desktop.xdotoolArgs("ydotool", ["click", ComputerInput.clickCode("left", "click")]),
  ).toEqual(["click", "1"]);
  expect(
    X11Desktop.xdotoolArgs("ydotool", ["click", ComputerInput.clickCode("right", "down")]),
  ).toEqual(["mousedown", "3"]);
  expect(
    X11Desktop.xdotoolArgs("ydotool", ["click", ComputerInput.clickCode("middle", "up")]),
  ).toEqual(["mouseup", "2"]);
  // The input service sends -y as -deltaY, so a positive contract deltaY (down) arrives negative.
  expect(
    X11Desktop.xdotoolArgs("ydotool", ["mousemove", "--wheel", "-x", "0", "-y", "-3"]),
  ).toEqual(["click", "--repeat", "3", "5"]);
  expect(X11Desktop.xdotoolArgs("ydotool", ["mousemove", "--wheel", "-x", "2", "-y", "1"])).toEqual(
    ["click", "--repeat", "1", "4", "click", "--repeat", "2", "7"],
  );
  expect(X11Desktop.xdotoolArgs("wtype", ["--", "olá mundo"])).toEqual(["type", "--", "olá mundo"]);
  const chord = ComputerInput.wtypeKeyArgs({ type: "key", key: "c", modifiers: ["ctrl", "meta"] });
  expect(X11Desktop.xdotoolArgs("wtype", chord ?? [])).toEqual(["key", "--", "ctrl+super+c"]);
  const enter = ComputerInput.wtypeKeyArgs({ type: "key", key: "Enter", modifiers: [] });
  expect(X11Desktop.xdotoolArgs("wtype", enter ?? [])).toEqual(["key", "--", "Return"]);
  expect(X11Desktop.xdotoolArgs("hyprctl", ["monitors", "-j"])).toBeUndefined();
});
