import { KanbanTicketId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { spentTokens, usageReport } from "./budget/budget.ts";
import { nextDeadline } from "./decide.ts";
import type { Fact } from "./facts.ts";
import {
  compile,
  cost,
  iso,
  keysOf,
  RUN_ID,
  runStarted,
  T0,
  TestRun,
  turnSettled,
  unitExited,
} from "./testkit/decideHarness.ts";

const agent = (extra: Record<string, unknown> = {}) => ({
  kind: "agent",
  model: "$lead",
  prompt: "Work",
  workspace: "integ",
  access: "write",
  ...extra,
});
const workspaceReady: Fact = {
  _tag: "WorkspaceReady",
  name: "integ",
  path: "/work/integ",
  branch: "wf/demo",
  headSha: "abc",
};
const begin = (
  patch: Record<string, unknown>,
  tokens = 100_000,
  setup: (run: TestRun) => void = () => {},
) => {
  const run = TestRun.start(
    compile({ budget: { steps: 20, wall: "2h", tokens }, ...patch }),
    runStarted({ budget: { steps: 20, wallMs: 7_200_000, tokens, usd: null } }),
  );
  setup(run);
  return run;
};
/** One pass, serving the shared worktree and any card the pass recorded. */
const pass = (run: TestRun, now = T0 + 1_000) => {
  const out = run.drive(now);
  for (const { intent, result } of run.state().intents.values())
    if (intent._tag === "UpsertCard" && result === null)
      run.result(
        intent.key,
        { _tag: "CardUpserted", ticketId: KanbanTicketId.make("ticket") },
        now,
      );
  if (run.intent("ws:integ") === undefined || run.state().workspaces.has("integ")) return out;
  run.result("ws:integ", workspaceReady, now);
  return [...out, ...run.drive(now)];
};
const settledWith = (
  step: string,
  usage: "complete" | "unavailable",
  billable: number,
  headSha: string | null = null,
): Fact => ({
  _tag: "TurnSettled",
  step,
  attempt: 1,
  status: "completed",
  text: "reply",
  output: null,
  outputError: null,
  cost: { ...cost, usage, billable },
  headSha,
});
const startedTurns = (run: TestRun) =>
  [...run.state().intents.values()].filter((e) => e.intent._tag === "StartTurn").length;

describe("run decider budget (slice 8)", () => {
  it("admits concurrent map items only while their reservations fit the balance", () => {
    const run = begin({
      nodes: {
        src: { kind: "command", argv: ["node", "src.ts"], cwd: "integ", parse: "json" },
        m: {
          kind: "map",
          items: "nodes.src.output",
          concurrency: 3,
          maxItems: 3,
          body: { nodes: { w: agent({ tokenReservation: 40_000 }) }, edges: [] },
        },
      },
      edges: ["src -> m"],
    });
    pass(run);
    run.result("unit:src@1", { _tag: "UnitSpawned", unit: "u", at: iso(T0) });
    run.add("exited:src@1", unitExited("src", 1, 0, { out: [1, 2, 3] }));
    pass(run);
    expect(startedTurns(run)).toBe(2);
    run.result("turn:m[0]/w@1", { _tag: "TurnStarted", threadId: "t0" });
    run.add("settled:m[0]/w@1", settledWith("m[0]/w", "complete", 10_000));
    pass(run);
    expect(startedTurns(run)).toBe(3);
  });

  it.each([
    ["unavailable", 0, "budget_exhausted"],
    ["complete", 5_000, null],
  ] as const)(
    "charges %s usage (billable %d) and decides the next start",
    (usage, billable, end) => {
      const run = begin(
        {
          nodes: {
            a: agent({ tokenReservation: 30_000 }),
            b: agent({ tokenReservation: 30_000 }),
          },
          edges: ["a -> b"],
        },
        50_000,
      );
      pass(run);
      run.result("turn:a@1", { _tag: "TurnStarted", threadId: "ta" });
      run.add("settled:a@1", settledWith("a", usage, billable));
      pass(run);
      const ended = run.state().ended;
      expect(ended?.status ?? null).toBe(end);
      expect(run.intent("turn:b@1") === undefined).toBe(end !== null);
    },
  );

  it("does not count time waiting on a gate against the wall", () => {
    const run = begin({
      nodes: { ask: { kind: "gate", ask: "Go?" }, work: agent() },
      edges: ["ask:approve -> work"],
    });
    pass(run);
    run.result("open:ask@1", { _tag: "GateOpened", gateKey: "ask@1", at: iso(T0 + 1_000) });
    const decidedAt = T0 + 3 * 3_600_000;
    run.add(
      "gate:ask@1",
      {
        _tag: "GateDecided",
        gateKey: "ask@1",
        option: "approve",
        note: null,
        by: "user",
        at: iso(decidedAt),
      },
      decidedAt,
    );
    pass(run, decidedAt + 1_000);
    expect(run.state().ended).toBeNull();
    expect(run.intent("turn:work@1")).toMatchObject({ _tag: "StartTurn" });
    // The same three hours of active work would be past the two-hour wall.
    const busy = begin({ nodes: { work: agent() } });
    pass(busy);
    busy.result("turn:work@1", { _tag: "TurnStarted", threadId: "tw" });
    pass(busy, T0 + 3 * 3_600_000);
    expect(busy.state().ended?.status).toBe("budget_exhausted");
  });

  it("pauses once per fatigue streak with one notice per pause", () => {
    const run = begin({
      nodes: { a: agent({ retry: { max: 5, on: ["failed"] } }) },
    });
    const fail = (attempt: number, at: number) => {
      pass(run, at);
      run.result(`turn:a@${attempt}`, { _tag: "TurnStarted", threadId: `t${attempt}` }, at);
      run.add(`settled:a@${attempt}`, turnSettled("a", attempt, "failed"), at);
      pass(run, at);
    };
    const notices = () => [...run.state().keys].filter((k) => k.startsWith("notify:fatigue:"));
    fail(1, T0 + 1_000);
    fail(2, T0 + 2_000);
    pass(run, T0 + 3_000);
    expect(notices()).toEqual(["notify:fatigue:1"]);
    expect(run.state().paused?.reason).toBe("fatigue");
    expect(keysOf(pass(run, T0 + 3_500)).filter((k) => k.startsWith("notify:"))).toEqual([]);
    run.add(
      "control:r1",
      {
        _tag: "ControlRequested",
        control: "resume",
        step: null,
        by: "israel",
        at: iso(T0 + 4_000),
      },
      T0 + 4_000,
    );
    pass(run, T0 + 4_000);
    expect(run.state().paused).toBeNull();
    fail(3, T0 + 5_000);
    fail(4, T0 + 6_000);
    pass(run, T0 + 7_000);
    expect(notices()).toEqual(["notify:fatigue:1", "notify:fatigue:2"]);
  });

  it("pauses at the daily cap, resumes when the day turns, and wakes at the turn", () => {
    const run = begin({ nodes: { a: agent() } });
    const endsAt = T0 + 3_600_000;
    run.budget = { estimate: () => 1_000, day: { spent: 41_000_000, cap: 40_000_000, endsAt } };
    pass(run);
    expect(run.state().paused?.reason).toBe("daily_cap");
    expect(run.state().keys.has("notify:daily_cap:1")).toBe(true);
    expect(run.intent("turn:a@1")).toBeUndefined();
    expect(nextDeadline(run.compiled, run.state(), T0 + 1_000, run.budget)).toBe(endsAt);
    run.budget = {
      estimate: () => 1_000,
      day: { spent: 0, cap: 40_000_000, endsAt: endsAt + 86_400_000 },
    };
    pass(run, endsAt + 1);
    expect(run.state().paused).toBeNull();
    expect(run.intent("turn:a@1")).toMatchObject({ reservation: 1_000 });
  });

  it("interrupts a turn once the observer's usage reports reach twice its reservation", () => {
    const run = begin({ nodes: { a: agent({ tokenReservation: 1_000 }) } });
    pass(run);
    run.result("turn:a@1", { _tag: "TurnStarted", threadId: "ta" });
    const turn = run.intent("turn:a@1");
    if (turn?._tag !== "StartTurn") throw new Error("no turn");
    /** What the live turn observer appends for one provider usage report. */
    const report = (billable: number) => {
      const fact = usageReport(RUN_ID, turn, billable, iso(T0));
      if (fact !== null) run.add(fact.key, fact.fact);
      return fact?.key ?? null;
    };
    expect(report(400)).toBeNull();
    expect(report(1_500)).toBe("usage:turn:a@1:1");
    expect(keysOf(pass(run))).not.toContain("interrupt:turn:a@1");
    expect(report(2_100)).toBe("usage:turn:a@1:2");
    expect(pass(run)).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "interrupt:turn:a@1" })]),
    );
  });
});

