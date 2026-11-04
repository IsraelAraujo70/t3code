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

it.each([
  [{ tickets: ["BACK-1", "BACK-2"] }, { ok: true, params: { tickets: ["BACK-1", "BACK-2"] } }],
  [{}, { ok: true, params: { tickets: [] } }],
  [
    { tickets: ["BACK-1", "BACK-2", "BACK-3"] },
    { ok: false, errors: [{ param: "tickets", message: "tickets has 3 items; at most 2" }] },
  ],
  [
    { tickets: ["BACK-1", "rm -rf"] },
    {
      ok: false,
      errors: [{ param: "tickets", message: 'tickets: "rm -rf" does not match [A-Z]+-\\d+' }],
    },
  ],
  [
    { tickets: "BACK-1" },
    { ok: false, errors: [{ param: "tickets", message: "tickets: expected a list of strings" }] },
  ],
])("decodes the list %j", (input, expected) => {
  expect(
    decodeRunParams(
      { tickets: { type: "string[]", default: [], maxItems: 2, pattern: "[A-Z]+-\\d+" } },
      input,
    ),
  ).toEqual(expected);
});

it.each([
  [{}, { ok: true, params: { model: "claude-opus-5-5" } }],
  [{ model: "gpt-6.1-sol" }, { ok: true, params: { model: "gpt-6.1-sol" } }],
  [
    { model: "claude-opus-5-5 --dangerously" },
    {
      ok: false,
      errors: [
        {
          param: "model",
          message:
            'model: "claude-opus-5-5 --dangerously" is not one of claude-opus-5-5, gpt-6.1-sol',
        },
      ],
    },
  ],
])("decodes a closed set %j", (input, expected) => {
  expect(
    decodeRunParams(
      {
        model: {
          type: "string",
          enum: ["claude-opus-5-5", "gpt-6.1-sol"],
          default: "claude-opus-5-5",
        },
      },
      input,
    ),
  ).toEqual(expected);
});
