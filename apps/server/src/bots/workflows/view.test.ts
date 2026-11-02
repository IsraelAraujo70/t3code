import { describe, expect, it } from "vite-plus/test";
import {
  compile,
  TestRun,
  runStarted,
  turnSettled,
  unitExited,
  cost,
  T0,
  iso,
  RUN_ID,
} from "./testkit/decideHarness.ts";
import { runSummary, runDelta, stepDetail, pendingSummary, stepViews, gateViews } from "./view.ts";
import { runIdFor } from "./ids.ts";
import type { StoredFact } from "./facts.ts";

const command = { kind: "command", cwd: "integ", argv: ["node", "check.ts"] };
const agent = {
  kind: "agent",
  model: "$lead",
  prompt: "Work",
  workspace: "integ",
  access: "write",
  tokenReservation: 5000,
};
function prepare(compiled: ReturnType<typeof compile>) {
  const run = TestRun.start(
    compiled,
    runStarted({ params: { items: [1, 2] }, hash: `sha256:${"0".repeat(64)}` }),
  );
  run.drive();
  run.add("result:ws:integ", {
    _tag: "WorkspaceReady",
    name: "integ",
    path: "/runs/x/integ",
    branch: "wf/demo",
    headSha: "a1",
  });
  run.drive();
  return run;
}
function protectedRun() {
  return prepare(
    compile({ nodes: { c: { ...command, argv: ["git", "push", "origin", "HEAD:friend/main"] } } }),
  );
}
function approve(run: TestRun) {
  run.add("gate:protect:c@1", {
    _tag: "GateDecided",
    gateKey: "protect:c@1",
    option: "approve",
    note: "Reviewed",
    by: "user",
    at: iso(T0 + 3000),
  });
}

