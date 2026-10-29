import { describe, expect, it } from "vite-plus/test";

import {
  computerFramePoint,
  computerPress,
  computerStreamMaxWidth,
  computerTypingInputs,
  computerWheelNotches,
  createComputerMoveThrottle,
  createComputerGestureSession,
  parseComputerDocumentMessage,
  parseComputerStreamMessage,
  type ComputerPoint,
} from "./computer.logic";

describe("computerFramePoint", () => {
  it("maps a wide frame in a tall view, ignoring the bands above and below", () => {
    // A 1920x1080 frame in a 400x800 view is 400x225, centred 287.5 px from the top.
    const view = { width: 400, height: 800 };
    const frame = { width: 1920, height: 1080 };
    expect(computerFramePoint(view, frame, { x: 200, y: 400 })).toEqual({ x: 0.5, y: 0.5 });
    expect(computerFramePoint(view, frame, { x: 0, y: 287.5 })).toEqual({ x: 0, y: 0 });
    expect(computerFramePoint(view, frame, { x: 400, y: 512.5 })).toEqual({ x: 1, y: 1 });
    expect(computerFramePoint(view, frame, { x: 200, y: 100 })).toBeNull();
    expect(computerFramePoint(view, frame, { x: 200, y: 600 })).toBeNull();
  });

  it("maps a tall frame in a wide view, ignoring the side bands", () => {
    // A 1080x1920 frame in a 1000x500 view is 281.25x500, starting 359.375 px from the left.
    const view = { width: 1000, height: 500 };
    const frame = { width: 1080, height: 1920 };
    const point = computerFramePoint(view, frame, { x: 500, y: 125 });
    expect(point?.x).toBeCloseTo(0.5);
    expect(point?.y).toBeCloseTo(0.25);
    expect(computerFramePoint(view, frame, { x: 100, y: 250 })).toBeNull();
    expect(computerFramePoint(view, frame, { x: 900, y: 250 })).toBeNull();
  });

  it("maps nothing before the view or the frame has a size", () => {
    expect(
      computerFramePoint({ width: 0, height: 0 }, { width: 10, height: 10 }, { x: 0, y: 0 }),
    ).toBeNull();
    expect(
      computerFramePoint({ width: 10, height: 10 }, { width: 0, height: 0 }, { x: 5, y: 5 }),
    ).toBeNull();
  });
});

describe("computerPress", () => {
  it("presses then releases the same button at the same point", () => {
    expect(computerPress({ x: 0.25, y: 0.75 }, "right")).toEqual([
      { type: "pointer", action: "down", button: "right", x: 0.25, y: 0.75 },
      { type: "pointer", action: "up", button: "right", x: 0.25, y: 0.75 },
    ]);
  });
});

describe("computerWheelNotches", () => {
  it("scrolls down when the fingers move up, keeping the leftover pixels", () => {
    expect(computerWheelNotches(-70, 32)).toEqual({ notches: 2, remainderPx: -6 });
    expect(computerWheelNotches(40, 32)).toEqual({ notches: -1, remainderPx: 8 });
  });

  it("sends nothing until a whole notch has accumulated", () => {
    expect(computerWheelNotches(-31, 32)).toEqual({ notches: 0, remainderPx: -31 });
  });

  it("clamps to the contract's range and carries the excess", () => {
    expect(computerWheelNotches(-32 * 25, 32)).toEqual({ notches: 20, remainderPx: -32 * 5 });
  });
});

describe("computerStreamMaxWidth", () => {
  it("asks for twice the physical width, capped at 1920", () => {
    expect(computerStreamMaxWidth(360, 2)).toBe(1440);
    expect(computerStreamMaxWidth(412, 2.625)).toBe(1920);
  });
});

