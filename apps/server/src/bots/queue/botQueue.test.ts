import { assert, describe, it } from "@effect/vitest";

import { type OrchestrationV2Run, RunId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { botQueueResumeKey } from "./botQueue.ts";

const at = (time: string) => DateTime.makeUnsafe(`2026-10-21T${time}Z`);

const run = (
  ordinal: number,
  status: OrchestrationV2Run["status"],
  times: { readonly started?: string; readonly completed?: string } = {},
  queueHeld?: boolean,
) => ({
  id: RunId.make(`run:ordinal:${ordinal}`),
  ordinal,
  status,
  queuePosition: status === "queued" ? ordinal : null,
  ...(queueHeld === undefined ? {} : { queueHeld }),
  startedAt: times.started === undefined ? null : at(times.started),
  completedAt: times.completed === undefined ? null : at(times.completed),
});

describe("botQueueResumeKey", () => {
  // The InsiderXL PM thread on 2026-10-21: the restart at 16:23 cancelled notice 114 before it
  // started and held notice 115. Notices that came later ran and completed, and so did the 22:00
  // scheduled task, while 115 and 119 stayed held until the user wrote at 12:29 the next day.
  const beforeRestart = run(113, "completed", { started: "16:19:23", completed: "16:19:51" });
  const cancelledByRestart = run(114, "cancelled", { completed: "16:23:44" });
  const held115 = run(115, "queued", {}, true);
  const held119 = run(119, "queued", {}, true);

  it("resumes the held queue once the bot completes a run again", () => {
    const after = run(116, "completed", { started: "16:24:18", completed: "16:24:46" });
    assert.strictEqual(
      botQueueResumeKey([beforeRestart, cancelledByRestart, held115, after]),
      "run:ordinal:116:run:ordinal:115",
    );
    const scheduled = run(124, "completed", { started: "22:00:03", completed: "22:01:34" });
    assert.strictEqual(
      botQueueResumeKey([beforeRestart, cancelledByRestart, held119, held115, after, scheduled]),
      "run:ordinal:124:run:ordinal:115",
    );
  });

  it("resumes an idle bot's queue right after the restart that held it", () => {
    // A queued message the restart cancelled never started, so it says nothing about the bot.
    assert.strictEqual(
      botQueueResumeKey([beforeRestart, cancelledByRestart, held115]),
      "run:ordinal:113:run:ordinal:115",
    );
  });

  it("keeps the hold while a run is active or after one that did not complete", () => {
    const running = run(116, "running", { started: "16:24:18" });
    assert.isNull(botQueueResumeKey([beforeRestart, held115, running]));
    for (const status of ["failed", "interrupted", "cancelled"] as const) {
      const ended = run(116, status, { started: "16:24:18", completed: "16:24:46" });
      assert.isNull(botQueueResumeKey([beforeRestart, held115, ended]), status);
    }
  });

  it("does nothing without a held queue", () => {
    assert.isNull(botQueueResumeKey([beforeRestart]));
    assert.isNull(botQueueResumeKey([beforeRestart, run(115, "queued")]));
    assert.isNull(botQueueResumeKey([held115]));
  });
});
