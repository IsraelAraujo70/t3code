import { ThreadId } from "@t3tools/contracts";
// @effect-diagnostics globalDate:off - Fixed Date fixtures exercise the public trigger contract.
import { describe, expect, it } from "vite-plus/test";
import {
  childCausalDepth,
  cronDecision,
  latestTag,
  misfirePolicy,
  occurrenceKey,
  settledMatches,
} from "./occurrence.ts";

describe("occurrences", () => {
  it.each([
    ["latest", "03:40", 3600000, "Fire"],
    ["latest", "03:40", 1000, "Skip"],
    ["skip", "03:40", 3600000, "Skip"],
    ["skip", "03:00", 3600000, "Fire"],
  ] as const)("%s at %s", (mode, time, graceMs, tag) => {
    const result = cronDecision({
      triggerId: "t",
      expr: "0 * * * *",
      tz: "UTC",
      misfire: { mode, graceMs },
      toleranceMs: 1000,
      watermark: new Date("2026-01-01T01:30Z"),
      now: new Date(`2026-01-01T${time}Z`),
    });
    expect(result._tag).toBe(tag);
    if (result._tag === "Fire" || result._tag === "Skip") {
      expect(result.at.toISOString()).toBe("2026-01-01T03:00:00.000Z");
      expect(
        cronDecision({
          triggerId: "t",
          expr: "0 * * * *",
          tz: "UTC",
          misfire: { mode, graceMs },
          toleranceMs: 1000,
          watermark: result.watermark,
          now: new Date(`2026-01-01T${time}Z`),
        })._tag,
      ).toBe("Idle");
    }
  });
  it.each([0, 1, 2])("causal depth %s", (depth) =>
    expect(childCausalDepth(depth)).toBe(depth === 0 ? 1 : null),
  );
  it("keys", () => {
    expect([
      occurrenceKey.cron("t", new Date(0)),
      occurrenceKey.webhook("d"),
      occurrenceKey.manual("m"),
      occurrenceKey.bot("b", "c"),
      occurrenceKey.tag("r", "v", "a"),
      occurrenceKey.prMerged("r", 1, "a"),
      occurrenceKey.settled("t", 2),
      occurrenceKey.runFailed("r"),
    ]).toEqual([
      "cron:t:1970-01-01T00:00:00.000Z",
      "webhook:d",
      "manual:m",
      "bot:b:c",
      "tag:r:v:a",
      "pr:r#1:a",
      "settled:t:2",
      "run-failed:r",
    ]);
  });
  it("policy and tags", () => {
    const host = { mode: "skip", graceMs: 1 } as const;
    expect(misfirePolicy({}, host)).toEqual(host);
    expect(misfirePolicy({ misfire: { mode: "latest", grace: "1h" } }, host)).toEqual({
      mode: "latest",
      graceMs: 3600000,
    });
    const remote =
      "aaa\trefs/tags/v0.9.3\nbbb\trefs/tags/v0.10.0\nddd\trefs/tags/v0.11.0-nightly.1\nccc\trefs/tags/nightly-9\njunk";
    // The upstream-merge template's pattern: stable releases only.
    expect(latestTag(remote, "^v\\d+\\.\\d+\\.\\d+$")).toEqual({
      tag: "v0.10.0",
      objectSha: "bbb",
    });
    expect(latestTag(remote, "^v")).toEqual({ tag: "v0.11.0-nightly.1", objectSha: "ddd" });
    expect(latestTag("", ".*")).toBeNull();
    expect(latestTag(remote, "(")).toBeNull();
    expect(occurrenceKey.tag("r", "v", "a")).not.toBe(occurrenceKey.tag("r", "v", "b"));
  });
  it.each([
    { relationshipToParent: "subagent", sideChat: false },
    { relationshipToParent: null, sideChat: true },
    { relationshipToParent: null, sideChat: false },
  ] as const)("excludes workflow descendants %j", (lineage) => {
    expect(
      settledMatches(
        {},
        {
          threadId: "child",
          projectId: "p",
          title: "Done",
          lineage: {
            ...lineage,
            parentThreadId: ThreadId.make("wf:run:step"),
            rootThreadId: ThreadId.make("wf:run:step"),
          },
        },
      ),
    ).toBe(false);
  });
  it.each(["bot:b:1", "bot:b:t-abc", "wf:b:1", "bot:bb:1"])("settled %s", (threadId) => {
    expect(
      settledMatches(
        { botId: "b", projectId: "p", titlePrefix: "Hi" },
        {
          threadId,
          projectId: "p",
          title: "Hi there",
          lineage: {
            parentThreadId: null,
            rootThreadId: ThreadId.make(threadId),
            relationshipToParent: null,
          },
        },
      ),
    ).toBe(threadId.startsWith("bot:b:"));
  });
});

