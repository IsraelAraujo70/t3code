import { describe, expect, it } from "vite-plus/test";
import type { Fact, Intent } from "../facts.ts";
import {
  compile,
  cost,
  iso,
  TestRun,
  T0,
  turnSettled,
  unitExited,
} from "../testkit/decideHarness.ts";
import {
  activeDeadline,
  activeMs,
  chargedBetween,
  continuationChain,
  effectiveCeilings,
  fatigueStreak,
  overrunTurns,
  reservedTokens,
  spentTokens,
  usageReportKey,
  workflowDay,
} from "./budget.ts";

const turn = (key = "turn:only@1"): Intent => ({
  _tag: "StartTurn",
  key,
  step: "only",
  attempt: 1,
  threadId: "thread",
  mode: "new",
  projectRef: "t3code",
  title: "test",
  workspace: { name: "home", path: "/work" },
  prompt: "test",
  model: { provider: "codex", model: "test" },
  access: "read",
  reservation: 100,
});
const runWith = (intent: Intent) =>
  TestRun.start(compile()).add(intent.key, { _tag: "IntentRecorded", intent });

describe("budget", () => {
  it.each([
    ["unavailable", 10, 100],
    ["partial", 120, 120],
    ["complete", 10, 10],
  ] as const)("charges %s usage", (usage, billable, expected) => {
    const run = runWith(turn());
    expect(reservedTokens(run.state())).toBe(100);
    const fact = turnSettled("only", 1, "completed");
    if (fact._tag !== "TurnSettled") throw new Error("settlement");
    run.add("settled", { ...fact, cost: { ...cost, usage, billable } }, T0 + 50);
    expect(spentTokens(run.state())).toBe(expected);
    expect(reservedTokens(run.state())).toBe(0);
    expect(chargedBetween(run.state(), T0, T0 + 51)).toBe(expected);
    expect(chargedBetween(run.state(), T0, T0 + 50)).toBe(0);
  });
  it.each([
    { out: { tokens: { total: 25 } }, lost: false, expected: 25 },
    { out: null, lost: false, expected: 100 },
    { out: { tokens: { total: 25 } }, lost: true, expected: 100 },
  ])("charges unit output $expected", ({ out, lost, expected }) => {
    const intent: Intent = {
      _tag: "StartUnit",
      key: "unit:only@1",
      step: "only",
      attempt: 1,
      argv: ["true"],
      cwd: { name: "home", path: "/work" },
      heavy: false,
      replay: "safe",
      timeoutMs: 1000,
      env: {},
      reservation: 100,
      tokensFrom: "tokens.total",
    };
    const run = runWith(intent).add("exit", unitExited("only", 1, 0, { out, lost }));
    expect(spentTokens(run.state())).toBe(expected);
  });
  it("failed intents release reservations", () => {
    const run = runWith(turn()).add("result:turn:only@1", {
      _tag: "IntentFailed",
      error: "no start",
      retryable: false,
    });
    expect(spentTokens(run.state())).toBe(0);
    expect(reservedTokens(run.state())).toBe(0);
  });
  it("unions gate waits with pauses", () => {
    const intent: Intent = {
      _tag: "OpenGate",
      key: "open:g",
      step: "only",
      gateKey: "g",
      reason: "gate",
      ask: "continue?",
      options: ["yes"],
      expiresAt: null,
    };
    const run = runWith(intent).add("result:open:g", {
      _tag: "GateOpened",
      gateKey: "g",
      at: iso(T0 + 100),
    });
    expect(activeDeadline(run.state(), T0 + 200, 1000)).toBeNull();
    run.add("pause:1", { _tag: "RunPaused", reason: "user", detail: "test", at: iso(T0 + 150) });
    run.add("gate:g", {
      _tag: "GateDecided",
      gateKey: "g",
      option: "yes",
      note: null,
      by: "user",
      at: iso(T0 + 300),
    });
    expect(activeMs(run.state(), T0 + 500)).toBe(100);
    run.add("resume:1", { _tag: "RunResumed", at: iso(T0 + 400) });
    expect(activeMs(run.state(), T0 + 500)).toBe(200);
    expect(activeDeadline(run.state(), T0 + 500, 1000)).toBe(T0 + 1300);
  });
  it("resets fatigue on success and resume", () => {
    const run = TestRun.start(compile());
    const resolve = (attempt: number, status: "failed" | "succeeded", at: number) =>
      run.add(`resolved:${attempt}`, {
        _tag: "StepResolved",
        step: "only",
        attempt,
        status,
        port: null,
        output: null,
        error: null,
        at: iso(at),
      });
    resolve(1, "failed", T0);
    resolve(2, "failed", T0 + 1);
    expect(fatigueStreak(run.state())).toBe(2);
    resolve(3, "succeeded", T0 + 2);
    expect(fatigueStreak(run.state())).toBe(0);
    resolve(4, "failed", T0 + 3);
    run.add("pause:1", { _tag: "RunPaused", reason: "user", detail: "test", at: iso(T0 + 4) });
    run.add("resume:1", { _tag: "RunResumed", at: iso(T0 + 5) });
    expect(fatigueStreak(run.state())).toBe(0);
  });
  it("tracks live overruns", () => {
    const run = runWith(turn()).add("result:turn:only@1", {
      _tag: "TurnStarted",
      threadId: "thread",
    });
    run.add("usage:turn:only@1:1", {
      _tag: "TurnUsageReported",
      step: "only",
      attempt: 1,
      at: iso(T0),
      billable: 199,
    });
    expect(overrunTurns(run.state())).toHaveLength(0);
    run.add("usage:turn:only@1:2", {
      _tag: "TurnUsageReported",
      step: "only",
      attempt: 1,
      at: iso(T0),
      billable: 200,
    });
    expect(overrunTurns(run.state())).toHaveLength(1);
    run.add("settled", turnSettled("only", 1, "completed"));
    expect(overrunTurns(run.state())).toHaveLength(0);
  });
  it("amends individual ceilings and discounts an open pause", () => {
    const run = TestRun.start(compile()).add("control:a", {
      _tag: "ControlRequested",
      control: "amendBudget",
      budget: { tokens: 50 },
      step: null,
      by: "user",
      at: iso(T0),
    });
    expect(effectiveCeilings(run.state())).toEqual({
      steps: 20,
      wallMs: 7200000,
      tokens: 50,
      usd: null,
    });
    run.add("pause:1", { _tag: "RunPaused", reason: "user", detail: "test", at: iso(T0 + 100) });
    expect(activeMs(run.state(), T0 + 500)).toBe(100);
    expect(activeDeadline(run.state(), T0 + 500, 1000)).toBeNull();
    expect(fatigueStreak(run.state())).toBe(0);
  });
  it.each([
    [0, null],
    [99, null],
    [100, "usage:turn:x@1:1"],
    [250, "usage:turn:x@1:2"],
  ])("keys usage %s", (billable, expected) =>
    expect(usageReportKey("turn:x@1", billable!, 100)).toBe(expected),
  );
  it.each([
    ["2026-11-02T15:00:00Z", "America/Sao_Paulo", 12, "2026-11-02T15:00:00Z", 24],
    ["2026-11-02T14:59:00Z", "America/Sao_Paulo", 12, "2026-11-01T15:00:00Z", 24],
    ["2026-11-01T12:00:00Z", "America/New_York", 0, "2026-11-01T04:00:00Z", 25],
  ] as const)("finds workflow day %s", (now, zone, hour, start, hours) => {
    const day = workflowDay(Date.parse(now), zone, hour);
    expect(day.start).toBe(Date.parse(start));
    expect(day.end - day.start).toBe(hours * 3600000);
  });

  it("follows a live turn through its restart continuations", () => {
    const runs = [
      { id: "r1" },
      { id: "r3", restartContinuationOfRunId: "r2" },
      { id: "other" },
      { id: "r2", restartContinuationOfRunId: "r1" },
    ];
    expect(continuationChain(runs, runs[0]!).map((run) => run.id)).toEqual(["r1", "r2", "r3"]);
  });

  it("charges a turn and its nudge on the days each settled", () => {
    const run = TestRun.start(
      compile({
        nodes: {
          a: {
            kind: "agent",
            model: "$lead",
            prompt: "p",
            workspace: "integ",
            access: "write",
            tokenReservation: 1_000,
            output: { tag: { type: "string" } },
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
    const noon = T0 + 7_200_000;
    const settled = (billable: number, outputError: string | null): Fact => ({
      _tag: "TurnSettled",
      step: "a",
      attempt: 1,
      status: "completed",
      text: "",
      output: null,
      outputError,
      cost: { ...cost, billable },
    });
    run.add("settled:a@1", settled(7_000, "no json"), noon - 60_000);
    run.drive(noon - 60_000);
    run.result("nudge:a@1", { _tag: "TurnStarted", threadId: "t" });
    run.add("settled:a@1:nudge", settled(1_000, null), noon + 60_000);
    expect(chargedBetween(run.state(), noon - 86_400_000, noon)).toBe(7_000);
    expect(chargedBetween(run.state(), noon, noon + 86_400_000)).toBe(1_000);
  });
});
