import {
  WorkflowId,
  WorkflowRunId,
  type WorkflowRunSummary,
  type WorkflowSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_WORKFLOWS_FILTERS,
  filterWorkflows,
  parseWorkflowsSearch,
  runMatchesListInput,
  runsFilterInput,
  workflowsFilterOptions,
  workflowsFiltersOf,
  workflowsSearchOf,
  type WorkflowsFilters,
} from "./workflows.filters.ts";

const workflow = (id: string, patch: Partial<WorkflowSummary> = {}): WorkflowSummary => ({
  workflowId: WorkflowId.make(id),
  title: id,
  description: null,
  path: `${id}.workflow.yaml`,
  valid: true,
  dirty: false,
  enabled: true,
  suspended: false,
  diagnostics: 0,
  triggers: [],
  headCommit: null,
  revision: null,
  updatedAt: null,
  lastRun: null,
  ...patch,
});

const trigger = (kind: string) => ({
  id: kind,
  kind,
  title: null,
  label: kind,
  webhookUrl: null,
  enabled: true,
  lastFiredAt: null,
});

const run = (n: number, patch: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary => ({
  runId: WorkflowRunId.make(`wfr_${String(n).padStart(20, "0")}`),
  workflowId: WorkflowId.make("deploy"),
  title: "Deploy staging",
  hash: null,
  commit: null,
  status: "running",
  pausedFor: null,
  skipReason: null,
  trigger: { id: "manual", kind: "manual", label: "Run now by Israel" },
  startedAt: "2026-11-03T10:00:00.000Z",
  endedAt: null,
  outputStatus: null,
  stepsUsed: 0,
  cost: { billable: 0, input: 0, output: 0, cacheRead: 0, usage: "complete", usdEstimate: null },
  reservedTokens: 0,
  openGates: 0,
  pullRequest: null,
  activeMs: null,
  activeSince: null,
  ...patch,
});

const workflows = [
  workflow("deploy", { bot: { id: "b_pm", name: "PM" }, triggers: [trigger("bot")] }),
  workflow("heartbeat", {
    bot: { id: "b_trader", name: "Trader" },
    triggers: [trigger("cron")],
    enabled: false,
    description: "Hourly check of the simulated bots",
  }),
  workflow("release", { triggers: [trigger("upstreamTag"), trigger("manual")] }),
];

const filtersWith = (patch: Partial<WorkflowsFilters>): WorkflowsFilters => ({
  ...EMPTY_WORKFLOWS_FILTERS,
  ...patch,
});

describe("workflows URL", () => {
  it("keeps the tab and its filters across a reload and drops junk", () => {
    const filters = filtersWith({
      bots: ["b_pm"],
      states: ["needs_you", "failed"],
      period: "7d",
      enabled: "off",
    });
    const search = workflowsSearchOf("runs", filters);
    // The Workflows tab's switch filter does not travel to Runs.
    expect(search).toEqual({ tab: "runs", bot: "b_pm", status: "needs_you,failed", period: "7d" });
    expect(workflowsFiltersOf(parseWorkflowsSearch({ ...search }))).toEqual({
      ...filters,
      enabled: null,
    });
    expect(
      parseWorkflowsSearch({ tab: "nope", status: "failed,bogus", period: "1y", bot: "a b,ok" }),
    ).toEqual({ status: "failed", bot: "ok" });
  });
});

describe("filterWorkflows", () => {
  it("combines bot, trigger, switch and text", () => {
    const ids = (patch: Partial<WorkflowsFilters>) =>
      filterWorkflows(workflows, filtersWith(patch)).map((w) => w.workflowId);
    expect(ids({ bots: ["b_trader", "none"] })).toEqual(["heartbeat", "release"]);
    expect(ids({ triggers: ["manual", "bot"] })).toEqual(["deploy", "release"]);
    expect(ids({ enabled: "off" })).toEqual(["heartbeat"]);
    expect(ids({ query: "SIMULATED" })).toEqual(["heartbeat"]);
    expect(ids({ bots: ["b_pm"], enabled: "off" })).toEqual([]);
  });

  it("offers each bot once, no bot last", () => {
    expect(workflowsFilterOptions(workflows).bots).toEqual([
      { value: "b_pm", label: "PM", count: 1 },
      { value: "b_trader", label: "Trader", count: 1 },
      { value: "none", label: "No bot", count: 1 },
    ]);
  });
});

describe("runs filter", () => {
  const now = Date.parse("2026-11-03T12:34:56.000Z");

  it("turns bots into their workflows and periods into an hour-aligned start", () => {
    expect(
      runsFilterInput(
        filtersWith({
          bots: ["b_pm", "none"],
          workflows: ["release", "heartbeat"],
          states: ["running", "needs_you"],
          period: "24h",
        }),
        workflows,
        now,
      ),
    ).toEqual({
      workflowIds: ["release"],
      states: ["queued", "running", "paused", "needs_you"],
      startedAfter: "2026-11-02T12:00:00.000Z",
    });
    // A bot with no workflows lists no run rather than every run.
    expect(runsFilterInput(filtersWith({ bots: ["b_gone"] }), workflows, now)).toEqual({
      workflowIds: [],
    });
    expect(runsFilterInput(EMPTY_WORKFLOWS_FILTERS, workflows, now)).toEqual({});
  });

  it("matches runs the way the host does", () => {
    const gated = run(1, { openGates: 1 });
    const tired = run(2, { status: "paused", pausedFor: "fatigue" });
    const held = run(3, { status: "paused", pausedFor: "user" });
    const failed = run(4, {
      status: "failed",
      trigger: { id: "hourly", kind: "cron", label: "Every hour" },
      startedAt: "2026-11-01T00:00:00.000Z",
    });
    const pick = (input: Parameters<typeof runMatchesListInput>[1]) =>
      [gated, tired, held, failed].filter((r) => runMatchesListInput(r, input)).map((r) => r.runId);
    expect(pick({ states: ["needs_you"] })).toEqual([gated.runId, tired.runId]);
    expect(pick({ states: ["running", "paused"] })).toEqual([held.runId]);
    expect(pick({ triggerKinds: ["cron"] })).toEqual([failed.runId]);
    expect(pick({ startedAfter: "2026-11-02T00:00:00.000Z" })).toHaveLength(3);
    expect(pick({ query: "every HOUR" })).toEqual([failed.runId]);
    expect(pick({ workflowIds: [] })).toEqual([]);
  });
});
