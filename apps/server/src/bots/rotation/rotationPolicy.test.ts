import { assert, describe, it } from "@effect/vitest";
import { BotId, RunId, type OrchestrationV2Run } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  BOT_ROTATION_POLICY,
  botRotationStep,
  clipHandoff,
  handoffMessageId,
  rotationDueAt,
} from "./rotationPolicy.ts";

// UTC-3 all year, so the quiet hour (04:00) is 07:00Z.
const zone = DateTime.zoneMakeNamedUnsafe("America/Sao_Paulo");
const at = (iso: string) => DateTime.makeUnsafe(iso);
const iso = (value: DateTime.Utc | null) => (value === null ? null : DateTime.formatIso(value));

const BOT = BotId.make("b_rotating");
const HANDOFF = handoffMessageId(BOT, 1);

type Run = Pick<OrchestrationV2Run, "id" | "status" | "userMessageId">;
const run = (n: number, status: Run["status"] = "completed", userMessageId = `m-${n}`): Run => ({
  id: RunId.make(`run-${n}`),
  status,
  userMessageId: userMessageId as Run["userMessageId"],
});
const enough = Array.from({ length: BOT_ROTATION_POLICY.minRuns }, (_, n) => run(n));

const step = (overrides: Partial<Parameters<typeof botRotationStep>[0]> = {}) =>
  botRotationStep({
    rotation: "daily",
    handoffMessageId: HANDOFF,
    startedAt: at("2026-10-20T13:00:00.000Z"),
    now: at("2026-10-21T08:00:00.000Z"),
    zone,
    runs: enough,
    requests: [],
    ...overrides,
  });

describe("rotationDueAt", () => {
  it("is the first quiet hour after the start, a week later for weekly, never when off", () => {
    const started = at("2026-10-20T13:00:00.000Z");
    assert.strictEqual(iso(rotationDueAt("daily", started, zone)), "2026-10-21T07:00:00.000Z");
    assert.strictEqual(iso(rotationDueAt("weekly", started, zone)), "2026-10-27T07:00:00.000Z");
    assert.isNull(rotationDueAt("off", started, zone));
    // Started just before the quiet hour: due the same night, not a day later.
    assert.strictEqual(
      iso(rotationDueAt("daily", at("2026-10-21T06:59:00.000Z"), zone)),
      "2026-10-21T07:00:00.000Z",
    );
    // Started exactly at it: the next one.
    assert.strictEqual(
      iso(rotationDueAt("daily", at("2026-10-21T07:00:00.000Z"), zone)),
      "2026-10-22T07:00:00.000Z",
    );
  });
});

describe("botRotationStep", () => {
  it("asks a due, idle bot with enough runs for its handoff", () => {
    assert.deepStrictEqual(step(), { kind: "handoff" });
  });

  it("leaves a generation that is not due, too small, or off", () => {
    assert.deepStrictEqual(step({ now: at("2026-10-21T06:59:00.000Z") }), { kind: "none" });
    assert.deepStrictEqual(step({ runs: enough.slice(1) }), { kind: "none" });
    assert.deepStrictEqual(step({ rotation: "off" }), { kind: "none" });
  });

  it("never acts while a turn runs, a message waits in the queue, or a question waits", () => {
    for (const status of ["running", "waiting", "queued", "preparing", "starting"] as const) {
      assert.deepStrictEqual(step({ runs: [...enough, run(99, status)] }), { kind: "none" });
    }
    assert.deepStrictEqual(step({ requests: [{ status: "pending" }] }), { kind: "none" });
    assert.deepStrictEqual(step({ requests: [{ status: "resolved" }] }), { kind: "handoff" });
    // A handoff turn still running, or a message queued behind it, holds the rotation too.
    assert.deepStrictEqual(step({ runs: [...enough, run(99, "running", HANDOFF)] }), {
      kind: "none",
    });
    assert.deepStrictEqual(
      step({ runs: [...enough, run(99, "completed", HANDOFF), run(100, "queued")] }),
      { kind: "none" },
    );
  });

  it("rotates once the handoff turn has ended, keeping its reply only when it completed", () => {
    assert.deepStrictEqual(step({ runs: [...enough, run(99, "completed", HANDOFF)] }), {
      kind: "rotate",
      handoffRunId: RunId.make("run-99"),
    });
    assert.deepStrictEqual(step({ runs: [...enough, run(99, "interrupted", HANDOFF)] }), {
      kind: "rotate",
      handoffRunId: null,
    });
    // Turning rotation off after the handoff was asked for still finishes the rotation.
    assert.deepStrictEqual(step({ rotation: "off", runs: [run(99, "failed", HANDOFF)] }), {
      kind: "rotate",
      handoffRunId: null,
    });
  });
});

describe("clipHandoff", () => {
  it("drops an empty reply and shortens a long one to the limit", () => {
    assert.isNull(clipHandoff("  \n "));
    assert.strictEqual(clipHandoff("  Follow PR 12. "), "Follow PR 12.");
    const clipped = clipHandoff("x".repeat(BOT_ROTATION_POLICY.handoffLimit + 50))!;
    assert.strictEqual(clipped.length, BOT_ROTATION_POLICY.handoffLimit);
    assert.isTrue(clipped.endsWith("…"));
  });
});
