// @effect-diagnostics nodeBuiltinImport:off - reads the runtime and X11 socket directories to pick the session.
/**
 * The Computer view on an X11 display, such as a headless host's Xvfb, instead of Hyprland.
 * `ScreenCapture` and `ComputerInput` keep building their Hyprland commands; on X11 each one is
 * translated here at the boundary: `hyprctl monitors` becomes `xwininfo -root`, `grim` becomes one
 * `ffmpeg -f x11grab` frame, and cursor, button, wheel and key commands become `xdotool`.
 */
import * as NodeFS from "node:fs";

const X11_SOCKET_DIR = "/tmp/.X11-unix";

const listNames = (directory: string) => {
  try {
    return NodeFS.readdirSync(directory);
  } catch {
    return [];
  }
};

/**
 * The X display to drive, or `undefined` while a Wayland session exists. A host with both keeps
 * using Hyprland; a host with no Wayland socket uses `$DISPLAY`, else the lowest X socket.
 */
export const x11Display = (
  source: NodeJS.ProcessEnv,
  runtimeDir: string,
  list: (directory: string) => ReadonlyArray<string> = listNames,
): string | undefined => {
  if (source.WAYLAND_DISPLAY) return undefined;
  if (list(runtimeDir).some((name) => /^wayland-\d+$/.test(name))) return undefined;
  if (source.DISPLAY) return source.DISPLAY;
  const displays = list(X11_SOCKET_DIR)
    .map((name) => /^X(\d+)$/.exec(name)?.[1])
    .filter((value) => value !== undefined)
    .map(Number)
    .toSorted((a, b) => a - b);
  return displays.length === 0 ? undefined : `:${displays[0]}`;
};

/** `xwininfo -root` as the one-monitor `hyprctl monitors -j` JSON that `parseGeometry` reads. */
export const monitorsFromXwininfo = (stdout: string): string | undefined => {
  const width = /^\s*Width:\s*(\d+)/m.exec(stdout)?.[1];
  const height = /^\s*Height:\s*(\d+)/m.exec(stdout)?.[1];
  if (width === undefined || height === undefined) return undefined;
  return JSON.stringify([{ x: 0, y: 0, width: Number(width), height: Number(height), scale: 1 }]);
};

const flagValue = (args: ReadonlyArray<string>, flag: string) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};

/**
 * `ffmpeg` arguments that write one JPEG of the whole display to stdout, for the `grim` arguments
 * `-t jpeg -q <0-100> -s <scale> -`. grim's quality maps onto mjpeg's 2 (best) to 31 scale.
 */
export const ffmpegArgs = (grimArgs: ReadonlyArray<string>, display: string) => {
  const quality = Math.min(Math.max(Number(flagValue(grimArgs, "-q") ?? 80), 0), 100);
  const scale = Number(flagValue(grimArgs, "-s") ?? 1);
  const qscale = Math.round(31 - (quality / 100) * 29);
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "x11grab",
    "-draw_mouse",
    "1",
    "-i",
    display,
    "-frames:v",
    "1",
    // Even dimensions keep the mjpeg encoder's chroma subsampling happy.
    ...(scale === 1 ? [] : ["-vf", `scale=round(iw*${scale}/2)*2:-2`]),
    "-q:v",
    String(qscale),
    "-f",
    "mjpeg",
    "-",
  ];
};

// ydotool's button codes (left, right, middle) as X buttons.
const X_BUTTONS: Record<number, string> = { 0: "1", 1: "3", 2: "2" };
const XDOTOOL_MODIFIERS: Record<string, string> = {
  ctrl: "ctrl",
  alt: "alt",
  shift: "shift",
  logo: "super",
};

const wheelClicks = (button: string, notches: number) =>
  notches === 0 ? [] : ["click", "--repeat", String(Math.abs(notches)), button];

/**
 * The `xdotool` arguments for one Hyprland-session input command, or `undefined` when it has no
 * X11 meaning. Commands are the ones `ComputerInput` builds: `hyprctl dispatch` cursor moves,
 * `ydotool click` and `mousemove --wheel`, and `wtype` keys and text.
 */
export const xdotoolArgs = (
  command: "hyprctl" | "ydotool" | "wtype",
  args: ReadonlyArray<string>,
): ReadonlyArray<string> | undefined => {
  switch (command) {
    case "hyprctl": {
      if (args[0] !== "dispatch") return undefined;
      const legacy = args[1] === "movecursor" ? [args[2], args[3]] : undefined;
      const lua = /x = (-?\d+), y = (-?\d+)/.exec(args[1] ?? "");
      const [x, y] = legacy ?? [lua?.[1], lua?.[2]];
      return x === undefined || y === undefined ? undefined : ["mousemove", "--", x, y];
    }
    case "ydotool": {
      if (args[0] === "click") {
        const code = Number.parseInt(args[1] ?? "", 16);
        const button = X_BUTTONS[code & 0x0f];
        if (Number.isNaN(code) || button === undefined) return undefined;
        const press = (code & 0x40) !== 0;
        const release = (code & 0x80) !== 0;
        return [press && release ? "click" : press ? "mousedown" : "mouseup", button];
      }
      if (args[0] === "mousemove" && args.includes("--wheel")) {
        // ydotool's positive -y scrolls up (X button 4), positive -x right (button 7).
        const dx = Number(flagValue(args, "-x") ?? 0);
        const dy = Number(flagValue(args, "-y") ?? 0);
        const clicks = [
          ...wheelClicks(dy > 0 ? "4" : "5", dy),
          ...wheelClicks(dx > 0 ? "7" : "6", dx),
        ];
        return clicks.length === 0 ? undefined : clicks;
      }
      return undefined;
    }
    case "wtype": {
      if (args[0] === "--") return ["type", "--", args.slice(1).join(" ")];
      const modifiers: Array<string> = [];
      let keysym: string | undefined;
      for (let index = 0; index < args.length; index += 2) {
        const value = args[index + 1];
        if (value === undefined) break;
        if (args[index] === "-M") modifiers.push(XDOTOOL_MODIFIERS[value] ?? value);
        if (args[index] === "-k") keysym = value;
      }
      return keysym === undefined ? undefined : ["key", "--", [...modifiers, keysym].join("+")];
    }
  }
};
