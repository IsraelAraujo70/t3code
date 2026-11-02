import { expect, it } from "vite-plus/test";
import {
  needsYouNotice,
  failedNotice,
  finishedNotice,
  suspendedNotice,
  workflowPushData,
  workflowRunWebPath,
} from "./notices.ts";

it("keeps logical event keys stable and separates pauses", () => {
  const gate = () =>
    needsYouNotice("Title", "run", { _tag: "gate", gateKey: "g", ask: "  Please\n answer " });
  expect(gate()).toMatchObject({ key: "notify:gate:g", body: "Please answer", kind: "needs_you" });
  expect(gate().key).toBe(gate().key);
  for (const _tag of ["fatigue", "daily_cap"] as const) {
    const notice = (pause: number) =>
      needsYouNotice("Title", "run", { _tag, pause, streak: 3, cap: 100 });
    expect(notice(1).key).toBe(`notify:${_tag}:1`);
    expect(notice(2).key).not.toBe(notice(1).key);
  }
});
it("selects terminal notices and clips reports", () => {
  for (const [status, body] of [
    ["failed", "The run failed."],
    ["cancelled", "The run was cancelled."],
    ["budget_exhausted", "The run used its whole budget."],
  ] as const)
    expect(failedNotice("T", "r", status)).toMatchObject({ key: "notify:end", body });
  expect(finishedNotice("T", "r", { status: "rejected", notify: false, report: null })).toBeNull();
  expect(
    finishedNotice("T", "r", { status: "rejected", notify: true, report: "x".repeat(601) })?.body,
  ).toBe("x".repeat(599) + "…");
  expect(
    finishedNotice("T", "r", { status: "ready_for_review", notify: false, report: null })?.body,
  ).toBe("Ready for review.");
  expect(finishedNotice("T", "r", { status: "no_gain", notify: false, report: null })?.body).toBe(
    "Finished without a gain.",
  );
  expect(suspendedNotice("T", "r", 3).body).toBe(
    "Suspended after 3 failed runs in a row. Turn it back on in Workflows.",
  );
});
it("builds Android-compatible data with encoded paths", () => {
  expect(workflowRunWebPath("e/a", "r b")).toBe("/workflows/e%2Fa/runs/r%20b");
  expect(
    workflowPushData(failedNotice("Title", "r b", "failed"), {
      runId: "r b",
      workflowId: "w",
      environmentId: "e/a",
      sentAt: 42,
    }),
  ).toEqual({
    t3_kind: "bot_message",
    alert_id: "wf:r b:notify:end",
    alert_title: "Title",
    alert_body: "The run failed.",
    alert_path: "/bots/workflows/e%2Fa/runs/r%20b",
    alert_group: "wf:w",
    sent_at: "42",
  });
});
