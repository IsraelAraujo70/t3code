import {
  ComputerStreamServerMessage,
  type ComputerKeyInput,
  type ComputerPointerButton,
  type ComputerStreamInput,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export interface ComputerSize {
  readonly width: number;
  readonly height: number;
}

export interface ComputerPoint {
  readonly x: number;
  readonly y: number;
}

const RETRY_BASE_MS = 500;
const RETRY_MAX_MS = 10_000;

/** Wait before reconnect attempt `failures + 1`: doubles from half a second, capped at ten. */
export const computerStreamRetryDelayMs = (failures: number): number =>
  Math.min(RETRY_BASE_MS * 2 ** Math.max(0, failures), RETRY_MAX_MS);

const MAX_FRAME_WIDTH = 1920;

/** Frames twice the screen's physical width keep text sharp when zoomed, up to 1920 px. */
export const computerStreamMaxWidth = (screenWidth: number, pixelRatio: number): number =>
  Math.max(1, Math.min(MAX_FRAME_WIDTH, Math.round(screenWidth * pixelRatio * 2)));

const EDGE = 1e-6;
const clampFraction = (value: number) => Math.min(1, Math.max(0, value));

/**
 * Maps a point in the view to fractions of a frame drawn with `object-fit: contain`. Points in
 * the letterbox bands are outside the frame and map to null.
 */
export function computerFramePoint(
  view: ComputerSize,
  frame: ComputerSize,
  point: ComputerPoint,
): ComputerPoint | null {
  if (view.width <= 0 || view.height <= 0 || frame.width <= 0 || frame.height <= 0) return null;
  const scale = Math.min(view.width / frame.width, view.height / frame.height);
  const width = frame.width * scale;
  const height = frame.height * scale;
  const x = (point.x - (view.width - width) / 2) / width;
  const y = (point.y - (view.height - height) / 2) / height;
  // Rounding can put an edge point a hair outside the frame; the contract rejects that.
  const inside = (value: number) => value >= -EDGE && value <= 1 + EDGE;
  if (!inside(x) || !inside(y)) return null;
  return { x: clampFraction(x), y: clampFraction(y) };
}

/** Press and release at one point; the host turns it into a click. */
export const computerPress = (
  point: ComputerPoint,
  button: ComputerPointerButton,
): ReadonlyArray<ComputerStreamInput> => [
  { type: "pointer", action: "down", button, ...point },
  { type: "pointer", action: "up", button, ...point },
];

const MAX_WHEEL_NOTCHES = 20;

/**
 * Two-finger pans scroll like a touchpad: content follows the fingers, so dragging up scrolls
 * down. Returns whole notches to send and the pixels left over for the next update.
 */
export function computerWheelNotches(
  pendingPx: number,
  notchPx: number,
): { readonly notches: number; readonly remainderPx: number } {
  const whole = Math.trunc(pendingPx / notchPx);
  const notches = Math.max(-MAX_WHEEL_NOTCHES, Math.min(MAX_WHEEL_NOTCHES, whole));
  // `+ 0` turns a negative zero into zero.
  return { notches: -notches + 0, remainderPx: pendingPx - notches * notchPx };
}

/**
 * Throttles drag moves to one per `intervalMs`, latest point wins. A move inside the interval is
 * held and sent when the interval ends; `flush` sends a held move at once (before a release).
 */
export function createComputerMoveThrottle(options: {
  readonly intervalMs: number;
  readonly now: () => number;
  readonly schedule: (run: () => void, delayMs: number) => () => void;
  readonly send: (point: ComputerPoint) => void;
}) {
  let lastSentAt = Number.NEGATIVE_INFINITY;
  let held: ComputerPoint | null = null;
  let cancel: (() => void) | null = null;
  const sendHeld = () => {
    cancel = null;
    if (held === null) return;
    const point = held;
    held = null;
    lastSentAt = options.now();
    options.send(point);
  };
  return {
    push(point: ComputerPoint) {
      held = point;
      const wait = lastSentAt + options.intervalMs - options.now();
      if (wait <= 0) {
        cancel?.();
        sendHeld();
      } else if (cancel === null) {
        cancel = options.schedule(sendHeld, wait);
      }
    },
    flush() {
      cancel?.();
      sendHeld();
    },
    cancel() {
      cancel?.();
      cancel = null;
      held = null;
    },
  };
}

const MAX_TEXT_LENGTH = 1000;

/**
 * Input for an edit of the hidden text field: one Backspace per character removed after the
 * shared prefix, then the inserted text in chunks the contract accepts.
 */
export function computerTypingInputs(
  previous: string,
  next: string,
): ReadonlyArray<ComputerStreamInput> {
  const before = Array.from(previous);
  const after = Array.from(next);
  let shared = 0;
  while (shared < before.length && shared < after.length && before[shared] === after[shared]) {
    shared += 1;
  }
  const inputs: ComputerStreamInput[] = [];
  for (let index = shared; index < before.length; index += 1) {
    inputs.push({ type: "key", key: "Backspace", modifiers: [] });
  }
  const inserted = after.slice(shared);
  for (let start = 0; start < inserted.length; start += MAX_TEXT_LENGTH) {
    inputs.push({ type: "text", text: inserted.slice(start, start + MAX_TEXT_LENGTH).join("") });
  }
  return inputs;
}

export interface ComputerKeyBarKey {
  readonly label: string;
  readonly accessibilityLabel: string;
  readonly input: ComputerKeyInput;
}

const key = (
  label: string,
  accessibilityLabel: string,
  name: string,
  modifiers: ComputerKeyInput["modifiers"] = [],
): ComputerKeyBarKey => ({
  label,
  accessibilityLabel,
  input: { type: "key", key: name, modifiers },
});

/** Keys a phone keyboard lacks, in the order the key bar shows them. */
export const COMPUTER_KEY_BAR: ReadonlyArray<ComputerKeyBarKey> = [
  key("Esc", "Escape", "Escape"),
  key("Tab", "Tab", "Tab"),
  key("Ctrl+C", "Control C", "c", ["ctrl"]),
  key("Ctrl+V", "Control V", "v", ["ctrl"]),
  key("←", "Left arrow", "ArrowLeft"),
  key("↑", "Up arrow", "ArrowUp"),
  key("↓", "Down arrow", "ArrowDown"),
  key("→", "Right arrow", "ArrowRight"),
  key("Enter", "Enter", "Enter"),
];

/** What the viewer document in the WebView posts to the screen. */
export type ComputerDocumentMessage =
  /** The script is loaded and waits for `connect(url)`. */
  | { readonly type: "ready" }
  /** A server text message, passed through unparsed. */
  | { readonly type: "server"; readonly text: string }
  /** The first frame of the current connection is on screen. */
  | { readonly type: "frame" }
  /** The socket closed or never opened; the screen schedules the reconnect. */
  | { readonly type: "closed" }
  | { readonly type: "failed" };

const ComputerDocumentMessageSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literals(["ready", "frame", "closed", "failed"]) }),
  Schema.Struct({ type: Schema.Literal("server"), text: Schema.String }),
]);

const decodeDocumentMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(ComputerDocumentMessageSchema),
);

export const parseComputerDocumentMessage = (data: string): ComputerDocumentMessage | null =>
  Option.getOrNull(decodeDocumentMessage(data));

const decodeServerMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(ComputerStreamServerMessage),
);

/** A text frame from the Computer stream, or null when it is not one the contract defines. */
export const parseComputerStreamMessage = (text: string): ComputerStreamServerMessage | null =>
  Option.getOrNull(decodeServerMessage(text));
