import type { ComputerPointerButton, ComputerStreamInput } from "@t3tools/contracts";
import { type RefObject, useEffect } from "react";

import {
  EMPTY_WHEEL_REMAINDER,
  accumulateWheel,
  createComputerInputPump,
  frameFractionAt,
  keyboardInput,
  pointerButton,
} from "./computerStream.logic";

/** `PointerEvent.buttons` bit for each `PointerEvent.button`. */
const BUTTON_BITS: Record<number, number> = { 0: 1, 1: 4, 2: 2 };

/**
 * While `active`, the stream element `target` turns pointer, wheel and keyboard events into
 * host input and keeps focus so Escape and Tab reach the host too. Focus leaving `root` calls
 * `onLeave`. Buttons still held when control ends are released on the host.
 */
export function useComputerControl(options: {
  readonly active: boolean;
  readonly root: RefObject<HTMLElement | null>;
  readonly target: RefObject<HTMLElement | null>;
  readonly canvas: RefObject<HTMLCanvasElement | null>;
  readonly send: (input: ComputerStreamInput) => void;
  readonly onLeave: () => void;
}) {
  const { active, root, target, canvas, send, onLeave } = options;

  useEffect(() => {
    const element = target.current;
    const frame = canvas.current;
    if (!active || element === null || frame === null) return;

    const pump = createComputerInputPump(send, (flush) => {
      const id = requestAnimationFrame(flush);
      return () => cancelAnimationFrame(id);
    });
    const held = new Map<number, ComputerPointerButton>();
    let lastPoint = { x: 0.5, y: 0.5 };
    let wheelRemainder = EMPTY_WHEEL_REMAINDER;

    const pointAt = (event: MouseEvent, clamp: boolean) =>
      frameFractionAt(
        frame.getBoundingClientRect(),
        { width: frame.width, height: frame.height },
        event.clientX,
        event.clientY,
        { clamp },
      );
    const release = (domButton: number) => {
      const button = held.get(domButton);
      if (button === undefined) return;
      held.delete(domButton);
      pump.send({ type: "pointer", action: "up", ...lastPoint, button });
    };
    // Chorded buttons report their release as a move, so compare against what is still down.
    const releaseLifted = (buttons: number) => {
      for (const domButton of held.keys()) {
        if ((buttons & (BUTTON_BITS[domButton] ?? 0)) === 0) release(domButton);
      }
    };

    const onPointerDown = (event: PointerEvent) => {
      const button = pointerButton(event.button);
      if (button === null) return;
      const point = pointAt(event, false);
      if (point === null) return;
      event.preventDefault();
      element.setPointerCapture(event.pointerId);
      lastPoint = point;
      held.set(event.button, button);
      pump.send({ type: "pointer", action: "down", ...point, button });
    };
    const onPointerMove = (event: PointerEvent) => {
      const dragging = held.values().next().value;
      const point = pointAt(event, dragging !== undefined);
      if (point === null) return;
      lastPoint = point;
      pump.move({ type: "pointer", action: "move", ...point, button: dragging ?? "left" });
      releaseLifted(event.buttons);
    };
    const onPointerUp = (event: PointerEvent) => {
      const point = pointAt(event, true);
      if (point !== null) lastPoint = point;
      release(event.button);
      releaseLifted(event.buttons);
    };
    const onPointerCancel = () => releaseLifted(0);
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const point = pointAt(event, false);
      if (point === null) return;
      const notches = accumulateWheel(wheelRemainder, event);
      wheelRemainder = notches.remainder;
      if (notches.deltaX === 0 && notches.deltaY === 0) return;
      pump.send({ type: "wheel", ...point, deltaX: notches.deltaX, deltaY: notches.deltaY });
    };
    const onContextMenu = (event: MouseEvent) => event.preventDefault();
    const onKeyDown = (event: KeyboardEvent) => {
      // Composition keydowns belong to the IME; its result arrives as `compositionend`.
      if (event.isComposing) return;
      event.preventDefault();
      const input = keyboardInput(event);
      if (input === null) return;
      if (input.type === "text") pump.type(input.text);
      else pump.send(input);
    };
    const onCompositionEnd = (event: CompositionEvent) => {
      if (event.data.length > 0) pump.type(event.data);
    };
    const onPaste = (event: ClipboardEvent) => {
      event.preventDefault();
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (text.length > 0) pump.type(text);
    };
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget;
      // The Control toggle lives in the panel; clicking it must not leave control first.
      if (next instanceof Node && root.current?.contains(next)) return;
      onLeave();
    };

    element.addEventListener("pointerdown", onPointerDown);
    element.addEventListener("pointermove", onPointerMove);
    element.addEventListener("pointerup", onPointerUp);
    element.addEventListener("pointercancel", onPointerCancel);
    element.addEventListener("wheel", onWheel, { passive: false });
    element.addEventListener("contextmenu", onContextMenu);
    element.addEventListener("keydown", onKeyDown);
    element.addEventListener("compositionend", onCompositionEnd);
    element.addEventListener("paste", onPaste);
    element.addEventListener("focusout", onFocusOut);
    element.focus();

    return () => {
      element.removeEventListener("pointerdown", onPointerDown);
      element.removeEventListener("pointermove", onPointerMove);
      element.removeEventListener("pointerup", onPointerUp);
      element.removeEventListener("pointercancel", onPointerCancel);
      element.removeEventListener("wheel", onWheel);
      element.removeEventListener("contextmenu", onContextMenu);
      element.removeEventListener("keydown", onKeyDown);
      element.removeEventListener("compositionend", onCompositionEnd);
      element.removeEventListener("paste", onPaste);
      element.removeEventListener("focusout", onFocusOut);
      releaseLifted(0);
      pump.dispose();
    };
  }, [active, root, target, canvas, send, onLeave]);
}
