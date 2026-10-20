import { describe, expect, it } from "vite-plus/test";

import { computerStreamRetryDelayMs, parseComputerStreamMessage } from "./computerStream.logic";

describe("computerStreamRetryDelayMs", () => {
  it("backs off exponentially and stops growing at ten seconds", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map(computerStreamRetryDelayMs)).toEqual([
      500, 1_000, 2_000, 4_000, 8_000, 10_000, 10_000, 10_000,
    ]);
  });
});

describe("parseComputerStreamMessage", () => {
  it("reads the info and error messages", () => {
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
