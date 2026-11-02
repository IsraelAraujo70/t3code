import { expect, it } from "vite-plus/test";
import type { WorkflowTrigger } from "@t3tools/contracts";
import { decodeRunParams, triggerLabel } from "./triggers.ts";
const labels: ReadonlyArray<readonly [WorkflowTrigger, string]> = [
  [{ kind: "manual" }, "Run now"],
  [{ kind: "bot", description: "Run" }, "bot · any bot"],
  [{ kind: "bot", description: "Run", bots: ["a"] }, "bot · 1 bot"],
  [{ kind: "call" }, "called by any workflow"],
  [{ kind: "call", from: ["release", "nightly"] }, "called by release, nightly"],
  [{ kind: "webhook" }, "webhook"],
  [{ kind: "cron", expr: "0 * * * *", tz: "UTC" }, "0 * * * * (UTC)"],
  [{ kind: "upstreamTag", remote: "origin", pattern: "v*", pollMinutes: 1 }, "tag v* on origin"],
  [{ kind: "prMerged", scope: "repo", repo: "a/b" }, "PR merged in a/b"],
  [{ kind: "threadSettled" }, "thread settled"],
  [{ kind: "workflowFailed" }, "any failed"],
];
it.each(labels)("labels %j", (trigger, label) => {
  expect(triggerLabel(trigger)).toBe(label);
});
it.each([
  [{}, { ok: true, params: { name: "abc" } }],
  [
    { extra: 1 },
    { ok: false, errors: [{ param: "extra", message: "extra is not a declared param" }] },
  ],
  [{ name: 1 }, { ok: false, errors: [{ param: "name", message: "name: expected string" }] }],
  [
    { name: "xabcx" },
    { ok: false, errors: [{ param: "name", message: "name does not match abc" }] },
  ],
  [{ name: "abc" }, { ok: true, params: { name: "abc" } }],
])("decodes %j", (input, expected) => {
  expect(
    decodeRunParams({ name: { type: "string", default: "abc", pattern: "abc" } }, input),
  ).toEqual(expected);
});
it("requires a value", () => {
  expect(decodeRunParams({ name: { type: "string" } }, {})).toEqual({
    ok: false,
    errors: [{ param: "name", message: "name is required" }],
  });
});
