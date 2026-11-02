import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import { compileWorkflow, DEFAULT_HOST_LIMITS } from "@t3tools/shared/workflows";

import { decide } from "./decide.ts";
import type { Fact, NewFact, StoredFact } from "./facts.ts";
import { foldRun } from "./fold.ts";
import {
  compile,
  TestRun,
  keysOf,
  unitExited,
  T0,
  iso,
  runStarted,
  turnSettled,
  RUN_ID,
} from "./testkit/decideHarness.ts";

const compiled = (() => {
  const r = compileWorkflow(
    {
      schema: "t3.workflow/v1",
      id: "demo",
      title: "Demo",
      home: { project: "t3code" },
      budget: { steps: 10, wall: "2h", tokens: 100_000 },
      fatigue: { consecutiveFailures: 2 },
      models: { lead: { provider: "claude", model: "claude-opus-5-5" } },
      workspaces: { integ: { project: "t3code", base: "friend/main", branch: "wf/demo" } },
      nodes: {
        plan: {
          kind: "agent",
          model: "$lead",
          prompt: "Plan",
          workspace: "integ",
          access: "write",
          output: { tag: { type: "string", pattern: "^v\\d+$" } },
        },
        test: {
          kind: "command",
          argv: ["node", "check.ts", "{{nodes.plan.output.tag}}"],
          cwd: "integ",
          check: "exit == 0",
        },
        done: {
          kind: "output",
          status: "ready_for_review",
          value: { tag: "{{nodes.plan.output.tag}}" },
        },
        stuck: { kind: "output", status: "blocked", value: {} },
      },
      edges: ["plan -> test", "test:pass -> done", "test:fail -> stuck"],
    },
    DEFAULT_HOST_LIMITS,
  );
  if (Result.isFailure(r)) throw new Error(JSON.stringify(r.failure));
  return r.success;
})();

const cost = {
  billable: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  usage: "complete" as const,
  usdEstimate: null,
};

describe("decide", () => {
  it("runs agent → command → output to the end", () => {
    const facts: StoredFact[] = [];
    const add = (key: string, fact: Fact) =>
      facts.push({
        stream: "run:wfr_00000000000000000000",
        seq: facts.length + 1,
        key,
        fact,
        at: "2026-11-02T10:00:00.000Z",
      });
    const step = (): ReadonlyArray<NewFact> => {
      const out = decide(compiled, foldRun("wfr_00000000000000000000", facts), {
        now: Date.parse("2026-11-02T10:00:01.000Z"),
        runDir: "/runs/wfr_00000000000000000000",
        failureSubscribers: [],
      });
      for (const f of out) if (f.stream === "run:wfr_00000000000000000000") add(f.key, f.fact);
      return out;
    };
    add("started", {
      _tag: "RunStarted",
      workflowId: "demo",
      commit: "c1",
      hash: "h",
      title: "Demo",
      params: {},
      trigger: { kind: "manual", occurrence: "manual:1", label: "manual", payload: null },
      budget: { steps: 10, wallMs: 7_200_000, tokens: 100_000, usd: null },
      parent: null,
      causalDepth: 0,
      at: "2026-11-02T10:00:00.000Z",
    });
    expect(step().map((f) => f.key)).toEqual(["ws:integ"]);
    add("result:ws:integ", {
      _tag: "WorkspaceReady",
      name: "integ",
      path: "/runs/x/integ",
      branch: "wf/demo",
      headSha: "a1",
    });
    expect(step().map((f) => f.key)).toEqual(["turn:plan@1"]);
    add("result:turn:plan@1", { _tag: "TurnStarted", threadId: "wf:x" });
    expect(step()).toEqual([]);
    add("settled:plan@1", {
      _tag: "TurnSettled",
      step: "plan",
      attempt: 1,
      status: "completed",
      text: "done",
      output: { tag: "v7" },
      outputError: null,
      cost,
      headSha: "b2",
    });
    const third = step();
    expect(third.map((f) => f.key)).toEqual(["resolved:plan@1", "unit:test@1"]);
    const unit = third[1]?.fact;
    expect(
      unit?._tag === "IntentRecorded" && unit.intent._tag === "StartUnit" && unit.intent.argv,
    ).toEqual(["node", "check.ts", "v7"]);
    add("result:unit:test@1", {
      _tag: "UnitSpawned",
      unit: "wf-x",
      at: "2026-11-02T10:00:01.000Z",
    });
    add("exited:test@1", {
      _tag: "UnitExited",
      step: "test",
      attempt: 1,
      exit: 0,
      signal: null,
      queuedMs: 0,
      out: null,
      tail: "",
      lost: false,
      started: true,
    });
    const last = step();
    expect(last.map((f) => `${f.stream} ${f.key}`)).toEqual([
      "run:wfr_00000000000000000000 resolved:test@1",
      "run:wfr_00000000000000000000 resolved:done@1",
      "run:wfr_00000000000000000000 output",
      "run:wfr_00000000000000000000 skip:stuck",
      "run:wfr_00000000000000000000 ended",
      "workflow:demo outcome:wfr_00000000000000000000",
    ]);
  });
});

const runId = "wfr_00000000000000000000";
const stream = `run:${runId}`;
const at = "2026-11-02T10:00:00.000Z";

