import { describe, expect, it } from "vite-plus/test";

import { RunAttemptId, RunId, type TurnTokenUsage } from "@t3tools/contracts";

import { lastJsonBlock, stepRuns, turnCost } from "./turnResult.ts";

const run = (id: string, ordinal: number) => ({ id: RunId.make(id), ordinal });
const attempt = (id: string, runId: string) => ({
  id: RunAttemptId.make(id),
  runId: RunId.make(runId),
});
const turn = (attemptId: string, turnTokenUsage?: TurnTokenUsage) => ({
  runAttemptId: RunAttemptId.make(attemptId),
  ...(turnTokenUsage === undefined ? {} : { turnTokenUsage }),
});
const complete = (inputTokens: number, outputTokens: number, cachedInputTokens: number) =>
  ({
    usageScope: "main_agent",
    hasSubagents: false,
    usageStatus: "complete",
    inputTokens,
    outputTokens,
    cachedInputTokens,
  }) as const;

describe("lastJsonBlock", () => {
  it("decodes the last json block and explains a missing or broken one", () => {
    expect(lastJsonBlock('a\n```json\n{"x":1}\n```\nb\n```json\n{"x":2}\n```')).toEqual({
      output: { x: 2 },
      error: null,
    });
    expect(lastJsonBlock("no block").error).toBe("the reply has no ```json block");
    expect(lastJsonBlock("```json\n{x}\n```").error).toMatch(/does not parse/);
  });
});

describe("turnCost", () => {
  it("sums the runs from the step's message to its result run, and only them", () => {
    // r1 the step's run, r2 a restart continuation or delegated follow-up, r3 its result, r4 the next step.
    const runs = [run("r4", 4), run("r1", 1), run("r3", 3), run("r2", 2), run("r0", 0)];
    const chain = stepRuns(runs, run("r1", 1), run("r3", 3));
    expect(chain.map((r) => r.id)).toEqual(["r1", "r2", "r3"]);
    const cost = turnCost(
      chain,
      [attempt("a1", "r1"), attempt("a2", "r2"), attempt("a3", "other")],
      [
        turn("a1", complete(100, 10, 40)),
        turn("a2", complete(50, 5, 0)),
        turn("a3", complete(9, 9, 0)),
      ],
    );
    expect(cost).toEqual({
      billable: 60 + 10 + 50 + 5,
      input: 150,
      output: 15,
      cacheRead: 40,
      usage: "complete",
      usdEstimate: null,
    });
  });

  it("reports unknown usage as partial or unavailable, never as a complete zero", () => {
    const chain = [run("r1", 1)];
    const attempts = [attempt("a1", "r1")];
    expect(turnCost(chain, attempts, []).usage).toBe("unavailable");
    expect(turnCost(chain, attempts, [turn("a1")]).usage).toBe("unavailable");
    expect(turnCost(chain, attempts, [turn("a1", complete(5, 1, 0)), turn("a1")]).usage).toBe(
      "partial",
    );
  });
});