describe("createComputerMoveThrottle", () => {
  const setup = () => {
    let now = 0;
    const timers: Array<{ at: number; run: () => void; cancelled: boolean }> = [];
    const sent: ComputerPoint[] = [];
    const throttle = createComputerMoveThrottle({
      intervalMs: 33,
      now: () => now,
      schedule: (run, delayMs) => {
        const timer = { at: now + delayMs, run, cancelled: false };
        timers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
      send: (point) => sent.push(point),
    });
    const advance = (ms: number) => {
      now += ms;
      for (const timer of timers.filter((entry) => !entry.cancelled && entry.at <= now)) {
        timer.cancelled = true;
        timer.run();
      }
    };
    return { throttle, sent, advance };
  };

  it("sends the first move at once and only the latest move of an interval", () => {
    const { throttle, sent, advance } = setup();
    throttle.push({ x: 0.1, y: 0.1 });
    advance(10);
    throttle.push({ x: 0.2, y: 0.2 });
    advance(10);
    throttle.push({ x: 0.3, y: 0.3 });
    expect(sent).toEqual([{ x: 0.1, y: 0.1 }]);
    advance(13);
    expect(sent).toEqual([
      { x: 0.1, y: 0.1 },
      { x: 0.3, y: 0.3 },
    ]);
  });

  it("flushes a held move before the release", () => {
    const { throttle, sent, advance } = setup();
    throttle.push({ x: 0.1, y: 0.1 });
    throttle.push({ x: 0.4, y: 0.4 });
    throttle.flush();
    advance(100);
    expect(sent).toEqual([
      { x: 0.1, y: 0.1 },
      { x: 0.4, y: 0.4 },
    ]);
  });
});

describe("computerTypingInputs", () => {
  it("sends typed characters as text", () => {
    expect(computerTypingInputs("he", "hello")).toEqual([{ type: "text", text: "llo" }]);
  });

  it("sends a Backspace per deleted character", () => {
    expect(computerTypingInputs("hello", "hel")).toEqual([
      { type: "key", key: "Backspace", modifiers: [] },
      { type: "key", key: "Backspace", modifiers: [] },
    ]);
  });

  it("replaces an autocorrected word by deleting back to the change", () => {
    expect(computerTypingInputs("teh ", "the ")).toEqual([
      { type: "key", key: "Backspace", modifiers: [] },
      { type: "key", key: "Backspace", modifiers: [] },
      { type: "key", key: "Backspace", modifiers: [] },
      { type: "text", text: "he " },
    ]);
  });

  it("deletes an emoji with one Backspace and splits long pastes", () => {
    expect(computerTypingInputs("a😀", "a")).toEqual([
      { type: "key", key: "Backspace", modifiers: [] },
    ]);
    const pasted = computerTypingInputs("", "x".repeat(2500));
    expect(pasted.map((input) => (input.type === "text" ? input.text.length : 0))).toEqual([
      1000, 1000, 500,
    ]);
  });
});

describe("message parsing", () => {
  it("accepts the document's messages and rejects anything else", () => {
    expect(parseComputerDocumentMessage('{"type":"server","text":"{}"}')).toEqual({
      type: "server",
      text: "{}",
    });
    expect(parseComputerDocumentMessage('{"type":"closed"}')).toEqual({ type: "closed" });
    expect(parseComputerDocumentMessage('{"type":"other"}')).toBeNull();
    expect(parseComputerDocumentMessage("not json")).toBeNull();
  });

  it("reads the server's access message", () => {
    expect(parseComputerStreamMessage('{"type":"access","canControl":true}')).toEqual({
      type: "access",
      canControl: true,
    });
    expect(parseComputerStreamMessage('{"type":"access"}')).toBeNull();
  });
});

describe("computer gesture session", () => {
  it("flushes drag moves and releases a held button only once", () => {
    const sent: unknown[] = [];
    let scheduled: (() => void) | null = null;
    const throttle = createComputerMoveThrottle({
      intervalMs: 33,
      now: () => 0,
      schedule: (run) => {
        scheduled = run;
        return () => {
          scheduled = null;
        };
      },
      send: (point) => sent.push({ type: "pointer", action: "move", button: "left", ...point }),
    });
    const session = createComputerGestureSession({
      send: (input) => sent.push(input),
      throttle,
      wheelNotchPx: 32,
    });
    const start = { x: 0, y: 0 };
    const last = { x: 1, y: 1 };
    session.dragStart(start, start);
    session.dragMove(last);
    expect(sent).toHaveLength(3);
    expect(scheduled).not.toBeNull();
    session.dragEnd();
    expect(sent).toEqual([
      { type: "pointer", action: "move", button: "left", ...start },
      { type: "pointer", action: "down", button: "left", ...start },
      { type: "pointer", action: "move", button: "left", ...start },
      { type: "pointer", action: "move", button: "left", ...last },
      { type: "pointer", action: "up", button: "left", ...last },
    ]);
    session.dragStart(start, null);
    session.dragMove(last);
    session.release();
    const released = sent.length;
    session.release();
    session.dragEnd();
    expect(sent).toHaveLength(released);
    expect(sent.at(-1)).toEqual({ type: "pointer", action: "up", button: "left", ...last });
    expect(scheduled).toBeNull();
  });
  it("carries scroll remainders between updates", () => {
    const sent: unknown[] = [];
    const throttle = createComputerMoveThrottle({
      intervalMs: 33,
      now: () => 0,
      schedule: () => () => {},
      send: () => {},
    });
    const session = createComputerGestureSession({
      send: (input) => sent.push(input),
      throttle,
      wheelNotchPx: 32,
    });
    session.scrollStart({ x: 0.5, y: 0.5 }, 0, 0);
    session.scrollMove(20, 40);
    session.scrollMove(40, 64);
    session.scrollEnd();
    session.scrollMove(100, 100);
    expect(sent).toEqual([
      { type: "wheel", x: 0.5, y: 0.5, deltaX: 0, deltaY: -1 },
      { type: "wheel", x: 0.5, y: 0.5, deltaX: -1, deltaY: -1 },
    ]);
  });
});