function harness() {
  const facts: StoredFact[] = [];
  const add = (key: string, fact: Fact) => {
    facts.push({ stream, seq: facts.length + 1, key, fact, at });
  };
  const run = () =>
    decide(compiled, foldRun(runId, facts), {
      now: 1793613601000,
      runDir: `/runs/${runId}`,
      failureSubscribers: [],
    });
  const drive = () => {
    const out = run();
    for (const f of out) if (f.stream === stream) add(f.key, f.fact);
    return out;
  };
  add("started", {
    _tag: "RunStarted",
    workflowId: "demo",
    commit: "c1",
    hash: "h",
    title: "Demo",
    params: {},
    trigger: { kind: "manual", occurrence: "manual:1", label: "manual", payload: null },
    budget: { steps: 10, wallMs: 7200000, tokens: 100000, usd: null },
    parent: null,
    causalDepth: 0,
    at,
  });
  return { add, run, drive };
}

function ready(h: ReturnType<typeof harness>) {
  h.drive();
  h.add("result:ws:integ", {
    _tag: "WorkspaceReady",
    name: "integ",
    path: "/runs/x/integ",
    branch: "wf/demo",
    headSha: "a1",
  });
}

it("returns identical facts for identical folded state", () => {
  const h = harness();
  expect(h.run()).toEqual(h.run());
});

it.each([false, true])("does not redispatch a recorded turn, started=%s", (started) => {
  const h = harness();
  ready(h);
  expect(h.drive().map((f) => f.key)).toEqual(["turn:plan@1"]);
  if (started) h.add("result:turn:plan@1", { _tag: "TurnStarted", threadId: "wf:x" });
  expect(h.run()).toEqual([]);
});

it("waits for workspace preparation without redispatching", () => {
  const h = harness();
  expect(h.drive().map((f) => f.key)).toEqual(["ws:integ"]);
  expect(h.run()).toEqual([]);
});

it.each([false, true])("does not redispatch a recorded command, spawned=%s", (spawned) => {
  const h = harness();
  ready(h);
  h.drive();
  h.add("result:turn:plan@1", { _tag: "TurnStarted", threadId: "wf:x" });
  h.add("settled:plan@1", {
    _tag: "TurnSettled",
    step: "plan",
    attempt: 1,
    status: "completed",
    text: "done",
    output: { tag: "v7" },
    outputError: null,
    cost,
  });
  expect(h.drive().map((f) => f.key)).toEqual(["resolved:plan@1", "unit:test@1"]);
  if (spawned) h.add("result:unit:test@1", { _tag: "UnitSpawned", unit: "wf-x", at });
  expect(h.run()).toEqual([]);
});

const commandNode = { kind: "command", cwd: "integ", argv: ["node", "x.ts"] };
const agentNode = { kind: "agent", model: "$lead", prompt: "Work", workspace: "integ" };

function decision(gateKey: string, option: string): Fact {
  return { _tag: "GateDecided", gateKey, option, note: null, by: "user", at: iso(T0 + 2000) };
}

