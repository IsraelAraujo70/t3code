import { describe, expect, it } from "vite-plus/test";

import {
  compile,
  cost,
  iso,
  keysOf,
  runStarted,
  T0,
  TestRun,
  turnSettled,
  unitExited,
} from "./testkit/decideHarness.ts";

const agent = {
  kind: "agent",
  model: "$lead",
  prompt: "Work",
  workspace: "integ",
  access: "write",
};
const command = { kind: "command", argv: ["node", "w.ts"], cwd: "integ" };
const ready = (nodes: Record<string, unknown>, edges: string[] = []) => {
  const run = TestRun.start(compile({ nodes, edges }));
  run.drive();
  run.add("result:ws:integ", {
    _tag: "WorkspaceReady",
    name: "integ",
    path: "/work/integ",
    branch: "wf/demo",
    headSha: "abc",
  });
  run.drive();
  return run;
};
const running = (patch: Record<string, unknown> = {}) => {
  const run = ready({ a: { ...agent, ...patch } });
  run.add("result:turn:a@1", { _tag: "TurnStarted", threadId: "thread-a" }, T0);
  return run;
};
const resolved = (run: TestRun, key: string) => run.decide().find((f) => f.key === key)?.fact;

describe("run decider primitives", () => {
  it.each([null, "still no json"])(
    "nudges invalid output once and resolves the follow-up (%s)",
    (error) => {
      const run = running({ output: { tag: { type: "string", pattern: "^v\\d+$" } } });
      run.add("settled:a@1", turnSettled("a", 1, "completed", null, "no json"));
      run.drive();
      expect(run.intent("nudge:a@1")).toMatchObject({
        _tag: "StartTurn",
        mode: "continue",
        threadId: "thread-a",
      });
      run.add("settled:a@1:nudge", turnSettled("a", 1, "completed", { tag: "v1" }, error));
      expect(resolved(run, "resolved:a@1")).toMatchObject({
        status: error === null ? "succeeded" : "failed",
        output: error === null ? { tag: "v1" } : null,
      });
      expect(keysOf(run.decide())).not.toContain("nudge:a@1");
    },
  );

  it.each([0, 1])("routes acceptance exit %i", (exit) => {
    const run = running({ accept: { argv: ["node", "check.ts"], check: "exit == 0" } });
    run.add("settled:a@1", turnSettled("a", 1, "completed"));
    run.drive();
    expect(run.intent("accept:a@1")).toMatchObject({ _tag: "StartUnit", step: "a/accept" });
    run.add("exited:a/accept@1", unitExited("a/accept", 1, exit));
    expect(resolved(run, "resolved:a@1")).toMatchObject({ port: exit === 0 ? "pass" : "fail" });
  });

  it.each(["succeeded", "failed"])("propagates child %s", (status) => {
    const run = TestRun.start(
      compile({ nodes: { c: { kind: "call", workflow: "other", params: {} } } }),
    );
    run.drive();
    expect(run.intent("child:c@1")).toMatchObject({ _tag: "StartChildRun", workflowId: "other" });
    run.add("result:child:c@1", { _tag: "ChildRunStarted", childRunId: "wfr_child" });
    run.add("child:wfr_child", {
      _tag: "ChildRunEnded",
      childRunId: "wfr_child",
      status,
      output: { x: 1 },
      cost,
    });
    expect(resolved(run, "resolved:c@1")).toMatchObject({
      port: status === "succeeded" ? "ok" : "fail",
      output: { x: 1 },
    });
  });

  it.each([false, true])("answers runtime approvals with askIsrael=%s", (askIsrael) => {
    const run = running({ askIsrael });
    run.add("request:r1", {
      _tag: "RuntimeRequest",
      step: "a",
      attempt: 1,
      threadId: "thread-a",
      requestId: "r1",
      requestKind: "approval",
      text: "?",
    });
    run.drive();
    if (askIsrael) {
      expect(run.intent("open:ask:r1")).toMatchObject({
        _tag: "OpenGate",
        reason: "question",
        gateKey: "ask:r1",
      });
      run.add("gate:ask:r1", {
        _tag: "GateDecided",
        gateKey: "ask:r1",
        option: "answer",
        note: "yes",
        by: "user",
        at: iso(T0),
      });
      run.drive();
    }
    expect(run.intent("answer:r1")).toMatchObject({
      _tag: "AnswerRequest",
      answer: askIsrael ? { text: "yes" } : "decline",
    });
  });

  it("asks the bot first with askBot, and an escalation reaches Israel with a push", () => {
    const BOT = `b_${"b".repeat(32)}`;
    const run = TestRun.start(
      compile({ bot: BOT, nodes: { a: { ...agent, askBot: true } }, edges: [] }),
    );
    run.drive();
    run.add("result:ws:integ", {
      _tag: "WorkspaceReady",
      name: "integ",
      path: "/work/integ",
      branch: "wf/demo",
      headSha: "abc",
    });
    run.drive();
    run.add("result:turn:a@1", { _tag: "TurnStarted", threadId: "thread-a" }, T0);
    run.add("request:r1", {
      _tag: "RuntimeRequest",
      step: "a",
      attempt: 1,
      threadId: "thread-a",
      requestId: "r1",
      requestKind: "user-input",
      text: "Postgres or SQLite?",
    });
    const asked = keysOf(run.drive());
    expect(run.intent("open:ask:r1")).toMatchObject({
      bot: BOT,
      options: ["answer", "decline", "escalate"],
    });
    expect(run.intent("ask:ask:r1")).toMatchObject({ _tag: "PostToBot", gate: "ask:r1" });
    const post = run.intent("ask:ask:r1");
    expect(post?._tag === "PostToBot" && post.report).toContain("Item thread: thread-a");
    expect(asked).not.toContain("notify:gate:ask:r1");
    run.add("gate:ask:r1", {
      _tag: "GateDecided",
      gateKey: "ask:r1",
      option: "escalate",
      note: "a product call",
      by: `bot:${BOT}`,
      at: iso(T0),
    });
    const escalated = keysOf(run.drive());
    const israel = run.intent("open:escalated:ask:r1");
    expect(israel).toMatchObject({ options: ["answer", "decline"] });
    expect(israel !== undefined && "bot" in israel).toBe(false);
    expect(israel?._tag === "OpenGate" && israel.ask).toContain("a product call");
    expect(escalated).toContain("notify:gate:escalated:ask:r1");
    expect(run.intent("answer:r1")).toBeUndefined();
    run.add("gate:escalated:ask:r1", {
      _tag: "GateDecided",
      gateKey: "escalated:ask:r1",
      option: "answer",
      note: "SQLite",
      by: "user",
      at: iso(T0),
    });
    run.drive();
    expect(run.intent("answer:r1")).toMatchObject({ answer: { text: "SQLite" } });
  });

  it.each([
    [undefined, { provider: "claude", model: "claude-opus-5-5" }],
    ["gpt-6.1-sol", { provider: "codex", model: "gpt-6.1-sol", effort: "low" }],
  ])("starts the turn on the model param %s picks", (model, expected) => {
    const run = TestRun.start(
      compile({
        params: {
          model: {
            type: "string",
            enum: ["claude-opus-5-5", "gpt-6.1-sol"],
            default: "claude-opus-5-5",
          },
        },
        nodes: { a: { ...agent, model: "$params.model" } },
        edges: [],
      }),
      runStarted({ params: { model: model ?? "claude-opus-5-5" } }),
    );
    run.drive();
    run.add("result:ws:integ", {
      _tag: "WorkspaceReady",
      name: "integ",
      path: "/work/integ",
      branch: "wf/demo",
      headSha: "abc",
    });
    run.drive();
    expect(run.intent("turn:a@1")).toMatchObject({ _tag: "StartTurn", model: expected });
  });

  it("cancels and interrupts a running turn in one pass", () => {
    const run = running();
    run.add("control:x", {
      _tag: "ControlRequested",
      control: "cancel",
      step: null,
      by: "user",
      at: iso(T0),
    });
    const out = run.drive();
    expect(run.intent("interrupt:turn:a@1")).toMatchObject({ target: { threadId: "thread-a" } });
    expect(out.find((f) => f.key === "ended")?.fact).toMatchObject({
      _tag: "RunEnded",
      status: "cancelled",
    });
  });

  it("interrupts an overdue turn and resolves its interrupted receipt as timed out", () => {
    const run = running({ timeout: "30m" });
    run.drive(T0 + 31 * 60_000);
    expect(run.intent("interrupt:turn:a@1")).toMatchObject({ target: { threadId: "thread-a" } });
    run.add("settled:a@1", turnSettled("a", 1, "interrupted"));
    expect(resolved(run, "resolved:a@1")).toMatchObject({ status: "timed_out" });
  });

  it("waits until the retry backoff deadline", () => {
    const run = ready({ c: { ...command, retry: { max: 1, on: ["failed"], backoff: "10m" } } });
    const failedAt = T0 + 2_000;
    run.add("exited:c@1", unitExited("c", 1, 1), failedAt);
    run.drive(failedAt);
    expect(run.state().attempts.get("c")?.[0]?.resolved?.status).toBe("failed");
    expect(run.deadline()).toBe(failedAt + 600_000);
    expect(keysOf(run.decide(failedAt + 599_999))).not.toContain("unit:c@2");
    run.drive(failedAt + 600_000);
    expect(run.intent("unit:c@2")).toMatchObject({ _tag: "StartUnit", attempt: 2 });
  });
  it("expands a serial map from command output and collects every item", () => {
    const run = ready(
      {
        src: { ...command, parse: "json" },
        m: {
          kind: "map",
          items: "nodes.src.output",
          concurrency: 1,
          maxItems: 3,
          collect: { n: "{{item}}" },
          body: { nodes: { w: { ...command, argv: ["node", "w.ts", "{{item}}"] } }, edges: [] },
        },
      },
      ["src -> m"],
    );
    run.add("exited:src@1", unitExited("src", 1, 0, { out: [1, 2, 3] }));
    const first = run.drive();
    expect(first.filter((f) => f.key === "expand:m").map((f) => f.fact)).toMatchObject([
      { _tag: "MapExpanded", items: [1, 2, 3] },
    ]);
    expect(keysOf(first).filter((key) => key.startsWith("unit:m"))).toEqual(["unit:m[0]/w@1"]);
    expect(run.intent("unit:m[0]/w@1")).toMatchObject({ argv: ["node", "w.ts", "1"] });
    for (let index = 0; index < 3; index++) {
      const step = `m[${index}]/w`;
      run.add(`result:unit:${step}@1`, { _tag: "UnitSpawned", unit: step, at: iso(T0) });
      run.add(`exited:${step}@1`, unitExited(step, 1, 0));
      const out = run.drive();
      expect(keysOf(out)).not.toContain("expand:m");
      if (index < 2) expect(keysOf(out)).toContain(`unit:m[${index + 1}]/w@1`);
      else
        expect(out.find((f) => f.key === "resolved:m@1")?.fact).toMatchObject({
          status: "succeeded",
          output: [{ n: 1 }, { n: 2 }, { n: 3 }],
        });
    }
  });

  it.each(["iteration >= 1", "false"])("runs two loop iterations with until %s", (until) => {
    const run = ready({
      l: { kind: "loop", max: 2, until, body: { nodes: { w: command }, edges: [] } },
    });
    expect(run.facts.map((f) => f.key)).toContain("iter:l:0");
    expect(run.intent("unit:l[0]/w@1")).toMatchObject({ _tag: "StartUnit" });
    run.add("exited:l[0]/w@1", unitExited("l[0]/w", 1, 0));
    expect(keysOf(run.drive())).toEqual(expect.arrayContaining(["iter:l:1", "unit:l[1]/w@1"]));
    run.add("exited:l[1]/w@1", unitExited("l[1]/w", 1, 0));
    expect(resolved(run, "resolved:l@1")).toMatchObject({
      status: until === "false" ? "failed" : "succeeded",
    });
  });

  it("resolves running work while paused and dispatches its successor on resume", () => {
    const run = ready({ a: command, b: command }, ["a -> b"]);
    run.add("control:p", {
      _tag: "ControlRequested",
      control: "pause",
      step: null,
      by: "user",
      at: iso(T0),
    });
    expect(run.drive().find((f) => f.key === "pause:control:p")?.fact).toMatchObject({
      _tag: "RunPaused",
      reason: "user",
    });
    run.add("exited:a@1", unitExited("a", 1, 0));
    const paused = run.drive();
    expect(keysOf(paused)).toContain("resolved:a@1");
    expect(keysOf(paused)).not.toContain("unit:b@1");
    run.add("control:r", {
      _tag: "ControlRequested",
      control: "resume",
      step: null,
      by: "user",
      at: iso(T0),
    });
    expect(keysOf(run.drive())).toEqual(expect.arrayContaining(["resume:control:r", "unit:b@1"]));
  });

  it("ends at the step budget before dispatching the successor", () => {
    const run = TestRun.start(
      compile({
        budget: { steps: 1, wall: "2h", tokens: 100000 },
        nodes: { a: command, b: command },
        edges: ["a -> b"],
      }),
      runStarted({ budget: { steps: 1, wallMs: 7200000, tokens: 100000, usd: null } }),
    );
    run.drive();
    run.add("result:ws:integ", {
      _tag: "WorkspaceReady",
      name: "integ",
      path: "/work/integ",
      branch: "wf/demo",
      headSha: "abc",
    });
    run.drive();
    run.add("exited:a@1", unitExited("a", 1, 0));
    const out = run.drive();
    expect(keysOf(out)).not.toContain("unit:b@1");
    expect(out.find((f) => f.key === "ended")?.fact).toMatchObject({
      _tag: "RunEnded",
      status: "budget_exhausted",
    });
  });
});
