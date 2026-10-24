import { assert, describe, it } from "@effect/vitest";

import { asPlainText } from "./GuestService.ts";

describe("asPlainText", () => {
  it("keeps a leading slash from reaching Claude Code as a command", () => {
    assert.strictEqual(asPlainText("/model claude-opus-5-5"), "​/model claude-opus-5-5");
    assert.strictEqual(asPlainText("  /compact"), "​  /compact");
    assert.strictEqual(asPlainText("pague 1/2 da conta"), "pague 1/2 da conta");
  });

  it("breaks the reasoning keyword in any case, anywhere", () => {
    assert.strictEqual(asPlainText("UltraThink: oi"), "Ultra​Think: oi");
    assert.notMatch(asPlainText("pense bem, ultrathink e ULTRATHINK"), /ultrathink/i);
  });
});
