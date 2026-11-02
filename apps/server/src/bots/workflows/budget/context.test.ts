import { describe, expect, it } from "vite-plus/test";

import type { Fact } from "../facts.ts";
import { compile, cost, iso, T0, TestRun } from "../testkit/decideHarness.ts";
import { DEFAULT_TURN_RESERVATION } from "./budget.ts";
import { budgetContext, nodeEstimates } from "./context.ts";

const DAY_START = Date.parse("2026-11-02T15:00:00.000Z"); // 12:00 in São Paulo

/** A run whose node `a` settled one turn charging `billable` at `settledAt`. */
const runWith = (billable: number, settledAt: number) => {
  const run = TestRun.start(
    compile({
      nodes: {
        a: {
          kind: "agent",
          model: "$lead",
          prompt: "p",
          workspace: "integ",
          access: "write",
          tokenReservation: 5_000,
        },
      },
    }),
  );
  run.drive();
  run.result("ws:integ", {
    _tag: "WorkspaceReady",
    name: "integ",
    path: "/w",
    branch: "wf/demo",
    headSha: "abc",
  });
  run.drive();
  run.result("turn:a@1", { _tag: "TurnStarted", threadId: "t" });
  const settled: Fact = {
    _tag: "TurnSettled",
    step: "a",
    attempt: 1,
    status: "completed",
    text: "",
    output: null,
    outputError: null,
    cost: { ...cost, billable },
  };
  run.add("settled:a@1", settled, settledAt);
  return run.state();
};

describe("budget context", () => {
  it("learns a node's reservation as the mean of its earlier turns", () => {
    const estimate = nodeEstimates([runWith(10_000, T0), runWith(30_000, T0)]);
    expect(estimate("a")).toBe(20_000);
    expect(estimate("unseen")).toBe(DEFAULT_TURN_RESERVATION);
  });

  it("sums the workflow day over every run and ends it at the next local noon", () => {
    const context = budgetContext({
      now: DAY_START + 3_600_000,
      timeZone: "America/Sao_Paulo",
      dayStartsAtHour: 12,
      cap: 40_000_000,
      runs: [runWith(7_000, DAY_START + 60_000), runWith(9_000, DAY_START - 60_000)],
      history: [],
    });
    expect(context.day).toEqual({
      spent: 7_000,
      cap: 40_000_000,
      endsAt: DAY_START + 86_400_000,
    });
    expect(iso(context.day?.endsAt ?? 0)).toBe("2026-11-03T15:00:00.000Z");
  });
});