/** Ticks every 5 minutes for a day and returns what fired. */
const firedOver = (expr: string, tz: string, from: string, hours: number) => {
  let watermark = new Date(from);
  const fired: Array<string> = [];
  for (let minute = 5; minute <= hours * 60; minute += 5) {
    const now = new Date(new Date(from).getTime() + minute * 60_000);
    const result = cronDecision({
      triggerId: "t",
      expr,
      tz,
      now,
      watermark,
      misfire: { mode: "latest", graceMs: 3_600_000 },
      toleranceMs: 60_000,
    });
    expect(result._tag).not.toBe("Invalid");
    if (result._tag === "Fire") fired.push(result.at.toISOString());
    if (result._tag === "Fire" || result._tag === "Skip") watermark = result.watermark;
  }
  return fired;
};

it.each([
  // 03:00 in São Paulo (no DST since 2019) is 06:00Z.
  ["0 3 * * *", "America/Sao_Paulo", "2026-11-01T00:00:00Z", ["2026-11-01T06:00:00.000Z"]],
  // Clocks go back at 02:00 EDT: 01:30 happens twice and fires once, at its first passage.
  ["30 1 * * *", "America/New_York", "2026-11-01T00:00:00Z", ["2026-11-01T05:30:00.000Z"]],
  // Clocks go forward at 02:00 EST: 02:30 does not exist; it runs once, at 03:30 EDT.
  ["30 2 * * *", "America/New_York", "2026-03-08T00:00:00Z", ["2026-03-08T07:30:00.000Z"]],
  ["30 2 * * *", "America/New_York", "2026-03-09T00:00:00Z", ["2026-03-09T06:30:00.000Z"]],
])("%s in %s fires once over the day from %s", (expr, tz, from, expected) => {
  expect(firedOver(expr, tz, from, 24)).toEqual(expected);
});

it.each([
  ["bad", "UTC"],
  ["0 * * * *", "invalid/zone"],
])("invalid %s %s", (expr, tz) => {
  expect(
    cronDecision({
      triggerId: "t",
      expr: expr!,
      tz: tz!,
      now: new Date(0),
      watermark: new Date(0),
      misfire: { mode: "latest", graceMs: 1 },
      toleranceMs: 1,
    })._tag,
  ).toBe("Invalid");
});

it.each([
  // One past the walk's step cap: the walk ends on an intermediate occurrence.
  ["2026-01-07T23:00:00Z"],
  // 10,001 due occurrences: the walk ends exactly on the latest one.
  ["2026-01-07T22:41:00Z"],
])("a long catch-up to %s fires only the latest occurrence, once", (nowIso) => {
  const input = {
    triggerId: "t",
    expr: "* * * * *",
    tz: "UTC",
    misfire: { mode: "latest" as const, graceMs: 3_600_000 },
    toleranceMs: 60_000,
    now: new Date(nowIso),
  };
  let watermark = new Date("2026-01-01T00:00:00Z");
  const fired: Array<string> = [];
  for (let tick = 0; tick < 5; tick++) {
    const result = cronDecision({ ...input, watermark });
    if (result._tag === "Fire") fired.push(result.at.toISOString());
    if (result._tag === "Fire" || result._tag === "Skip") watermark = result.watermark;
  }
  expect(fired).toEqual([new Date(nowIso).toISOString()]);
});

it("keys an owner test by trigger and request", () => {
  expect(occurrenceKey.test("hook", "request")).toBe("test:hook:request");
});
