/**
 * Replays a Computer viewer's pointer, wheel and keyboard input on the bots host. The cursor is
 * placed with `hyprctl dispatch` (exact, unlike ydotool's accelerated moves), buttons
 * and the wheel go through `ydotool`, and keys and text through `wtype`.
 */
import type {
  ComputerKeyInput,
  ComputerKeyModifier,
  ComputerPointerButton,
  ComputerStreamInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ScreenCapture from "./ScreenCapture.ts";

const COMMAND_TIMEOUT_MS = 2000;

export class ComputerInputError extends Schema.TaggedError<ComputerInputError>()(
  "ComputerInputError",
  { message: Schema.String },
) {}

/** Runs one input command (`hyprctl`, `ydotool` or `wtype`); injectable so tests send no input. */
export type InputCommandRunner = (
  command: "hyprctl" | "ydotool" | "wtype",
  args: ReadonlyArray<string>,
) => Effect.Effect<void, ComputerInputError>;

export class ComputerInput extends Context.Service<
  ComputerInput,
  {
    /**
     * Replays one input. Inputs run one at a time across every viewer, so a click's move and
     * press stay in order. Failures are logged, never raised.
     */
    readonly replay: (input: ComputerStreamInput) => Effect.Effect<void>;
  }
>()("t3/bots/computer/ComputerInput") {}

/** The compositor pixel under a frame fraction, kept inside the captured box. */
export const screenPoint = (geometry: ScreenCapture.ScreenGeometry, x: number, y: number) => ({
  x: geometry.left + Math.min(Math.max(Math.round(x * geometry.width), 0), geometry.width - 1),
  y: geometry.top + Math.min(Math.max(Math.round(y * geometry.height), 0), geometry.height - 1),
});

const BUTTON_CODES: Record<ComputerPointerButton, number> = {
  left: 0x00,
  right: 0x01,
  middle: 0x02,
};
const PRESS = 0x40;
const RELEASE = 0x80;

/** The `ydotool click` argument for a button press, release, or both. */
export const clickCode = (button: ComputerPointerButton, action: "down" | "up" | "click") => {
  const flags = action === "down" ? PRESS : action === "up" ? RELEASE : PRESS | RELEASE;
  return `0x${(BUTTON_CODES[button] | flags).toString(16).toUpperCase().padStart(2, "0")}`;
};

const WTYPE_MODIFIERS: Record<ComputerKeyModifier, string> = {
  ctrl: "ctrl",
  alt: "alt",
  shift: "shift",
  meta: "logo",
};

const NAMED_KEYS: Record<string, string> = {
  Enter: "Return",
  Backspace: "BackSpace",
  Tab: "Tab",
  Escape: "Escape",
  Delete: "Delete",
  Home: "Home",
  End: "End",
  PageUp: "Prior",
  PageDown: "Next",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  ArrowUp: "Up",
  ArrowDown: "Down",
  Insert: "Insert",
  " ": "space",
};

/** The xkb keysym for a single character typed with modifiers held. */
const characterKeysym = (character: string) => {
  const lower = character.toLowerCase();
  if (/^[a-z0-9]$/.test(lower)) return lower;
  const codePoint = lower.codePointAt(0) ?? 0;
  // Latin-1 keysyms equal their code point; xkb accepts every other character as U<hex>.
  return codePoint <= 0xff
    ? `0x${codePoint.toString(16)}`
    : `U${codePoint.toString(16).toUpperCase()}`;
};

/**
 * The `wtype` arguments for one key press, or `undefined` for a key the host does not know.
 * A printable character with at most Shift held is typed as literal text, so the layout decides
 * what Shift produces.
 */
export const wtypeKeyArgs = (input: ComputerKeyInput): ReadonlyArray<string> | undefined => {
  const modifiers = [...new Set(input.modifiers)];
  const isCharacter = [...input.key].length === 1;
  if (isCharacter && input.key !== " " && modifiers.every((modifier) => modifier === "shift")) {
    return ["--", input.key];
  }
  const keysym =
    NAMED_KEYS[input.key] ??
    (/^F([1-9]|1\d|2[0-4])$/.test(input.key) ? input.key : undefined) ??
    (isCharacter ? characterKeysym(input.key) : undefined);
  if (keysym === undefined) return undefined;
  const names = modifiers.map((modifier) => WTYPE_MODIFIERS[modifier]);
  return [
    ...names.flatMap((name) => ["-M", name]),
    "-k",
    keysym,
    ...names.toReversed().flatMap((name) => ["-m", name]),
  ];
};

type MoveCursorSyntax = "lua" | "legacy";

/** `hyprctl` arguments that put the cursor on a compositor pixel. */
export const moveCursorArgs = (
  syntax: MoveCursorSyntax,
  point: { readonly x: number; readonly y: number },
) =>
  syntax === "lua"
    ? ["dispatch", `hl.dsp.cursor.move({ x = ${point.x}, y = ${point.y} })`]
    : ["dispatch", "movecursor", String(point.x), String(point.y)];

/** Builds the input service on the capture service's geometry. */
export const make = (runCommand: InputCommandRunner) =>
  Effect.gen(function* () {
    const screen = yield* ScreenCapture.ScreenCapture;
    const lock = yield* Semaphore.make(1);

    // Hyprland 0.55+ with a Lua config only takes Lua dispatchers; older ones only the legacy
    // `movecursor x y`. The first form that works is kept for the life of the server.
    let dispatchSyntax: MoveCursorSyntax | undefined;
    const moveTo = (x: number, y: number) =>
      screen.geometry.pipe(
        Effect.mapError((error) => new ComputerInputError({ message: error.message })),
        Effect.flatMap((geometry) => {
          const point = screenPoint(geometry, x, y);
          const run = (syntax: MoveCursorSyntax) =>
            runCommand("hyprctl", moveCursorArgs(syntax, point)).pipe(
              Effect.tap(() => Effect.sync(() => (dispatchSyntax = syntax))),
            );
          if (dispatchSyntax !== undefined) return run(dispatchSyntax);
          return run("lua").pipe(Effect.catch(() => run("legacy")));
        }),
      );

    const replayOne = (input: ComputerStreamInput) => {
      switch (input.type) {
        case "pointer":
          return moveTo(input.x, input.y).pipe(
            Effect.andThen(
              input.action === "move"
                ? Effect.void
                : runCommand("ydotool", ["click", clickCode(input.button, input.action)]),
            ),
          );
        case "wheel":
          return moveTo(input.x, input.y).pipe(
            Effect.andThen(
              input.deltaX === 0 && input.deltaY === 0
                ? Effect.void
                : // A positive wheel value scrolls up on Linux; the contract's positive deltaY scrolls down.
                  runCommand("ydotool", [
                    "mousemove",
                    "--wheel",
                    "-x",
                    String(input.deltaX),
                    "-y",
                    String(-input.deltaY),
                  ]),
            ),
          );
        case "key": {
          const args = wtypeKeyArgs(input);
          return args === undefined
            ? Effect.logDebug("computer input ignored an unknown key", { key: input.key })
            : runCommand("wtype", args);
        }
        case "text":
          // One argument, not stdin: wtype's stdin mode corrupts Hyprland's keymap refresh.
          return runCommand("wtype", ["--", input.text]);
      }
    };

    return ComputerInput.of({
      replay: (input) =>
        lock
          .withPermits(1)(replayOne(input))
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("computer input failed", {
                input: input.type,
                error: error.message,
              }),
            ),
          ),
    });
  });

/** The real commands. The session environment is refreshed after a failure. */
export const desktopRunner = (): InputCommandRunner => {
  let env: Record<string, string> | undefined;
  return (command, args) =>
    Effect.suspend(() => {
      env ??= ScreenCapture.desktopEnv();
      return ScreenCapture.runDesktopCommand(command, args, env, COMMAND_TIMEOUT_MS);
    }).pipe(
      Effect.asVoid,
      Effect.mapError((error) => {
        env = undefined;
        return new ComputerInputError({ message: error.message });
      }),
    );
};

export const layer = Layer.effect(
  ComputerInput,
  Effect.suspend(() => make(desktopRunner())),
);
