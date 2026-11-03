import { EMPTY_WORKFLOWS_FILTERS, workflowsFilterOptions } from "@t3tools/client-runtime/workflows";
import {
  WorkflowId,
  WorkflowRunId,
  type WorkflowRunSummary,
  type WorkflowSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  activeFilterCount,
  applyFilterChoice,
  filterPills,
  gateOptionTone,
  needsYouLine,
  RESET_FILTERS_ID,
  runMetaLine,
  runNowBlocker,
} from "./workflowsScreen.logic";

const run = (over: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary => ({
  runId: WorkflowRunId.make("wfr_0123456789abcdef0123"),
  workflowId: WorkflowId.make("nightly"),
  title: "Nightly",
  hash: null,
  commit: null,
  status: "running",
  pausedFor: null,
  skipReason: null,
  trigger: { id: "t", kind: "cron", label: "0 21 * * * (UTC)" },
  startedAt: "2026-11-03T10:00:00.000Z",
  endedAt: null,
  outputStatus: null,
  stepsUsed: 0,
  cost: {
    billable: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    usage: "complete",
    usdEstimate: null,
  },
  reservedTokens: 0,
  openGates: 0,
  pullRequest: null,
  activeMs: null,
  activeSince: null,
  ...over,
});

const workflow = (id: string, bot: string | null): WorkflowSummary => ({
  workflowId: WorkflowId.make(id),
  title: id,
  description: null,
  path: `${id}.workflow.yaml`,
  valid: true,
  dirty: false,
  enabled: true,
  suspended: false,
  diagnostics: 0,
  triggers: [
    {
      id: "manual",
      kind: "manual",
      title: null,
      label: "manual",
      webhookUrl: null,
      enabled: true,
      lastFiredAt: null,
    },
  ],
  headCommit: null,
  revision: null,
  updatedAt: null,
  lastRun: null,
  bot: bot === null ? null : { id: bot, name: bot },
});

describe("filter menus", () => {
  const options = workflowsFilterOptions([workflow("a", "ralph"), workflow("b", null)]);
  const pick = (tab: "workflows" | "runs", key: string, title: string) =>
    filterPills(tab, EMPTY_WORKFLOWS_FILTERS, options)
      .find((pill) => pill.key === key)!
      .actions.find((action) => action.title.startsWith(title))!.id;

  it("toggles list values, replaces single values, and ignores ids it did not make", () => {
    const bot = pick("workflows", "bots", "ralph");
    const once = applyFilterChoice("workflows", EMPTY_WORKFLOWS_FILTERS, bot);
    expect(once.bots).toEqual(["ralph"]);
    expect(applyFilterChoice("workflows", once, bot).bots).toEqual([]);

    const failed = applyFilterChoice(
      "runs",
      EMPTY_WORKFLOWS_FILTERS,
      pick("runs", "states", "Failed"),
    );
    expect(failed.states).toEqual(["failed"]);
    const week = applyFilterChoice("runs", failed, pick("runs", "period", "Last 7"));
    expect(applyFilterChoice("runs", week, pick("runs", "period", "Last 30")).period).toBe("30d");

    expect(applyFilterChoice("runs", week, '["states","bogus"]')).toBe(week);
    expect(applyFilterChoice("runs", week, "not json")).toBe(week);
  });

  it("reset clears only the tab's filters and keeps the search text", () => {
    const set = {
      ...EMPTY_WORKFLOWS_FILTERS,
      bots: ["ralph"],
      enabled: "on" as const,
      states: ["failed" as const],
      query: "night",
    };
    expect(activeFilterCount("runs", set)).toBe(2);
    expect(activeFilterCount("workflows", set)).toBe(2);
    const runs = applyFilterChoice("runs", set, RESET_FILTERS_ID);
    expect(runs).toMatchObject({ bots: [], states: [], enabled: "on", query: "night" });
    const workflows = applyFilterChoice("workflows", set, RESET_FILTERS_ID);
    expect(workflows).toMatchObject({
      bots: [],
      enabled: null,
      states: ["failed"],
      query: "night",
    });
  });

  it("names a pill by its one value, else by its count, and keeps a stale value clearable", () => {
    const pills = (bots: string[]) =>
      filterPills("workflows", { ...EMPTY_WORKFLOWS_FILTERS, bots }, options).find(
        (pill) => pill.key === "bots",
      )!;
    expect(pills([]).label).toBe("Bot");
    expect(pills(["ralph"]).label).toBe("ralph");
    expect(pills(["ralph", "none"]).label).toBe("Bot · 2");
    const stale = pills(["gone"]);
    expect(stale.actions[0]).toMatchObject({ title: "gone", state: "on" });
  });
});

describe("run words", () => {
  it("says what a run waits on: the gate's reason, else why it paused", () => {
    expect(
      needsYouLine(
        run({
          openGates: 1,
          gate: { key: "g", reason: "Merge PR #4?", openedAt: "2026-11-03T10:00:00.000Z" },
        }),
      ),
    ).toBe("Merge PR #4?");
    // Older hosts send no gate summary.
    expect(needsYouLine(run({ openGates: 1 }))).toBe("Waiting for your decision");
    expect(needsYouLine(run({ status: "paused", pausedFor: "fatigue" }))).toMatch(/failures/);
  });

  it("reads a schedule in words and leaves out time and tokens it does not have", () => {
    expect(runMetaLine(run(), Date.parse("2026-11-03T10:05:00.000Z"))).toBe("Daily at 21:00 (UTC)");
    expect(
      runMetaLine(
        run({
          trigger: { id: "m", kind: "manual", label: "manual" },
          activeMs: 90_000,
          cost: { ...run().cost, billable: 12_300 },
        }),
        0,
      ),
    ).toBe("Run now · 1m 30s · 12.3k tokens");
  });

  it("colors refusals as danger and the first other option as the main one", () => {
    expect(["approve", "reject", "later"].map(gateOptionTone)).toEqual([
      "primary",
      "danger",
      "secondary",
    ]);
  });

  it("says why Run now is not offered", () => {
    expect(runNowBlocker(workflow("a", null), true)).toBeNull();
    expect(runNowBlocker(workflow("a", null), false)).toMatch(/may not/);
    expect(runNowBlocker({ ...workflow("a", null), triggers: [] }, true)).toMatch(/no Run now/);
  });
});
