import { EnvironmentId, WorkflowRunId } from "@t3tools/contracts";
import {
  stepStatusTone,
  runStatusTone,
  stepStatusLabel,
  runStatusLabel,
  isRunActive,
  stepDurationMs,
  openGates,
  defaultRunParams,
  workflowRunHref,
  workflowRunAlertPath,
} from "./workflows.run.ts";
import * as Schema from "effect/Schema";
import {
  WorkflowRunSummary,
  type WorkflowRunView,
  type WorkflowRunDelta,
} from "@t3tools/contracts";
import { foldRunDelta, joinRunPages } from "./workflows.run.ts";
import { WorkflowStepKey, WorkflowNodeId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  formatDuration,
  formatTokens,
  formatUsd,
  parseRunParam,
  nodeStatuses,
  stepRows,
} from "./workflows.run.ts";
import type { WorkflowStepAttemptView, WorkflowParamSpec } from "@t3tools/contracts";
const step = (
  key: string,
  attempt: number,
  status: WorkflowStepAttemptView["status"],
  startedAt: string | null = null,
): WorkflowStepAttemptView => ({
  key: WorkflowStepKey.make(key),
  node: WorkflowNodeId.make("x"),
  kind: "command",
  attempt,
  status,
  startedAt,
  endedAt: null,
  threadId: null,
  queuedMs: null,
  port: null,
  summary: null,
  cost: null,
  evidence: null,
});
describe("run presentation", () => {
  it.each([
    [850, "850ms"],
    [42000, "42s"],
    [252000, "4m 12s"],
    [7500000, "2h 05m"],
  ])("duration %s", (input, expected) => expect(formatDuration(Number(input))).toBe(expected));
  it.each([
    [950, "950"],
    [12400, "12.4k"],
    [12000, "12k"],
    [3100000, "3.1M"],
  ])("tokens %s", (input, expected) => expect(formatTokens(Number(input))).toBe(expected));
  it.each([
    [null, "unknown"],
    [0, "$0.00"],
    [0.001, "<$0.01"],
    [0.42, "$0.42"],
  ])("usd %s", (input, expected) =>
    expect(formatUsd(input === null ? null : Number(input))).toBe(expected),
  );
  it.each<{ spec: WorkflowParamSpec; text: string; ok: boolean }>([
    { spec: { type: "number" }, text: " 12 ", ok: true },
    { spec: { type: "number" }, text: " ", ok: false },
    { spec: { type: "boolean" }, text: "TRUE", ok: true },
    { spec: { type: "boolean" }, text: "yes", ok: false },
    { spec: { type: "string", pattern: "[a-z]+" }, text: "abc", ok: true },
    { spec: { type: "string", pattern: "[a-z]+" }, text: "1abc", ok: false },
    { spec: { type: "string", pattern: "[" }, text: "abc", ok: false },
  ])("parses $text", ({ spec, text, ok }) => expect(parseRunParam(spec, text).ok).toBe(ok));
  it("uses latest attempts and aggregates instances", () =>
    expect(
      nodeStatuses([
        step("map[0]/x", 1, "failed"),
        step("map[0]/x", 2, "succeeded"),
        step("map[1]/x", 1, "waiting_gate"),
      ]).get("x"),
    ).toBe("waiting_gate"));
  it("sorts started rows before unstarted rows", () =>
    expect(
      stepRows([
        step("z", 1, "pending"),
        step("a", 2, "running", "2026-01-02"),
        step("a", 1, "failed", "2026-01-01"),
        step("b", 1, "pending"),
      ]).map((r) => [r.key, r.attempts.map((a) => a.attempt)]),
    ).toEqual([
      ["a", [1, 2]],
      ["b", [1]],
      ["z", [1]],
    ]));
});

const decodeSummary = Schema.decodeSync(WorkflowRunSummary);

