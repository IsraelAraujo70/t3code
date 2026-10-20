import { describe, expect, it } from "vite-plus/test";

import type { ComputerStreamInput } from "@t3tools/contracts";

import {
  EMPTY_WHEEL_REMAINDER,
  accumulateWheel,
  computerStreamRetryDelayMs,
  createComputerInputPump,
  frameFractionAt,
  keyboardInput,
  parseComputerStreamMessage,
  textInputs,
} from "./computerStream.logic";

describe("computerStreamRetryDelayMs", () => {
  it("backs off exponentially and stops growing at ten seconds", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map(computerStreamRetryDelayMs)).toEqual([
      500, 1_000, 2_000, 4_000, 8_000, 10_000, 10_000, 10_000,
    ]);
  });
});

describe("parseComputerStreamMessage", () => {
  it("reads the access, info and error messages", () => {
    expect(
      parseComputerStreamMessage(JSON.stringify({ type: "access", canControl: true })),
    ).toEqual({ type: "access", canControl: true });
    expect(
      parseComputerStreamMessage(
        JSON.stringify({
          type: "info",
          width: 1280,
          height: 800,
          screenWidth: 2560,
          screenHeight: 1600,
        }),
      ),
    ).toEqual({ type: "info", width: 1280, height: 800, screenWidth: 2560, screenHeight: 1600 });
    expect(
      parseComputerStreamMessage(JSON.stringify({ type: "error", message: "No screen." })),
    ).toEqual({ type: "error", message: "No screen." });
  });

  it("ignores malformed and unknown messages", () => {
    expect(parseComputerStreamMessage("not json")).toBeNull();
    expect(parseComputerStreamMessage(JSON.stringify({ type: "info", width: 1 }))).toBeNull();
    expect(parseComputerStreamMessage(JSON.stringify({ type: "ack" }))).toBeNull();
  });
});

describe("frameFractionAt", () => {
  const box = { left: 100, top: 50, width: 400, height: 400 };

  it("maps through the side bars of a frame wider than the box", () => {
    // 16:9 in a square box: drawn 400 × 225, centred with 87.5px bars above and below.
    const frame = { width: 1600, height: 900 };
    expect(frameFractionAt(box, frame, 100, 137.5)).toEqual({ x: 0, y: 0 });
    expect(frameFractionAt(box, frame, 300, 250)).toEqual({ x: 0.5, y: 0.5 });
    expect(frameFractionAt(box, frame, 500, 362.5)).toEqual({ x: 1, y: 1 });
    expect(frameFractionAt(box, frame, 300, 100)).toBeNull();
    expect(frameFractionAt(box, frame, 300, 400)).toBeNull();
  });

  it("maps through the side bars of a frame taller than the box", () => {
    // 1:2 in a square box: drawn 200 × 400, 100px bars left and right.
    const frame = { width: 500, height: 1000 };
    expect(frameFractionAt(box, frame, 250, 150)).toEqual({ x: 0.25, y: 0.25 });
    expect(frameFractionAt(box, frame, 150, 250)).toBeNull();
    expect(frameFractionAt(box, frame, 450, 250)).toBeNull();
  });

  it("pins letterbox points to the nearest edge when clamping", () => {
    const frame = { width: 500, height: 1000 };
    expect(frameFractionAt(box, frame, 150, 250, { clamp: true })).toEqual({ x: 0, y: 0.5 });
    expect(frameFractionAt(box, frame, 600, 0, { clamp: true })).toEqual({ x: 1, y: 0 });
  });

  it("has no point before the first frame or in an empty box", () => {
    expect(frameFractionAt(box, { width: 0, height: 0 }, 300, 250)).toBeNull();
    expect(frameFractionAt({ ...box, width: 0 }, { width: 10, height: 10 }, 100, 50)).toBeNull();
  });
});

describe("accumulateWheel", () => {
  it("adds small touchpad deltas up to whole notches and keeps the rest", () => {
    let remainder = EMPTY_WHEEL_REMAINDER;
    const sent: number[] = [];
    for (const deltaY of [40, 40, 40, 40, 40]) {
      const result = accumulateWheel(remainder, { deltaX: 0, deltaY, deltaMode: 0 });
      remainder = result.remainder;
      sent.push(result.deltaY);
    }
    expect(sent).toEqual([0, 0, 1, 0, 1]);
    expect(remainder.y).toBeCloseTo(0);
  });

  it("scrolls both ways and converts lines and pages", () => {
    expect(
      accumulateWheel(EMPTY_WHEEL_REMAINDER, { deltaX: -200, deltaY: -100, deltaMode: 0 }),
    ).toMatchObject({ deltaX: -2, deltaY: -1 });
    expect(
      accumulateWheel(EMPTY_WHEEL_REMAINDER, { deltaX: 0, deltaY: 6, deltaMode: 1 }),
    ).toMatchObject({ deltaX: 0, deltaY: 2 });
    expect(
      accumulateWheel(EMPTY_WHEEL_REMAINDER, { deltaX: 0, deltaY: 1, deltaMode: 2 }),
    ).toMatchObject({ deltaY: 10 });
  });

  it("clamps a fling to the contract's twenty notches", () => {
    expect(
      accumulateWheel(EMPTY_WHEEL_REMAINDER, { deltaX: 5_000, deltaY: -5_000, deltaMode: 0 }),
    ).toEqual({ remainder: { x: 0, y: 0 }, deltaX: 20, deltaY: -20 });
  });
});