it.each(["cancel"])("asks before replaying an ambiguous command: %s", (option) => {
  const run = TestRun.start(
    compile({
      nodes: { c: commandNode, recovery: agentNode },
      edges: ["c:fail -> recovery"],
    }),
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
  run.add("exited:c@1", unitExited("c", 1, null, { lost: true, started: true }));
  expect(keysOf(run.drive())).toEqual(
    expect.arrayContaining(["open:ambiguous:c@1", "pause:1", "notify:gate:ambiguous:c@1"]),
  );
  expect(run.intent("open:ambiguous:c@1")).toMatchObject({
    reason: "ambiguous",
    options: ["rerun", "fail", "cancel"],
  });
  expect(run.intent("notify:gate:ambiguous:c@1")).toMatchObject({ kind: "needs_you" });
  expect(run.intent("unit:c@2")).toBeUndefined();
  expect(run.decide()).toEqual([]);
  run.add("gate:ambiguous:c@1", decision("ambiguous:c@1", option));
  const out = run.drive();
  expect(keysOf(out)).toContain("resume:1");
  if (option === "rerun") expect(keysOf(out)).toContain("unit:c@2");
  if (option === "fail") {
    expect(run.state().attempts.get("c")?.[0]?.resolved).toMatchObject({
      status: "failed",
      port: "fail",
    });
    expect(keysOf(out)).toContain("turn:recovery@1");
  }
  if (option === "cancel")
    expect(out.find((f) => f.key === "ended")?.fact).toMatchObject({ status: "cancelled" });
});

it("keeps the first gate decision", () => {
  const run = TestRun.start(
    compile({
      nodes: { g: { kind: "gate", ask: "Proceed?", options: ["approve", "reject"] } },
      edges: [],
    }),
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
  run.add("gate:g@1", decision("g@1", "approve"));
  run.add("second-decision", decision("g@1", "reject"));
  expect(run.drive().find((f) => f.key === "resolved:g@1")?.fact).toMatchObject({
    port: "approve",
  });
});

it("propagates a false guard through a dead path", () => {
  const run = TestRun.start(
    compile({
      nodes: { a: commandNode, b: { ...commandNode, when: "false" }, c: commandNode },
      edges: ["a -> b", "b -> c"],
    }),
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
  run.add("exited:a@1", unitExited("a", 1, 0));
  const out = run.drive();
  expect(out.find((f) => f.key === "skip:b")?.fact).toMatchObject({ reason: "guard" });
  expect(out.find((f) => f.key === "skip:c")?.fact).toMatchObject({ reason: "dead-path" });
});

function prepare(run: TestRun) {
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

it("retries an unexpectedly cancelled agent in a new thread in the same workspace", () => {
  const run = prepare(
    TestRun.start(
      compile({ nodes: { a: { ...agentNode, access: "write", retry: { max: 1, on: ["lost"] } } } }),
    ),
  );
  const first = run.intent("turn:a@1");
  run.add("result:turn:a@1", { _tag: "TurnStarted", threadId: "wf:first" });
  run.add("settled:a@1", turnSettled("a", 1, "cancelled"));
  expect(keysOf(run.drive())).toContain("turn:a@2");
  expect(run.state().attempts.get("a")?.[0]?.resolved).toMatchObject({ status: "lost" });
  const second = run.intent("turn:a@2");
  expect(first?._tag).toBe("StartTurn");
  if (first?._tag !== "StartTurn" || second?._tag !== "StartTurn") throw new Error("Missing turns");
  expect(second.threadId).not.toBe(first.threadId);
  expect(second.workspace?.path).toBe(first.workspace?.path);
});

it.each([
  { replay: "safe", started: true },
  { replay: "never", started: false },
])("retries lost command with $replay replay and started=$started", ({ replay, started }) => {
  const run = prepare(TestRun.start(compile({ nodes: { c: { ...commandNode, replay } } })));
  run.add("result:unit:c@1", { _tag: "UnitSpawned", unit: "u", at: iso(T0) });
  run.add("exited:c@1", unitExited("c", 1, null, { lost: true, started }));
  expect(keysOf(run.drive())).toContain("unit:c@2");
  expect(run.state().attempts.get("c")?.[0]?.resolved).toMatchObject({ status: "lost" });
});

it.each(["rerun", "fail"])("resumes an ambiguous command with %s in one pass", (option) => {
  const run = prepare(
    TestRun.start(
      compile({ nodes: { c: commandNode, recovery: commandNode }, edges: ["c:fail -> recovery"] }),
    ),
  );
  run.add("result:unit:c@1", { _tag: "UnitSpawned", unit: "u", at: iso(T0) });
  run.add("exited:c@1", unitExited("c", 1, null, { lost: true, started: true }));
  expect(keysOf(run.drive())).toEqual(
    expect.arrayContaining(["open:ambiguous:c@1", "pause:1", "notify:gate:ambiguous:c@1"]),
  );
  expect(run.intent("open:ambiguous:c@1")).toMatchObject({
    reason: "ambiguous",
    options: ["rerun", "fail", "cancel"],
  });
  expect(run.intent("notify:gate:ambiguous:c@1")).toMatchObject({ kind: "needs_you" });
  expect(run.intent("unit:c@2")).toBeUndefined();
  run.add("gate:ambiguous:c@1", decision("ambiguous:c@1", option));
  expect(keysOf(run.drive())).toEqual(
    expect.arrayContaining([
      "resume:1",
      "resolved:c@1",
      option === "rerun" ? "unit:c@2" : "unit:recovery@1",
    ]),
  );
  expect(run.state().attempts.get("c")?.[0]?.resolved).toMatchObject(
    option === "rerun" ? { status: "ambiguous" } : { status: "failed", port: "fail" },
  );
});

it.each([0, 1])(
  "publishes failure outcomes without recursive triggers at depth %s",
  (causalDepth) => {
    const run = new TestRun(compile({ nodes: { c: commandNode } }), [
      { workflowId: "other", triggerId: "t" },
      { workflowId: "demo", triggerId: "self" },
    ]);
    run.add("started", runStarted({ causalDepth }));
    prepare(run);
    run.add("exited:c@1", unitExited("c", 1, 1));
    const out = run.drive();
    expect(keysOf(out)).toEqual(
      expect.arrayContaining([
        "resolved:c@1",
        "ended",
        `workflow:demo outcome:${RUN_ID}`,
        "notify:end",
      ]),
    );
    expect(out.find((f) => f.key === "ended")?.fact).toMatchObject({
      _tag: "RunEnded",
      status: "failed",
    });
    expect(run.intent("notify:end")).toMatchObject({ kind: "failed" });
    expect(out.filter((f) => f.stream === "workflow:demo").map((f) => f.key)).toEqual([
      `outcome:${RUN_ID}`,
    ]);
    expect(out.filter((f) => f.fact._tag === "TriggerFired")).toEqual(
      causalDepth === 1
        ? []
        : [
            expect.objectContaining({
              stream: "workflow:other",
              key: `run-failed:${RUN_ID}`,
              fact: expect.objectContaining({ causalDepth: 1 }),
            }),
          ],
    );
  },
);

it.each(["default", "any"])("dispatches fan-in with join %s", (join) => {
  const run = prepare(
    TestRun.start(
      compile({
        nodes: {
          a: { ...commandNode, ...(join === "default" ? { when: "false" } : {}) },
          b: commandNode,
          d: { ...commandNode, ...(join === "any" ? { join } : {}) },
        },
        edges: ["a -> d", "b -> d"],
      }),
    ),
  );
  if (join === "any") run.add("result:unit:a@1", { _tag: "UnitSpawned", unit: "a", at: iso(T0) });
  run.add("exited:b@1", unitExited("b", 1, 0));
  expect(keysOf(run.drive())).toContain("unit:d@1");
});

it.each(["approve", "reject", "allowed"])("guards protected commands: %s", (option) => {
  const argv =
    option === "allowed" ? ["node", "x.ts"] : ["git", "push", "origin", "HEAD:friend/main"];
  const run = prepare(TestRun.start(compile({ nodes: { c: { ...commandNode, argv } } })));
  if (option !== "allowed") {
    expect(run.intent("open:protect:c@1")).toMatchObject({ reason: "protected" });
    expect(run.intent("notify:gate:protect:c@1")).toBeDefined();
    expect(run.intent("unit:c@1")).toBeUndefined();
    run.add("gate:protect:c@1", decision("protect:c@1", option));
    run.drive();
  } else expect(run.intent("open:protect:c@1")).toBeUndefined();
  if (option === "reject") {
    expect(run.state().attempts.get("c")?.[0]?.resolved).toMatchObject({
      status: "failed",
      port: "fail",
    });
    expect(run.intent("unit:c@1")).toBeUndefined();
  } else expect(run.intent("unit:c@1")).toMatchObject({ argv });
});

it("refuses an approved protected command whose argv changed after the gate opened", () => {
  const argv = ["git", "push", "origin", "{{workspaces.integ.head}}:friend/main"];
  const run = prepare(
    TestRun.start(
      compile({
        nodes: {
          c: { ...commandNode, argv },
          w: commandNode,
          done: { kind: "output", status: "ready_for_review", value: {} },
        },
        edges: ["c -> done", "w -> done"],
      }),
    ),
  );
  expect(run.intent("open:protect:c@1")).toMatchObject({ ask: expect.stringContaining("a1") });
  // A parallel writer moves the workspace head before Israel decides.
  run.add("exited:w@1", unitExited("w", 1, 0, { headSha: "b2" }));
  run.drive();
  run.add("gate:protect:c@1", decision("protect:c@1", "approve"));
  run.drive();
  expect(run.intent("unit:c@1")).toBeUndefined();
  expect(run.state().attempts.get("c")?.[0]?.resolved).toMatchObject({
    status: "failed",
    error: expect.stringContaining("changed after Israel approved"),
  });
});

it.each(["first", "else", "dead"])("selects branch path %s", (mode) => {
  const run = prepare(
    TestRun.start(
      compile({
        params: { n: { type: "number", default: 1 } },
        nodes: {
          b: {
            kind: "branch",
            cases: [
              { port: "x", when: mode === "first" ? "params.n == 1" : "false" },
              { port: "y", when: mode === "first" ? "true" : "false" },
            ],
            ...(mode === "dead" ? {} : { else: "z" }),
          },
          next: commandNode,
        },
        edges: ["b:x -> next"],
      }),
      runStarted({ params: { n: 1 } }),
    ),
  );
  expect(run.state().attempts.get("b")?.[0]?.resolved).toMatchObject({
    port: mode === "first" ? "x" : mode === "else" ? "z" : null,
  });
  if (mode === "dead") expect(run.state().skipped.get("next")).toBe("dead-path");
});

it("expires a gate to its decision and resolves it in the same pass", () => {
  const compiled = compile({
    nodes: {
      g: {
        kind: "gate",
        ask: "Ship?",
        options: ["approve", "reject"],
        expires: { after: "1h", decision: "reject" },
      },
    },
    edges: [],
  });
  const run = TestRun.start(compiled);
  const opened = run.drive(T0 + 1_000);
  const open = opened.find((f) => f.key === "open:g@1")?.fact;
  expect(
    open?._tag === "IntentRecorded" && open.intent._tag === "OpenGate" && open.intent.expiresAt,
  ).toBe(iso(T0 + 1_000 + 3_600_000));
  const expired = run.drive(T0 + 3_600_000 + 2_000);
  const decided = expired.find((f) => f.key === "gate:g@1")?.fact;
  expect(decided?._tag === "GateDecided" && [decided.by, decided.option]).toEqual([
    "expiry",
    "reject",
  ]);
  const resolved = expired.find((f) => f.key === "resolved:g@1")?.fact;
  expect(resolved?._tag === "StepResolved" && resolved.port).toBe("reject");
});

describe("review regressions", () => {
  const ready = (nodes: Record<string, unknown>, edges: ReadonlyArray<string>, patch = {}) => {
    const run = TestRun.start(compile({ nodes, edges, ...patch }));
    run.drive();
    run.add("result:ws:integ", {
      _tag: "WorkspaceReady",
      name: "integ",
      path: "/runs/x/integ",
      branch: "wf/demo",
      headSha: "a1",
    });
    return run;
  };
  const control = (control: "pause" | "resume" | "cancel"): Fact => ({
    _tag: "ControlRequested",
    control,
    step: null,
    by: "user",
    at: iso(T0),
  });

  it("applies a pause once: a resume is not followed by the old pause again", () => {
    const run = ready({ a: commandNode }, []);
    run.drive();
    run.add("control:p", control("pause"));
    expect(keysOf(run.drive())).toContain("pause:control:p");
    run.add("control:r", control("resume"));
    expect(keysOf(run.drive())).toContain("resume:control:r");
    expect(keysOf(run.drive()).some((k) => k.startsWith("pause:"))).toBe(false);
  });

  it("admits no more steps than the budget in one pass", () => {
    const run = ready(
      { a: commandNode, b: commandNode, done: { kind: "output", status: "no_change", value: {} } },
      ["a -> done", "b -> done"],
      { budget: { steps: 1, wall: "2h", tokens: 100_000 } },
    );
    run.facts[0] = {
      ...run.facts[0]!,
      fact: runStarted({ budget: { steps: 1, wallMs: 7_200_000, tokens: 100_000, usd: null } }),
    };
    const out = keysOf(run.drive());
    expect(out.filter((k) => k.startsWith("unit:"))).toEqual(["unit:a@1"]);
  });

  it("ends on an unhandled failure in the same pass and interrupts the running sibling", () => {
    const run = ready(
      { a: commandNode, b: commandNode, done: { kind: "output", status: "no_change", value: {} } },
      ["a -> done", "b -> done"],
    );
    run.drive();
    run.add("result:unit:a@1", { _tag: "UnitSpawned", unit: "wf-a", at: iso(T0) });
    run.add("result:unit:b@1", { _tag: "UnitSpawned", unit: "wf-b", at: iso(T0) });
    run.add("exited:a@1", unitExited("a", 1, 1));
    const out = keysOf(run.drive());
    expect(out).toEqual(expect.arrayContaining(["resolved:a@1", "ended", "interrupt:unit:b@1"]));
  });

  it("resolves a step whose start intent failed for good", () => {
    const run = ready({ a: commandNode }, []);
    run.drive();
    run.add("result:unit:a@1", {
      _tag: "IntentFailed",
      error: "no such project",
      retryable: false,
    });
    const resolved = run.drive().find((f) => f.key === "resolved:a@1")?.fact;
    expect(resolved?._tag === "StepResolved" && [resolved.status, resolved.error]).toEqual([
      "failed",
      "no such project",
    ]);
  });

  it("interrupts a unit whose start receipt arrives after a cancel ended the run", () => {
    const run = ready({ a: commandNode }, []);
    run.drive();
    run.add("control:c", control("cancel"));
    expect(keysOf(run.drive())).toContain("ended");
    run.add("result:unit:a@1", { _tag: "UnitSpawned", unit: "wf-a", at: iso(T0) });
    expect(keysOf(run.drive())).toEqual(["interrupt:unit:a@1"]);
  });

  it("gates a protected accept command", () => {
    const run = ready(
      {
        a: {
          kind: "agent",
          model: "$lead",
          prompt: "Do",
          workspace: "integ",
          access: "write",
          accept: { argv: ["git", "push", "origin", "HEAD:friend/main"], check: "exit == 0" },
        },
      },
      [],
    );
    run.drive();
    run.add("result:turn:a@1", { _tag: "TurnStarted", threadId: "wf:x" });
    run.add("settled:a@1", turnSettled("a", 1, "completed"));
    const out = keysOf(run.drive());
    expect(out).toContain("open:protect:a/accept@1");
    expect(out).not.toContain("accept:a@1");
  });

  it("resolves a call whose child ended before its start receipt was stored", () => {
    const run = TestRun.start(
      compile({ nodes: { c: { kind: "call", workflow: "other", params: {} } }, edges: [] }),
    );
    run.drive();
    run.add("child:wfr_child", {
      _tag: "ChildRunEnded",
      childRunId: "wfr_child",
      status: "succeeded",
      output: { x: 1 },
      cost: {
        billable: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        usage: "unavailable",
        usdEstimate: null,
      },
    });
    run.add("result:child:c@1", { _tag: "ChildRunStarted", childRunId: "wfr_child" });
    const resolved = run.drive().find((f) => f.key === "resolved:c@1")?.fact;
    expect(resolved?._tag === "StepResolved" && resolved.port).toBe("ok");
  });

  it("schedules no backoff deadline for an attempt that succeeded", () => {
    const run = ready(
      {
        a: { ...commandNode, retry: { max: 2, on: ["failed"], backoff: "10m" } },
        g: { kind: "gate", ask: "ok?" },
      },
      ["a -> g"],
    );
    run.drive();
    run.add("result:unit:a@1", { _tag: "UnitSpawned", unit: "wf-a", at: iso(T0) });
    run.add("exited:a@1", unitExited("a", 1, 0));
    run.drive();
    expect(run.deadline()).toBe(T0 + 7_200_000);
  });

  it("runs a retried loop's body afresh under the attempt's scope", () => {
    const run = ready(
      {
        l: {
          kind: "loop",
          max: 1,
          until: "false",
          retry: { max: 1, on: ["failed"] },
          body: { nodes: { w: commandNode }, edges: [] },
        },
      },
      [],
    );
    run.drive();
    run.add("result:unit:l[0]/w@1", { _tag: "UnitSpawned", unit: "wf-w", at: iso(T0) });
    run.add("exited:l[0]/w@1", unitExited("l[0]/w", 1, 0));
    const out = keysOf(run.drive());
    expect(out).toEqual(
      expect.arrayContaining(["resolved:l@1", "iter:l/r2:0", "unit:l/r2[0]/w@1"]),
    );
  });
  it("counts an accept command against the step budget", () => {
    const run = ready(
      {
        a: {
          kind: "agent",
          model: "$lead",
          prompt: "Do",
          workspace: "integ",
          access: "write",
          accept: { argv: ["node", "check.ts"], check: "exit == 0" },
        },
      },
      [],
      { budget: { steps: 1, wall: "2h", tokens: 100_000 } },
    );
    run.facts[0] = {
      ...run.facts[0]!,
      fact: runStarted({ budget: { steps: 1, wallMs: 7_200_000, tokens: 100_000, usd: null } }),
    };
    run.drive();
    run.add("result:turn:a@1", { _tag: "TurnStarted", threadId: "wf:x" });
    run.add("settled:a@1", turnSettled("a", 1, "completed"));
    const out = keysOf(run.drive());
    expect(out).not.toContain("accept:a@1");
    expect(out).toContain("ended");
  });

  it("interrupts a running nudge when the run is cancelled", () => {
    const run = ready(
      {
        a: {
          kind: "agent",
          model: "$lead",
          prompt: "Do",
          workspace: "integ",
          access: "write",
          output: { tag: { type: "string" } },
        },
      },
      [],
    );
    run.drive();
    run.add("result:turn:a@1", { _tag: "TurnStarted", threadId: "wf:x" });
    run.add("settled:a@1", turnSettled("a", 1, "completed", null, "no json"));
    expect(keysOf(run.drive())).toContain("nudge:a@1");
    run.add("result:nudge:a@1", { _tag: "TurnStarted", threadId: "wf:x" });
    run.add("control:c", control("cancel"));
    expect(keysOf(run.drive())).toEqual(expect.arrayContaining(["ended", "interrupt:nudge:a@1"]));
  });

  it("resolves a step whose nudge could not start", () => {
    const run = ready(
      {
        a: {
          kind: "agent",
          model: "$lead",
          prompt: "Do",
          workspace: "integ",
          access: "write",
          output: { tag: { type: "string" } },
        },
      },
      [],
    );
    run.drive();
    run.add("result:turn:a@1", { _tag: "TurnStarted", threadId: "wf:x" });
    run.add("settled:a@1", turnSettled("a", 1, "completed", null, "no json"));
    run.drive();
    run.add("result:nudge:a@1", { _tag: "IntentFailed", error: "thread gone", retryable: false });
    const resolved = run.drive().find((f) => f.key === "resolved:a@1")?.fact;
    expect(resolved?._tag === "StepResolved" && resolved.status).toBe("failed");
  });

  it("schedules the next future deadline when a turn's timeout no longer applies", () => {
    const run = ready(
      {
        a: {
          kind: "agent",
          model: "$lead",
          prompt: "Do",
          workspace: "integ",
          access: "write",
          timeout: "1m",
          accept: { argv: ["git", "push", "origin", "HEAD:friend/main"], check: "exit == 0" },
        },
      },
      [],
    );
    run.drive();
    run.add("result:turn:a@1", { _tag: "TurnStarted", threadId: "wf:x" }, T0);
    run.add("settled:a@1", turnSettled("a", 1, "completed"));
    run.drive();
    expect(run.deadline(T0 + 90_000)).toBe(T0 + 7_200_000);
  });

  describe("panel regressions", () => {
    const tagged = {
      kind: "agent",
      model: "$lead",
      prompt: "Tag",
      workspace: "integ",
      access: "write",
      output: { tag: { type: "string", pattern: "^v[0-9]+$" } },
    };
    const push = {
      kind: "command",
      cwd: "integ",
      argv: ["node", "tag.ts", "{{nodes.a.output.tag}}"],
    };

    it("checks an agent's output against its shape before a successor uses it", () => {
      const run = ready({ a: tagged, c: push }, ["a -> c"]);
      run.drive();
      run.add("result:turn:a@1", { _tag: "TurnStarted", threadId: "wf:x" });
      run.add("settled:a@1", turnSettled("a", 1, "completed", { tag: "--unexpected-option" }));
      const out = keysOf(run.drive());
      expect(out).toContain("nudge:a@1");
      expect(out).not.toContain("unit:c@1");
      run.add("result:nudge:a@1", { _tag: "TurnStarted", threadId: "wf:x" });
      run.add("settled:a@1:nudge", turnSettled("a", 1, "completed", { tag: "v2", extra: "-rf" }));
      run.drive();
      expect(run.state().attempts.get("a")?.[0]?.resolved).toMatchObject({
        status: "succeeded",
        output: { tag: "v2" },
      });
      expect(run.intent("unit:c@1")).toMatchObject({ argv: ["node", "tag.ts", "v2"] });
    });

    it("fails the step when the correction turn's output is still invalid", () => {
      const run = ready({ a: tagged, c: push }, ["a -> c"]);
      run.drive();
      run.add("result:turn:a@1", { _tag: "TurnStarted", threadId: "wf:x" });
      run.add("settled:a@1", turnSettled("a", 1, "completed", { tag: "x" }));
      run.drive();
      run.add("result:nudge:a@1", { _tag: "TurnStarted", threadId: "wf:x" });
      run.add("settled:a@1:nudge", turnSettled("a", 1, "completed", { tag: "--force" }));
      run.drive();
      expect(run.state().attempts.get("a")?.[0]?.resolved).toMatchObject({
        status: "failed",
        error: "tag does not match ^v[0-9]+$",
      });
      expect(run.intent("unit:c@1")).toBeUndefined();
    });

    it("takes no verdict from a judge turn that did not complete", () => {
      const run = ready(
        {
          a: { ...agentNode, access: "write", accept: { judge: "$sol", criterion: "Done?" } },
        },
        [],
      );
      run.drive();
      run.add("result:turn:a@1", { _tag: "TurnStarted", threadId: "wf:x" });
      run.add("settled:a@1", turnSettled("a", 1, "completed"));
      run.drive();
      run.add("result:judge:a@1", { _tag: "TurnStarted", threadId: "wf:j" });
      run.add("settled:a/judge@1", turnSettled("a/judge", 1, "failed", { pass: true }));
      run.drive();
      expect(run.state().attempts.get("a")?.[0]?.resolved).toMatchObject({ port: "fail" });
    });

    it("applies the step's timeout to its judge turn", () => {
      const run = ready(
        {
          a: {
            ...agentNode,
            access: "write",
            timeout: "1m",
            accept: { judge: "$sol", criterion: "Done?" },
          },
        },
        [],
      );
      run.drive();
      run.add("result:turn:a@1", { _tag: "TurnStarted", threadId: "wf:x" });
      run.add("settled:a@1", turnSettled("a", 1, "completed"));
      run.drive();
      run.add("result:judge:a@1", { _tag: "TurnStarted", threadId: "wf:j" }, T0);
      expect(keysOf(run.drive(T0 + 90_000))).toContain("interrupt:judge:a@1");
    });

    it("fails a turn stopped outside the workflow instead of replaying it", () => {
      const run = ready({ a: { ...agentNode, access: "write" } }, []);
      run.drive();
      run.add("result:turn:a@1", { _tag: "TurnStarted", threadId: "wf:x" });
      run.add("settled:a@1", turnSettled("a", 1, "interrupted"));
      expect(keysOf(run.drive())).not.toContain("turn:a@2");
      expect(run.state().attempts.get("a")?.[0]?.resolved).toMatchObject({ status: "failed" });
    });

    it("pauses for Israel on a command the engine could not observe, retry policy or not", () => {
      const run = ready(
        {
          c: {
            ...commandNode,
            replay: "never",
            check: "exit != 1",
            retry: { max: 1, on: ["failed"] },
          },
        },
        [],
      );
      run.drive();
      run.add("result:unit:c@1", { _tag: "UnitSpawned", unit: "u", at: iso(T0) });
      run.add("exited:c@1", unitExited("c", 1, null, { signal: "UNOBSERVED", tail: "unreadable" }));
      const out = keysOf(run.drive());
      expect(out).not.toContain("unit:c@2");
      expect(out).toContain("open:ambiguous:c@1");
      expect(run.state().paused?.reason).toBe("ambiguous");
    });

    it("retries nothing after Israel marks an unobserved command failed", () => {
      const run = ready(
        { c: { ...commandNode, replay: "never", retry: { max: 1, on: ["failed"] } } },
        [],
      );
      run.drive();
      run.add("result:unit:c@1", { _tag: "UnitSpawned", unit: "u", at: iso(T0) });
      run.add("exited:c@1", unitExited("c", 1, null, { signal: "UNOBSERVED", tail: "unreadable" }));
      run.drive();
      run.add("gate:ambiguous:c@1", decision("ambiguous:c@1", "fail"));
      const out = keysOf(run.drive());
      expect(out).toContain("resolved:c@1");
      expect(out).not.toContain("unit:c@2");
      expect(run.state().ended?.status).toBe("failed");
    });

    it("pauses for Israel on a turn the engine could not observe", () => {
      const run = ready(
        { a: { ...agentNode, access: "write", retry: { max: 1, on: ["failed"] } } },
        [],
      );
      run.drive();
      run.add("result:turn:a@1", { _tag: "TurnStarted", threadId: "wf:x" });
      const unknown = turnSettled("a", 1, "failed");
      if (unknown._tag !== "TurnSettled") throw new Error("fixture");
      run.add("settled:a@1", { ...unknown, unobserved: true, text: "projection unavailable" });
      const out = keysOf(run.drive());
      expect(out).not.toContain("turn:a@2");
      expect(out).toContain("open:ambiguous:a@1");
    });

    it("reads no check from an accept command whose outcome is unknown", () => {
      const run = ready(
        {
          a: {
            ...agentNode,
            access: "write",
            accept: { argv: ["node", "t.ts"], check: "exit != 1" },
          },
        },
        [],
      );
      run.drive();
      run.add("result:turn:a@1", { _tag: "TurnStarted", threadId: "wf:x" });
      run.add("settled:a@1", turnSettled("a", 1, "completed"));
      run.drive();
      run.add("result:accept:a@1", { _tag: "UnitSpawned", unit: "u", at: iso(T0) });
      run.add("exited:a/accept@1", unitExited("a/accept", 1, null, { lost: true }));
      run.drive();
      expect(run.state().attempts.get("a")?.[0]?.resolved).toMatchObject({ status: "failed" });
    });

    it.each(["nudge", "judge"] as const)(
      "replays the step when upstream cancels its %s turn",
      (kind) => {
        const run = ready(
          {
            a: {
              ...agentNode,
              access: "write",
              ...(kind === "nudge"
                ? { output: { tag: { type: "string" } } }
                : { accept: { judge: "$sol", criterion: "Done?" } }),
            },
          },
          [],
        );
        run.drive();
        run.add("result:turn:a@1", { _tag: "TurnStarted", threadId: "wf:x" });
        run.add("settled:a@1", turnSettled("a", 1, "completed", null, "no json"));
        run.drive();
        if (kind === "nudge") {
          run.add("result:nudge:a@1", { _tag: "TurnStarted", threadId: "wf:x" });
          run.add("settled:a@1:nudge", turnSettled("a", 1, "cancelled"));
        } else {
          run.add("result:judge:a@1", { _tag: "TurnStarted", threadId: "wf:j" });
          run.add("settled:a/judge@1", turnSettled("a/judge", 1, "cancelled"));
        }
        expect(keysOf(run.drive())).toContain("turn:a@2");
        expect(run.state().attempts.get("a")?.[0]?.resolved).toMatchObject({ status: "lost" });
      },
    );

    it("replays a lost agent turn without a retry policy", () => {
      const run = ready({ a: { ...agentNode, access: "write" } }, []);
      run.drive();
      run.add("result:turn:a@1", { _tag: "TurnStarted", threadId: "wf:x" });
      run.add("settled:a@1", turnSettled("a", 1, "cancelled"));
      expect(keysOf(run.drive())).toContain("turn:a@2");
    });

    it("replays a lost safe command at once even when its retry policy has a backoff", () => {
      const run = ready(
        {
          c: {
            ...commandNode,
            replay: "safe",
            retry: { max: 1, on: ["failed"], backoff: "10m" },
          },
        },
        [],
      );
      run.drive();
      run.add("result:unit:c@1", { _tag: "UnitSpawned", unit: "u", at: iso(T0) });
      run.add("exited:c@1", unitExited("c", 1, null, { lost: true, started: true }));
      expect(keysOf(run.drive())).toContain("unit:c@2");
    });

    it("gives a continuation its own token reservation", () => {
      const run = ready(
        {
          a: { ...agentNode, access: "write", tokenReservation: 1000 },
          b: {
            ...agentNode,
            access: "write",
            thread: "continue:a",
            tokenReservation: 9000,
          },
        },
        ["a -> b"],
      );
      run.drive();
      run.add("result:turn:a@1", { _tag: "TurnStarted", threadId: "wf:x" });
      run.add("settled:a@1", turnSettled("a", 1, "completed"));
      run.drive();
      expect(run.intent("turn:b@1")).toMatchObject({ mode: "continue", reservation: 9000 });
    });

    it("reaches an output after the last start the budget allows", () => {
      const run = TestRun.start(
        compile({
          budget: { steps: 1, wall: "2h", tokens: 100000 },
          nodes: {
            a: commandNode,
            done: { kind: "output", status: "ready_for_review", value: {} },
          },
          edges: ["a -> done"],
        }),
        runStarted({ budget: { steps: 1, wallMs: 7200000, tokens: 100000, usd: null } }),
      );
      prepare(run);
      run.add("exited:a@1", unitExited("a", 1, 0));
      expect(run.drive().find((f) => f.key === "ended")?.fact).toMatchObject({
        status: "succeeded",
      });
    });

    it("resolves the attempts a cancel stops", () => {
      const run = ready({ c: commandNode }, []);
      run.drive();
      run.add("result:unit:c@1", { _tag: "UnitSpawned", unit: "u", at: iso(T0) });
      run.add("control:c", control("cancel"));
      run.drive();
      expect(run.state().attempts.get("c")?.[0]?.resolved).toMatchObject({ status: "cancelled" });
    });

    it("stays paused while another ambiguous gate waits", () => {
      const run = ready(
        {
          x: { ...commandNode, replay: "never" },
          y: { ...commandNode, replay: "never" },
          done: { kind: "output", status: "ready_for_review", value: {} },
        },
        ["x -> done", "y -> done"],
      );
      run.drive();
      for (const step of ["x", "y"]) {
        run.add(`result:unit:${step}@1`, { _tag: "UnitSpawned", unit: step, at: iso(T0) });
        run.add(`exited:${step}@1`, unitExited(step, 1, null, { lost: true, started: true }));
      }
      run.drive();
      expect(run.state().paused?.reason).toBe("ambiguous");
      run.add("gate:ambiguous:x@1", decision("ambiguous:x@1", "fail"));
      expect(keysOf(run.drive()).some((k) => k.startsWith("resume:"))).toBe(false);
      expect(run.state().paused?.reason).toBe("ambiguous");
    });
  });
});