describe("run views", () => {
  it("reports the last published pull request", () => {
    const run = prepare(compile());
    for (const [key, url] of [
      ["pr:a", "https://example.com/1"],
      ["pr:b", "https://example.com/2"],
    ]) {
      run.add(key!, {
        _tag: "IntentRecorded",
        intent: {
          _tag: "OpenPullRequest",
          key: key!,
          workspace: "integ",
          branch: "wf/demo",
          sha: "a1",
          base: "main",
          title: "T",
          body: "B",
        },
      });
      run.result(key!, { _tag: "PullRequestOpened", url: url!, branch: "wf/demo" });
    }
    expect(runSummary(run.state()).pullRequest).toBe("https://example.com/2");
  });

  it("summarizes running, user-paused and completed runs", () => {
    const run = prepare(
      compile({
        nodes: {
          a: agent,
          c: command,
          done: { kind: "output", status: "ready_for_review", value: {} },
        },
        edges: ["a -> c", "c -> done"],
      }),
    );
    expect(runSummary(run.state())).toMatchObject({
      status: "running",
      stepsUsed: 1,
      openGates: 0,
    });
    const paused = prepare(compile({ nodes: { c: command } }));
    paused.add("control:x", {
      _tag: "ControlRequested",
      control: "pause",
      step: null,
      by: "user",
      at: iso(T0),
    });
    expect(paused.drive().map((f) => f.key)).toContain("pause:control:x");
    expect(runSummary(paused.state())).toMatchObject({ status: "paused", pausedFor: "user" });
    run.add("settled:a@1", turnSettled("a", 1, "completed", {}));
    run.drive();
    expect(runSummary(run.state()).stepsUsed).toBe(2);
    run.add("exited:c@1", unitExited("c", 1, 0));
    run.drive(T0 + 4000);
    expect(runSummary(run.state())).toMatchObject({
      status: "succeeded",
      endedAt: iso(T0 + 4000),
      outputStatus: "ready_for_review",
    });
  });

  it("aggregates settled costs and preserves incomplete or unknown usage", () => {
    const make = (usage: "complete" | "partial", usdEstimate: number | null) => {
      const run = prepare(compile({ nodes: { a: { ...agent, retry: { max: 1, on: ["lost"] } } } }));
      expect(runSummary(run.state()).cost.usage).toBe("unavailable");
      const first = turnSettled("a", 1, "cancelled");
      const second = turnSettled("a", 2, "completed", {});
      if (first._tag !== "TurnSettled" || second._tag !== "TurnSettled")
        throw new Error("Expected settled turns");
      run.add("settled:a@1", {
        ...first,
        cost: { ...cost, billable: 10, input: 20, output: 3, cacheRead: 4, usdEstimate: 1 },
      });
      run.drive();
      run.add("settled:a@2", {
        ...second,
        cost: { ...cost, billable: 5, input: 6, output: 7, cacheRead: 8, usage, usdEstimate },
      });
      run.drive();
      return runSummary(run.state()).cost;
    };
    expect(make("complete", 2)).toEqual({
      billable: 15,
      input: 26,
      output: 10,
      cacheRead: 12,
      usage: "complete",
      usdEstimate: 3,
    });
    expect(make("partial", 2).usage).toBe("partial");
    expect(make("complete", null).usdEstimate).toBeNull();
  });

  it("charges a step for its turn and its correction turn", () => {
    const run = prepare(
      compile({ nodes: { a: { ...agent, output: { tag: { type: "string" } } } } }),
    );
    const first = turnSettled("a", 1, "completed", null, "no json");
    const second = turnSettled("a", 1, "completed", { tag: "v1" });
    if (first._tag !== "TurnSettled" || second._tag !== "TurnSettled") throw new Error("fixture");
    run.add("result:turn:a@1", { _tag: "TurnStarted", threadId: "wf:x" });
    run.add("settled:a@1", { ...first, cost: { ...cost, billable: 10 } });
    run.drive();
    run.add("settled:a@1:nudge", { ...second, cost: { ...cost, billable: 5 } });
    run.drive();
    expect(stepViews(run.compiled, run.state())[0]?.cost?.billable).toBe(15);
  });

  it("shows an accept command by what it did once its run succeeded", () => {
    const run = prepare(
      compile({
        nodes: {
          a: { ...agent, accept: { argv: ["node", "t.ts"], check: "exit == 0" } },
          done: { kind: "output", status: "ready_for_review", value: {} },
        },
        edges: ["a:pass -> done"],
      }),
    );
    run.add("result:turn:a@1", { _tag: "TurnStarted", threadId: "wf:x" });
    run.add("settled:a@1", turnSettled("a", 1, "completed", {}));
    run.drive();
    run.add("result:accept:a@1", { _tag: "UnitSpawned", unit: "u", at: iso(T0) });
    run.add("exited:a/accept@1", unitExited("a/accept", 1, 0, { tail: "12 passed" }));
    run.drive();
    expect(runSummary(run.state()).status).toBe("succeeded");
    expect(stepViews(run.compiled, run.state()).find((v) => v.key === "a/accept")).toMatchObject({
      status: "succeeded",
      summary: "12 passed",
    });
  });

  it("shows an accept command the run's end stopped as cancelled after its interrupt lands", () => {
    const run = prepare(
      compile({
        nodes: { a: { ...agent, accept: { argv: ["node", "t.ts"], check: "exit == 0" } } },
      }),
    );
    run.add("result:turn:a@1", { _tag: "TurnStarted", threadId: "wf:x" });
    run.add("settled:a@1", turnSettled("a", 1, "completed", {}));
    run.drive();
    run.add("result:accept:a@1", { _tag: "UnitSpawned", unit: "u", at: iso(T0) });
    run.add("control:c", {
      _tag: "ControlRequested",
      control: "cancel",
      step: null,
      by: "user",
      at: iso(T0),
    });
    expect(run.drive().map((f) => f.key)).toContain("interrupt:accept:a@1");
    run.add("exited:a/accept@1", unitExited("a/accept", 1, null, { signal: "SIGTERM" }));
    expect(stepViews(run.compiled, run.state()).find((v) => v.key === "a/accept")?.status).toBe(
      "cancelled",
    );
  });

  it("releases the agent token reservation on settlement", () => {
    const run = prepare(compile({ nodes: { a: agent } }));
    expect(run.intent("turn:a@1")?._tag).toBe("StartTurn");
    expect(runSummary(run.state()).reservedTokens).toBe(5000);
    run.add("settled:a@1", turnSettled("a", 1, "completed", {}));
    run.drive();
    expect(runSummary(run.state()).reservedTokens).toBe(0);
  });

  it("counts only undecided protected gates", () => {
    const run = protectedRun();
    expect(runSummary(run.state()).openGates).toBe(1);
    approve(run);
    run.drive();
    expect(runSummary(run.state()).openGates).toBe(0);
  });

  it("projects queued and skipped occurrences until their run is created", () => {
    const occurrence = "manual:1";
    const runId = runIdFor("demo", occurrence);
    const facts: StoredFact[] = [
      {
        stream: "workflow:demo",
        seq: 1,
        key: occurrence,
        at: iso(T0),
        fact: {
          _tag: "TriggerFired",
          runId,
          occurrence,
          triggerId: "manual",
          kind: "manual",
          label: "manual",
          params: {},
          payload: null,
          causalDepth: 0,
          parent: null,
          at: iso(T0),
        },
      },
    ];
    expect(pendingSummary(facts, runId, "Demo")?.status).toBe("queued");
    facts.push({
      stream: "workflow:demo",
      seq: 2,
      key: "skipped",
      at: iso(T0),
      fact: { _tag: "TriggerSkipped", occurrence, reason: "busy" },
    });
    expect(pendingSummary(facts, runId, "Demo")).toMatchObject({
      status: "skipped",
      skipReason: "busy",
    });
    facts.push({
      stream: "workflow:demo",
      seq: 3,
      key: "created",
      at: iso(T0),
      fact: { _tag: "RunCreated", occurrence, runId },
    });
    expect(pendingSummary(facts, runId, "Demo")).toBeNull();
    expect(pendingSummary(facts, RUN_ID, "Demo")).toBeNull();
  });

  it("orders attempts and projects map nodes, running, gated, resolved and skipped steps", () => {
    const compiled = compile({
      nodes: {
        src: { ...command, parse: "json" },
        m: {
          kind: "map",
          items: "nodes.src.output",
          maxItems: 2,
          concurrency: 2,
          body: { nodes: { w: command }, edges: [] },
        },
        skip: { ...command, when: "false" },
      },
      edges: ["src -> m", "src -> skip"],
    });
    const run = prepare(compiled);
    run.add("exited:src@1", unitExited("src", 1, 0, { out: [1, 2] }));
    run.drive();
    run.add("result:unit:m[1]/w@1", { _tag: "UnitSpawned", unit: "u", at: iso(T0) });
    const views = stepViews(compiled, run.state());
    expect(views.filter((v) => v.key.endsWith("/w")).map((v) => v.key)).toEqual([
      "m[0]/w",
      "m[1]/w",
    ]);
    expect(views.find((v) => v.key === "m[1]/w")).toMatchObject({
      node: "w",
      kind: "command",
      status: "running",
    });
    expect(views.find((v) => v.key === "skip")).toMatchObject({ status: "skipped", attempt: 1 });
    const gated = protectedRun();
    expect(stepViews(gated.compiled, gated.state())[0]?.status).toBe("waiting_gate");
    approve(gated);
    gated.drive();
    gated.add("exited:c@1", unitExited("c", 1, 0));
    gated.drive();
    expect(stepViews(gated.compiled, gated.state())[0]).toMatchObject({
      status: "succeeded",
      port: "ok",
    });
  });

  it("projects gate metadata and the decision timestamp", () => {
    const run = protectedRun();
    run.add("result:open:protect:c@1", {
      _tag: "GateOpened",
      gateKey: "protect:c@1",
      at: iso(T0 + 2000),
    });
    expect(gateViews(run.state())[0]).toMatchObject({
      key: "protect:c@1",
      options: ["approve", "reject"],
      openedAt: iso(T0 + 2000),
      decision: null,
    });
    approve(run);
    expect(gateViews(run.state())[0]?.decision).toEqual({
      option: "approve",
      note: "Reviewed",
      at: iso(T0 + 3000),
    });
  });

  it("limits deltas to attempts and gates changed after the cursor", () => {
    const run = prepare(
      compile({
        nodes: {
          stable: command,
          c: { ...command, argv: ["git", "push", "origin", "HEAD:friend/main"] },
        },
        edges: ["stable -> c"],
      }),
    );
    run.add("exited:stable@1", unitExited("stable", 1, 0));
    run.drive();
    const afterSeq = run.state().lastSeq;
    expect(runDelta(run.compiled, run.state(), afterSeq)).toMatchObject({ steps: [], gates: [] });
    approve(run);
    run.drive();
    run.add("result:unit:c@1", { _tag: "UnitSpawned", unit: "c", at: iso(T0 + 4000) });
    const state = run.state();
    const delta = runDelta(run.compiled, state, afterSeq);
    expect(delta.seq).toBe(state.lastSeq);
    expect(delta.steps.map((v) => v.key)).toEqual(["c"]);
    expect(delta.gates.map((v) => v.key)).toEqual(["protect:c@1"]);
  });

  it("returns command logs, agent text and outputs, and null for missing attempts", () => {
    const run = prepare(compile({ nodes: { c: command, a: agent }, edges: ["c -> a"] }));
    run.add("exited:c@1", unitExited("c", 1, 0, { tail: "checked", out: { ok: true } }));
    run.drive();
    run.drive();
    run.add("settled:a@1", turnSettled("a", 1, "completed", { answer: 42 }));
    run.drive();
    expect(stepDetail(run.compiled, run.state(), "c", 1)).toMatchObject({
      logs: [{ name: "stdout", tail: "checked", path: null }],
      output: { ok: true },
    });
    expect(stepDetail(run.compiled, run.state(), "a", 1)).toMatchObject({
      text: "reply",
      output: { text: "reply" },
    });
    expect(stepDetail(run.compiled, run.state(), "a", 2)).toBeNull();
  });
});

it("counts live active time from the caller clock", () => {
  const run = TestRun.start(
    compile({
      nodes: { a: agent, done: { kind: "output", status: "ready_for_review", value: {} } },
      edges: ["a -> done"],
    }),
    runStarted({ hash: `sha256:${"0".repeat(64)}` }),
  );
  const state = run.state();
  expect(runSummary(state, T0 + 1234)).toMatchObject({
    activeMs: 1234,
    activeSince: "2026-11-02T10:00:01.234Z",
  });
  const paused = {
    ...state,
    pauses: [{ at: "2026-11-02T10:00:00.000Z", resumedAt: null, reason: "user" as const }],
  };
  expect(runSummary(paused, T0 + 1234).activeSince).toBeNull();
  const ended = {
    ...state,
    ended: {
      _tag: "RunEnded" as const,
      status: "succeeded" as const,
      at: "2026-11-02T10:00:01.000Z",
    },
  };
  expect(runSummary(ended, T0 + 5000)).toMatchObject({ activeMs: 1000, activeSince: null });
});