describe("keyboardInput", () => {
  const key = (init: Partial<Parameters<typeof keyboardInput>[0]> & { key: string }) =>
    keyboardInput({
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      metaKey: false,
      isComposing: false,
      ...init,
    });

  it("types printable characters as text, shifted or not", () => {
    expect(key({ key: "a" })).toEqual({ type: "text", text: "a" });
    expect(key({ key: "A", shiftKey: true })).toEqual({ type: "text", text: "A" });
    expect(key({ key: " " })).toEqual({ type: "text", text: " " });
    expect(key({ key: "😀" })).toEqual({ type: "text", text: "😀" });
  });

  it("sends shortcuts and named keys as keys with their modifiers", () => {
    expect(key({ key: "c", ctrlKey: true })).toEqual({
      type: "key",
      key: "c",
      modifiers: ["ctrl"],
    });
    expect(key({ key: "T", ctrlKey: true, shiftKey: true })).toEqual({
      type: "key",
      key: "T",
      modifiers: ["ctrl", "shift"],
    });
    expect(key({ key: "Enter" })).toEqual({ type: "key", key: "Enter", modifiers: [] });
    expect(key({ key: "Escape" })).toEqual({ type: "key", key: "Escape", modifiers: [] });
    expect(key({ key: "Tab", shiftKey: true })).toEqual({
      type: "key",
      key: "Tab",
      modifiers: ["shift"],
    });
  });

  it("sends nothing for bare modifiers, dead keys and composition", () => {
    expect(key({ key: "Control", ctrlKey: true })).toBeNull();
    expect(key({ key: "Shift", shiftKey: true })).toBeNull();
    expect(key({ key: "Dead" })).toBeNull();
    expect(key({ key: "Process" })).toBeNull();
    expect(key({ key: "a", isComposing: true })).toBeNull();
  });
});

describe("textInputs", () => {
  it("splits long text within the contract's limit without cutting a surrogate pair", () => {
    const text = `${"a".repeat(999)}😀b`;
    expect(textInputs(text)).toEqual([
      { type: "text", text: "a".repeat(999) },
      { type: "text", text: "😀b" },
    ]);
    expect(textInputs("one\r\ntwo")).toEqual([{ type: "text", text: "one\ntwo" }]);
    expect(textInputs("")).toEqual([]);
  });
});

describe("createComputerInputPump", () => {
  const setup = () => {
    const sent: ComputerStreamInput[] = [];
    let scheduled: (() => void) | null = null;
    const pump = createComputerInputPump(
      (input) => sent.push(input),
      (flush) => {
        scheduled = flush;
        return () => {
          scheduled = null;
        };
      },
    );
    const runFrame = () => {
      const flush = scheduled;
      scheduled = null;
      flush?.();
    };
    return { sent, pump, runFrame };
  };
  const move = (x: number) =>
    ({ type: "pointer", action: "move", x, y: 0.5, button: "left" }) as const;

  it("sends only the latest move of a frame", () => {
    const { sent, pump, runFrame } = setup();
    pump.move(move(0.1));
    pump.move(move(0.2));
    pump.move(move(0.3));
    expect(sent).toEqual([]);
    runFrame();
    expect(sent).toEqual([move(0.3)]);
  });

  it("batches typed characters and keeps order with immediate input", () => {
    const { sent, pump, runFrame } = setup();
    pump.type("h");
    pump.type("i");
    pump.send({ type: "key", key: "Enter", modifiers: [] });
    pump.move(move(0.4));
    pump.send({ type: "pointer", action: "down", x: 0.4, y: 0.5, button: "left" });
    runFrame();
    expect(sent).toEqual([
      { type: "text", text: "hi" },
      { type: "key", key: "Enter", modifiers: [] },
      move(0.4),
      { type: "pointer", action: "down", x: 0.4, y: 0.5, button: "left" },
    ]);
  });

  it("drops batched input on dispose", () => {
    const { sent, pump, runFrame } = setup();
    pump.type("lost");
    pump.dispose();
    runFrame();
    expect(sent).toEqual([]);
  });
});