it("folds newer deltas by identity and ignores stale deltas", () => {
  const first = step("a", 1, "running");
  const summary = decodeSummary({
    runId: "wfr_00000000000000000000",
    workflowId: "demo",
    title: "Demo",
    hash: null,
    commit: null,
    status: "running",
    pausedFor: null,
    skipReason: null,
    trigger: { kind: "manual", label: "Manual" },
    startedAt: "2026-01-01T00:00:00.000Z",
    endedAt: null,
    outputStatus: null,
    stepsUsed: 1,
    cost: { billable: 0, input: 0, output: 0, cacheRead: 0, usage: "complete", usdEstimate: 0 },
    reservedTokens: 0,
    openGates: 0,
    pullRequest: null,
    activeMs: null,
  });
  const view: WorkflowRunView = {
    summary,
    definition: null,
    seq: 1,
    steps: [first],
    nextStepsCursor: null,
    blocks: [],
    gates: [],
  };
  const delta: WorkflowRunDelta = {
    runId: summary.runId,
    seq: 2,
    summary,
    steps: [{ ...first, status: "failed" }, step("a", 2, "running")],
    blocks: [],
    gates: [],
  };
  expect(foldRunDelta(view, { ...delta, seq: 1 })).toBe(view);
  expect(foldRunDelta(view, delta).steps.map((s) => [s.attempt, s.status])).toEqual([
    [1, "failed"],
    [2, "running"],
  ]);
  expect(view.steps).toEqual([first]);
  const block = {
    _tag: "hillclimb" as const,
    step: first.key,
    round: 0,
    origin: null,
    best: null,
    roundsWithoutGain: 0,
    attempts: 0,
  };
  expect(
    foldRunDelta({ ...view, blocks: [block] }, { ...delta, blocks: [{ ...block, round: 1 }] })
      .blocks,
  ).toEqual([{ ...block, round: 1 }]);
  const gate = {
    key: "approval",
    step: first.key,
    ask: "Proceed?",
    options: ["yes"],
    openedAt: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
    decision: null,
  };
  const decision = { option: "yes", note: null, at: "2026-01-01T00:01:00.000Z" };
  expect(
    foldRunDelta({ ...view, gates: [gate] }, { ...delta, gates: [{ ...gate, decision }] }).gates,
  ).toEqual([{ ...gate, decision }]);
  // A shifted offset repeats `b` on the second page; the join keeps each attempt once and the
  // deltas after the read's `seq` fold over the whole set.
  const paged = joinRunPages([
    { ...view, steps: [first, step("b", 1, "succeeded")], nextStepsCursor: "2" },
    { ...view, steps: [step("b", 1, "succeeded"), step("c", 1, "pending")] },
  ]);
  expect(paged?.nextStepsCursor).toBeNull();
  expect(
    paged && foldRunDelta(paged, delta).steps.map((s) => [s.key, s.attempt, s.status]),
  ).toEqual([
    ["a", 1, "failed"],
    ["b", 1, "succeeded"],
    ["c", 1, "pending"],
    ["a", 2, "running"],
  ]);
  expect(joinRunPages([view, { ...view, seq: 2 }])).toBeNull();
});

it("presents statuses and run controls consistently", () => {
  expect(stepStatusTone("waiting_gate")).toBe("warning");
  expect(runStatusTone("failed")).toBe("danger");
  expect(stepStatusLabel("waiting_gate")).toBe("Waiting for you");
  expect(runStatusLabel("budget_exhausted")).toBe("Budget exhausted");
  expect(isRunActive("paused")).toBe(true);
  expect(isRunActive("succeeded")).toBe(false);
  expect(stepDurationMs(step("a", 1, "running", "2026-01-01T00:00:00Z"), 1767225601000)).toBe(1000);
  expect(stepDurationMs(step("a", 1, "pending"), 0)).toBeNull();
  expect(openGates([])).toEqual([]);
  expect(
    defaultRunParams({
      s: { type: "string" },
      n: { type: "number" },
      b: { type: "boolean" },
      d: { type: "number", default: 5 },
    }),
  ).toEqual({ s: "", n: 0, b: false, d: 5 });
  const env = EnvironmentId.make("remote/env"),
    id = WorkflowRunId.make("wfr_00000000000000000000");
  expect(workflowRunHref(env, id)).toBe(`/workflows/remote%2Fenv/runs/${id}`);
  expect(workflowRunAlertPath(env, id)).toBe(`/bots/workflows/remote%2Fenv/runs/${id}`);
});
