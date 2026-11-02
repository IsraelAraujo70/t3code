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
    expect(
      latestTag(
        "aaa\trefs/tags/v0.9.3\nbbb\trefs/tags/v0.10.0\nccc\trefs/tags/nightly-9\njunk",
        "v*",
      ),
    ).toEqual({ tag: "v0.10.0", objectSha: "bbb" });
    expect(latestTag("", "*")).toBeNull();
    expect(occurrenceKey.tag("r", "v", "a")).not.toBe(occurrenceKey.tag("r", "v", "b"));
  });
  it.each(["bot:b:1", "bot:b:t-abc", "wf:b:1", "bot:bb:1"])("settled %s", (threadId) => {
    expect(
      settledMatches(
        { botId: "b", projectId: "p", titlePrefix: "Hi" },
        { threadId, projectId: "p", title: "Hi there" },
      ),
    ).toBe(threadId.startsWith("bot:b:"));
  });
});

it.each([
  ["0 3 * * *", "America/Sao_Paulo", "2026-11-01T06:00:00Z", "2026-11-01T06:00:00.000Z"],
  ["30 1 * * *", "America/New_York", "2026-11-01T05:30:00Z", "2026-11-01T05:30:00.000Z"],
  ["30 1 * * *", "America/New_York", "2026-11-01T06:30:00Z", "2026-11-01T06:30:00.000Z"],
  // Effect skips the nonexistent spring occurrence and keeps the following day.
  ["30 2 * * *", "America/New_York", "2026-03-09T06:30:00Z", "2026-03-09T06:30:00.000Z"],
])("timezone %s %s %s", (expr, tz, now, expected) => {
  const result = cronDecision({
    triggerId: "t",
    expr,
    tz,
    now: new Date(now),
    watermark: new Date(new Date(now).getTime() - 1000),
    misfire: { mode: "latest", graceMs: 3600000 },
    toleranceMs: 1000,
  });
  expect(result._tag).toBe("Fire");
  if (result._tag === "Fire") expect(result.at.toISOString()).toBe(expected);
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