describe("run decider card, pull request and ledger (slices 7-8)", () => {
  it("moves the card with the run and never names a step thread", () => {
    const run = begin({
      card: { project: "board" },
      nodes: {
        work: agent(),
        ask: { kind: "gate", ask: "Ship?" },
        done: { kind: "output", status: "ready_for_review", value: {} },
      },
      edges: ["work -> ask", "ask:approve -> done"],
    });
    pass(run);
    run.result("turn:work@1", { _tag: "TurnStarted", threadId: "tw" });
    run.add("settled:work@1", settledWith("work", "complete", 10));
    pass(run);
    // The gate waits; the next pass moves the card once card:2 landed.
    pass(run);
    run.add("gate:ask@1", {
      _tag: "GateDecided",
      gateKey: "ask@1",
      option: "approve",
      note: null,
      by: "user",
      at: iso(T0),
    });
    pass(run);
    // The run ended while card:3 was in flight; done follows once it landed.
    pass(run);
    const cards = [...run.state().intents.values()]
      .map((e) => e.intent)
      .filter((i) => i._tag === "UpsertCard");
    expect(cards.map((c) => [c.key, c.column])).toEqual([
      ["card:1", "todo"],
      ["card:2", "in_progress"],
      ["card:3", "in_review"],
      ["card:4", "done"],
    ]);
    for (const card of cards)
      expect(Object.keys(card).sort()).toEqual([
        "_tag",
        "column",
        "key",
        "project",
        ...(card.ticketId === undefined ? [] : ["ticketId"]),
        "title",
      ]);
  });

  it("records the next card only after the previous one landed, and still reaches done after the end", () => {
    const run = begin({ card: { project: "board" }, nodes: { work: agent() } });
    run.drive();
    run.result("ws:integ", workspaceReady);
    run.drive();
    run.result("turn:work@1", { _tag: "TurnStarted", threadId: "tw" });
    run.add("settled:work@1", settledWith("work", "complete", 10));
    run.drive();
    const cards = () =>
      [...run.state().intents.values()].flatMap((e) =>
        e.intent._tag === "UpsertCard" ? [[e.intent.key, e.intent.column]] : [],
      );
    expect(run.state().ended?.status).toBe("succeeded");
    expect(cards()).toEqual([["card:1", "todo"]]);
    run.result("card:1", { _tag: "CardUpserted", ticketId: KanbanTicketId.make("ticket") });
    run.drive();
    expect(cards()).toEqual([
      ["card:1", "todo"],
      ["card:2", "done"],
    ]);
  });

  it.each([
    ["wf/demo", "OpenPullRequest"],
    ["wf/failure", "IntentFailed"],
    ["release/1", null],
  ] as const)("publishes an output's pull request from branch %s", (branch, published) => {
    const run = begin({
      nodes: {
        work: agent(),
        done: {
          kind: "output",
          status: "ready_for_review",
          value: {},
          pullRequest: { workspace: "integ", base: "friend/main", title: "T", body: "B" },
        },
      },
      edges: ["work -> done"],
    });
    run.drive();
    run.result("ws:integ", { ...workspaceReady, branch } as Fact);
    pass(run);
    run.result("turn:work@1", { _tag: "TurnStarted", threadId: "tw" });
    run.add("settled:work@1", settledWith("work", "complete", 10, "def"));
    pass(run);
    const pr = run.intent("pr:done@1");
    if (published === null) {
      expect(pr).toBeUndefined();
      expect(run.state().attempts.get("done")?.[0]?.resolved?.status).toBe("failed");
    } else {
      expect(run.state().output).toBeNull();
      expect(pr).toMatchObject({
        _tag: "OpenPullRequest",
        branch,
        sha: "def",
        base: "friend/main",
      });
      if (published === "IntentFailed") {
        run.result("pr:done@1", {
          _tag: "IntentFailed",
          error: "publication denied",
          retryable: false,
        });
        pass(run);
        expect(run.state().attempts.get("done")?.[0]?.resolved).toMatchObject({ status: "failed" });
        expect(run.state().ended?.status).toBe("failed");
        // A retry of the output publishes again under its own attempt's key.
        run.add("control:r1", {
          _tag: "ControlRequested",
          control: "retry",
          step: "done",
          by: "user",
          at: iso(T0),
        });
        pass(run);
        pass(run);
        expect(run.intent("pr:done@2")).toMatchObject({ _tag: "OpenPullRequest", sha: "def" });
        return;
      }
      run.result("pr:done@1", {
        _tag: "PullRequestOpened",
        url: "https://example.com/pr/1",
        branch,
      });
      pass(run);
      expect(run.state().output).not.toBeNull();
      expect(run.state().ended?.status).toBe("succeeded");
    }
  });

  it.each([
    ["another run", "skip"],
    ["nobody", "register"],
  ] as const)("runs a `once` step whose key %s holds as %s", (holder, outcome) => {
    const run = begin({
      nodes: { a: agent({ once: { ledger: "classes", key: "k1" } }) },
    });
    if (holder === "another run")
      run.addLedger("ledger:classes", "entry:k1", {
        _tag: "EntryRegistered",
        key: "k1",
        workflowId: "demo",
        runId: "wfr_other",
        step: "a",
        hypothesis: "",
        barHash: "",
        at: iso(T0),
      });
    pass(run);
    pass(run);
    if (outcome === "skip") {
      expect(run.state().skipped.get("a")).toBe("once");
      expect(run.intent("turn:a@1")).toBeUndefined();
    } else {
      expect(run.ledgers().get("classes")?.entries.get("k1")?.step).toBe("a");
      expect(run.intent("turn:a@1")).toMatchObject({ _tag: "StartTurn" });
    }
  });

  it("validates the kept ledger entry an output promotes", () => {
    const run = begin({
      nodes: {
        done: {
          kind: "output",
          status: "ready_for_review",
          value: {},
          promote: { ledger: "climb", sha: "s1" },
        },
      },
    });
    run.addLedger("ledger:climb", "entry:k", {
      _tag: "EntryRegistered",
      key: "k",
      workflowId: "demo",
      runId: "wfr_old",
      step: "c/r1",
      hypothesis: "h",
      barHash: "b",
      at: iso(T0),
    });
    run.addLedger("ledger:climb", "resolved:k", {
      _tag: "EntryResolved",
      key: "k",
      verdict: "kept",
      before: null,
      after: null,
      sha: "s1",
      note: null,
      at: iso(T0),
    });
    pass(run);
    expect(run.ledgers().get("climb")?.entries.get("k")?.verdict).toBe("validated");
  });

  it("publishes a block export at the head later turns left in it", () => {
    const run = begin({
      nodes: {
        climb: {
          kind: "hillclimb",
          workspace: { project: "t3code", base: "main" },
          ledger: "exp",
          generator: {
            model: "$lead",
            workspace: { project: "t3code", readOnly: true },
            prompt: "p",
          },
          measure: { bench: { argv: ["bench"], cwd: { project: "t3code", readOnly: true } } },
          objective: { expr: "m.bench.ratio", direction: "max" },
          keep: "m.bench.ratio >= 1.05",
          target: "m.bench.ratio >= 1.5",
          plateau: { rounds: 2 },
          budget: { iterations: 3 },
        },
        fix: {
          kind: "agent",
          model: "$lead",
          prompt: "Fix",
          workspace: "climb.best",
          access: "write",
        },
        done: {
          kind: "output",
          status: "ready_for_review",
          value: {},
          pullRequest: { workspace: "climb.best", base: "main", title: "T", body: "B" },
        },
      },
      edges: ["climb:no_gain -> fix", "climb:target -> fix", "fix -> done"],
    });
    const best = {
      name: "climb/best",
      path: "/w/best",
      project: "t3code",
      branch: "wf/r/climb/best",
      head: "b1",
    };
    run.add("resolved:climb@1", {
      _tag: "StepResolved",
      step: "climb",
      attempt: 1,
      status: "succeeded",
      port: "no_gain",
      output: { exports: { best } },
      error: null,
      at: iso(T0),
    });
    pass(run);
    expect(run.intent("turn:fix@1")).toMatchObject({ workspace: { name: "climb/best" } });
    run.result("turn:fix@1", { _tag: "TurnStarted", threadId: "tf" });
    run.add("settled:fix@1", settledWith("fix", "complete", 10, "f2"));
    pass(run);
    expect(run.intent("pr:done@1")).toMatchObject({ branch: "wf/r/climb/best", sha: "f2" });
  });

  it("reserves each child run's whole budget, so concurrent calls never share a balance", () => {
    const run = begin({
      nodes: {
        a: { kind: "call", workflow: "child", params: {} },
        b: { kind: "call", workflow: "child", params: {} },
        done: { kind: "output", status: "no_change", value: {} },
      },
      edges: ["a -> done", "b -> done"],
    });
    run.budget = { estimate: () => 1_000, childTokens: () => 60_000, day: null };
    pass(run);
    const children = [...run.state().intents.values()].filter(
      (e) => e.intent._tag === "StartChildRun",
    );
    expect(children.map((e) => e.intent.key)).toEqual(["child:a@1"]);
    expect(children[0]?.intent).toMatchObject({ reservation: 60_000 });
  });

  it("publishes a block export at the head it exported when nothing ran in it since", () => {
    const run = begin({
      nodes: {
        climb: {
          kind: "hillclimb",
          workspace: { project: "t3code", base: "main" },
          ledger: "exp",
          generator: {
            model: "$lead",
            workspace: { project: "t3code", readOnly: true },
            prompt: "p",
          },
          measure: { bench: { argv: ["bench"], cwd: { project: "t3code", readOnly: true } } },
          objective: { expr: "m.bench.ratio", direction: "max" },
          keep: "m.bench.ratio >= 1.05",
          target: "m.bench.ratio >= 1.5",
          plateau: { rounds: 2 },
          budget: { iterations: 3 },
        },
        done: {
          kind: "output",
          status: "ready_for_review",
          value: {},
          pullRequest: { workspace: "climb.best", base: "main", title: "T", body: "B" },
        },
      },
      edges: ["climb:no_gain -> done", "climb:target -> done"],
    });
    run.add("ws:climb/best", {
      _tag: "IntentRecorded",
      intent: {
        _tag: "PrepareWorkspace",
        key: "ws:climb/best",
        name: "climb/best",
        projectRef: "t3code",
        baseRef: "base",
        branch: null,
      },
    });
    run.result("ws:climb/best", {
      _tag: "WorkspaceReady",
      name: "climb/best",
      path: "/w/best",
      branch: null,
      headSha: "base",
    });
    const best = {
      name: "climb/best",
      path: "/w/best",
      project: "t3code",
      branch: "wf/r/climb/best",
      head: "merged",
    };
    run.add("resolved:climb@1", {
      _tag: "StepResolved",
      step: "climb",
      attempt: 1,
      status: "succeeded",
      port: "no_gain",
      output: { exports: { best } },
      error: null,
      at: iso(T0),
    });
    pass(run);
    expect(run.intent("pr:done@1")).toMatchObject({ sha: "merged" });
  });

  it("refuses a child whose budget is larger than what is left, never clipping it", () => {
    const run = begin({
      nodes: {
        a: { kind: "call", workflow: "child", params: {} },
        done: { kind: "output", status: "no_change", value: {} },
      },
      edges: ["a -> done"],
    });
    run.budget = { estimate: () => 1_000, childTokens: () => 200_000, day: null };
    pass(run);
    expect(run.intent("child:a@1")).toBeUndefined();
    expect(run.state().ended?.status).toBe("budget_exhausted");
  });

  it("charges nothing for a child skipped before it started", () => {
    const run = begin({
      nodes: {
        a: { kind: "call", workflow: "child", params: {} },
        done: { kind: "output", status: "no_change", value: {} },
      },
      edges: ["a -> done"],
    });
    run.budget = { estimate: () => 1_000, childTokens: () => 60_000, day: null };
    pass(run);
    run.result("child:a@1", { _tag: "ChildRunStarted", childRunId: "wfr_child" });
    run.add("child:wfr_child", {
      _tag: "ChildRunEnded",
      childRunId: "wfr_child",
      status: "skipped",
      output: null,
      cost: { ...cost, usage: "unavailable" },
    });
    expect(spentTokens(run.state())).toBe(0);
  });

  it("ends a child with work in flight as partial usage charged at its reservations", () => {
    const run = TestRun.start(
      compile({ nodes: { a: agent({ tokenReservation: 80_000 }) } }),
      runStarted({ parent: { runId: "wfr_parent", step: "c" } }),
    );
    pass(run);
    run.result("turn:a@1", { _tag: "TurnStarted", threadId: "ta" });
    run.add("control:x", {
      _tag: "ControlRequested",
      control: "cancel",
      step: null,
      by: "israel",
      at: iso(T0),
    });
    const ended = pass(run).find((f) => f.stream === "run:wfr_parent")?.fact;
    expect(ended).toMatchObject({
      _tag: "ChildRunEnded",
      status: "cancelled",
      cost: { billable: 80_000, usage: "partial" },
    });
  });

  it("reserves a continued thread's turn at the estimate when the node names none", () => {
    const run = begin({
      nodes: {
        a: agent({ tokenReservation: 1_000 }),
        b: agent({ thread: "continue:a" }),
      },
      edges: ["a -> b"],
    });
    run.budget = { estimate: () => 90_000, day: null };
    pass(run);
    run.result("turn:a@1", { _tag: "TurnStarted", threadId: "ta" });
    run.add("settled:a@1", settledWith("a", "complete", 10));
    pass(run);
    expect(run.intent("turn:b@1")).toMatchObject({ mode: "continue", reservation: 90_000 });
  });
});
