import {
  ComputerStreamServerMessage,
  type ComputerKeyModifier,
  type ComputerPointerButton,
  type ComputerPointerInput,
  type ComputerStreamInput,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 10_000;

/** Wait before reconnect attempt `failures + 1`: doubles from half a second, capped at ten. */
export const computerStreamRetryDelayMs = (failures: number): number =>
  Math.min(RETRY_BASE_MS * 2 ** Math.max(0, failures), RETRY_MAX_MS);

const decodeServerMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(ComputerStreamServerMessage),
);

/** A text frame from the Computer stream, or null when it is not one the contract defines. */
export const parseComputerStreamMessage = (text: string): ComputerStreamServerMessage | null =>
  Option.getOrNull(decodeServerMessage(text));

interface Box {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

interface Size {
  readonly width: number;
  readonly height: number;
}

const clampUnit = (value: number) => Math.min(1, Math.max(0, value));

/**
 * Where a client point falls on a frame drawn with `object-fit: contain` inside `box`, as
 * fractions of the frame. Points in the letterbox are null, unless `clamp` pins them to the
 * nearest edge (a drag that leaves the picture still has to release somewhere).
 */
export function frameFractionAt(
  box: Box,
  frame: Size,
  clientX: number,
  clientY: number,
  options?: { readonly clamp?: boolean },
): { readonly x: number; readonly y: number } | null {
  if (box.width <= 0 || box.height <= 0 || frame.width <= 0 || frame.height <= 0) return null;
  const scale = Math.min(box.width / frame.width, box.height / frame.height);
  const drawnWidth = frame.width * scale;
  const drawnHeight = frame.height * scale;
  const x = (clientX - box.left - (box.width - drawnWidth) / 2) / drawnWidth;
  const y = (clientY - box.top - (box.height - drawnHeight) / 2) / drawnHeight;
  if (options?.clamp) return { x: clampUnit(x), y: clampUnit(y) };
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
}

/** The contract's button for a DOM `PointerEvent.button`; back/forward buttons have none. */
export function pointerButton(button: number): ComputerPointerButton | null {
  if (button === 0) return "left";
  if (button === 1) return "middle";
  if (button === 2) return "right";
  return null;
}

const WHEEL_MAX_NOTCHES = 20;
const PIXELS_PER_NOTCH = 100;
const LINES_PER_NOTCH = 3;
const NOTCHES_PER_PAGE = 10;

/** Scroll not yet sent, in fractional notches. */
export interface WheelRemainder {
  readonly x: number;
  readonly y: number;
}

export const EMPTY_WHEEL_REMAINDER: WheelRemainder = { x: 0, y: 0 };

/**
 * Adds one DOM wheel event to the unsent remainder and splits off whole notches to send.
 * Touchpads send many small pixel deltas, so they add up across events. Notches beyond the
 * contract's range are dropped.
 */
export function accumulateWheel(
  remainder: WheelRemainder,
  event: { readonly deltaX: number; readonly deltaY: number; readonly deltaMode: number },
): { readonly remainder: WheelRemainder; readonly deltaX: number; readonly deltaY: number } {
  const perNotch =
    event.deltaMode === 1
      ? 1 / LINES_PER_NOTCH
      : event.deltaMode === 2
        ? NOTCHES_PER_PAGE
        : 1 / PIXELS_PER_NOTCH;
  const totalX = remainder.x + event.deltaX * perNotch;
  const totalY = remainder.y + event.deltaY * perNotch;
  const wholeX = Math.trunc(totalX);
  const wholeY = Math.trunc(totalY);
  const clampNotches = (value: number) =>
    Math.min(WHEEL_MAX_NOTCHES, Math.max(-WHEEL_MAX_NOTCHES, value)) || 0;
  return {
    remainder: { x: totalX - wholeX || 0, y: totalY - wholeY || 0 },
    deltaX: clampNotches(wholeX),
    deltaY: clampNotches(wholeY),
  };
}

const IGNORED_KEYS = new Set([
  "Alt",
  "AltGraph",
  "CapsLock",
  "Control",
  "Dead",
  "Fn",
  "FnLock",
  "Hyper",
  "Meta",
  "NumLock",
  "OS",
  "Process",
  "ScrollLock",
  "Shift",
  "Super",
  "Symbol",
  "SymbolLock",
  "Unidentified",
]);

const KEY_MAX_LENGTH = 32;

/**
 * The input for one `keydown` while in control, or null for keys that send nothing on their own
 * (modifiers, dead keys, IME composition). A printable character without Ctrl, Alt or Meta is
 * text, so the host types it under its own layout; everything else is a key with modifiers.
 */
export function keyboardInput(event: {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
  readonly isComposing: boolean;
}): ComputerStreamInput | null {
  if (event.isComposing || IGNORED_KEYS.has(event.key)) return null;
  if (event.key.length === 0 || event.key.length > KEY_MAX_LENGTH) return null;
  const printable = [...event.key].length === 1;
  if (printable && !event.ctrlKey && !event.altKey && !event.metaKey) {
    return { type: "text", text: event.key };
  }
  const modifiers: ComputerKeyModifier[] = [];
  if (event.ctrlKey) modifiers.push("ctrl");
  if (event.altKey) modifiers.push("alt");
  if (event.shiftKey) modifiers.push("shift");
  if (event.metaKey) modifiers.push("meta");
  return { type: "key", key: event.key, modifiers };
}

const TEXT_MAX_LENGTH = 1000;

/**
 * Pasted or composed text as `text` inputs within the contract's length, split on code points so
 * no surrogate pair is cut. Windows line endings become plain newlines.
 */
export function textInputs(text: string): ComputerStreamInput[] {
  const characters = [...text.replaceAll("\r\n", "\n")];
  const inputs: ComputerStreamInput[] = [];
  let chunk = "";
  for (const character of characters) {
    if (chunk.length + character.length > TEXT_MAX_LENGTH) {
      inputs.push({ type: "text", text: chunk });
      chunk = "";
    }
    chunk += character;
  }
  if (chunk.length > 0) inputs.push({ type: "text", text: chunk });
  return inputs;
}

export interface ComputerInputPump {
  /** Sends now, after any batched move or text, so the host sees events in order. */
  readonly send: (input: ComputerStreamInput) => void;
  /** Sends at the next frame; a later move in the same frame replaces it. */
  readonly move: (input: ComputerPointerInput) => void;
  /** Appends typed text, sent as one input at the next frame. */
  readonly type: (text: string) => void;
  /** Drops anything still batched. */
  readonly dispose: () => void;
}

/**
 * Batches pointer moves (latest wins) and typed characters to one send per `schedule`d frame
 * while keeping their order with everything sent immediately.
 */
export function createComputerInputPump(
  sink: (input: ComputerStreamInput) => void,
  schedule: (flush: () => void) => () => void,
): ComputerInputPump {
  let pendingMove: ComputerPointerInput | null = null;
  let pendingText = "";
  let cancelScheduled: (() => void) | null = null;

  const flush = () => {
    cancelScheduled?.();
    cancelScheduled = null;
    // Only one of the two is ever pending: queueing either flushes the other first.
    if (pendingMove !== null) sink(pendingMove);
    for (const input of textInputs(pendingText)) sink(input);
    pendingMove = null;
    pendingText = "";
  };
  const ensureScheduled = () => {
    cancelScheduled ??= schedule(() => {
      cancelScheduled = null;
      flush();
    });
  };

  return {
    send: (input) => {
      flush();
      sink(input);
    },
    move: (input) => {
      if (pendingText.length > 0) flush();
      pendingMove = input;
      ensureScheduled();
    },
    type: (text) => {
      if (pendingMove !== null) flush();
      pendingText += text;
      ensureScheduled();
    },
    dispose: () => {
      cancelScheduled?.();
      cancelScheduled = null;
      pendingMove = null;
      pendingText = "";
    },
  };
}
