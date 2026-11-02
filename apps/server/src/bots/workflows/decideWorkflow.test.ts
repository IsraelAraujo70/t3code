import * as Result from "effect/Result";
import { expect, it } from "vite-plus/test";
import { compileWorkflow, DEFAULT_HOST_LIMITS } from "@t3tools/shared/workflows";
import { decideWorkflow, type DecideWorkflowInput } from "./decideWorkflow.ts";
import type { StoredFact } from "./facts.ts";
import { runIdFor } from "./ids.ts";
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

const trigger = (seq: number): StoredFact => ({
  stream: "workflow:demo",
  seq,
  key: `manual:${seq}`,
  at: "now",
  fact: {
    _tag: "TriggerFired",
    runId: "wfr_00000000000000000001",
    triggerId: "manual",
    kind: "manual",
    occurrence: `manual:${seq}`,
    label: "Manual",
    params: {},
    payload: null,
    causalDepth: 0,
    parent: null,
    at: "now",
  },
});
const input = (): DecideWorkflowInput => ({
  workflowId: "demo",
  facts: [trigger(1), trigger(2)],
  current: {
    _tag: "Ready",
    version: { workflowId: "demo", commit: "commit", compiled },
    enabled: true,
    suspended: false,
    off: new Set<string>(),
  },
  liveRuns: 0,
  now: 0,
});
it.each(["Missing", "Invalid"] as const)("skips %s definitions", (_tag) => {
  expect(decideWorkflow({ ...input(), current: { _tag } }).map((x) => x.fact)).toEqual(
    [1, 2].map((n) => ({ _tag: "TriggerSkipped", occurrence: `manual:${n}`, reason: "invalid" })),
  );
});
it.each(["disabled", "suspended", "busy"] as const)("skips %s", (reason) => {
  const base = input();
  if (base.current._tag !== "Ready") throw new Error("fixture");
  const result = decideWorkflow({
    ...base,
    liveRuns: reason === "busy" ? 1 : 0,
    current: { ...base.current, enabled: reason !== "disabled", suspended: reason === "suspended" },
  });
  expect(result.every((x) => x.fact._tag === "TriggerSkipped" && x.fact.reason === reason)).toBe(
    true,
  );
});
it.each(["single", "queue", "parallel"] as const)(
  "honors %s and ignores promoted occurrences",
  (concurrency) => {
    const base = input();
    if (base.current._tag !== "Ready") throw new Error("fixture");
    const current = {
      ...base.current,
      version: {
        ...base.current.version,
        compiled: { ...compiled, definition: { ...compiled.definition, concurrency } },
      },
    };
    const result = decideWorkflow({ ...base, current });
    expect(result.filter((x) => x.fact._tag === "RunCreated")).toHaveLength(
      concurrency === "parallel" ? 2 : 1,
    );
    expect(result[0]).toEqual({
      stream: "workflow:demo",
      key: "created:manual:1",
      fact: { _tag: "RunCreated", occurrence: "manual:1", runId: runIdFor("demo", "manual:1") },
    });
    expect(result[1]).toMatchObject({
      stream: `run:${runIdFor("demo", "manual:1")}`,
      key: "started",
      fact: {
        _tag: "RunStarted",
        commit: "commit",
        at: "1970-01-01T00:00:00.000Z",
        budget: { wallMs: 7200000 },
      },
    });
    if (concurrency === "queue")
      expect(decideWorkflow({ ...base, current, liveRuns: 1 })).toEqual([]);
    const facts = [...base.facts, ...result.map((x, i) => ({ ...x, seq: i + 3, at: "now" }))];
    expect(decideWorkflow({ ...base, current, facts, liveRuns: 1 })).toEqual(
      concurrency === "queue" ? [] : [],
    );
  },
);

const outcome = (seq: number, runId: string, status: string): StoredFact => ({
  stream: "workflow:demo",
  seq,
  key: `outcome:${runId}`,
  at: "now",
  fact: { _tag: "RunOutcome", runId, status },
});

it("suspends after the fatigue limit of failed outcomes in a row and skips the waiting triggers", () => {
  const facts = [outcome(1, "r1", "failed"), outcome(2, "r2", "budget_exhausted"), trigger(3)];
  const result = decideWorkflow({ ...input(), facts });
  expect(result.map((x) => [x.stream, x.key, x.fact._tag])).toEqual([
    ["workflow:demo", "suspended:r2", "Suspended"],
    ["run:r2", "notify:suspended", "IntentRecorded"],
    ["workflow:demo", "skipped:manual:3", "TriggerSkipped"],
  ]);
  expect(result[2]?.fact._tag === "TriggerSkipped" && result[2].fact.reason).toBe("suspended");
});

it.each([
  [
    "a success in between",
    [outcome(1, "r1", "failed"), outcome(2, "r2", "succeeded"), outcome(3, "r3", "failed")],
  ],
  [
    "an Unsuspended after the streak",
    [
      outcome(1, "r1", "failed"),
      outcome(2, "r2", "failed"),
      {
        stream: "workflow:demo",
        seq: 3,
        key: "suspended:r2",
        at: "now",
        fact: { _tag: "Suspended", reason: "fatigue", at: "now" },
      },
      {
        stream: "workflow:demo",
        seq: 4,
        key: "unsuspended:u1",
        at: "now",
        fact: { _tag: "Unsuspended", by: "israel", at: "now" },
      },
      outcome(5, "r3", "failed"),
    ],
  ],
] as const)("does not suspend after %s", (_case, facts: ReadonlyArray<StoredFact>) => {
  expect(decideWorkflow({ ...input(), facts }).some((x) => x.fact._tag === "Suspended")).toBe(
    false,
  );
});
it("tells the parent when its child's trigger is skipped", () => {
  const child = trigger(1);
  if (child.fact._tag !== "TriggerFired") throw new Error("fixture");
  const parent = { runId: "wfr_00000000000000000009", step: "call@1" };
  const result = decideWorkflow({
    ...input(),
    facts: [{ ...child, fact: { ...child.fact, parent, causalDepth: 1 } }],
    current: { _tag: "Missing" },
  });
  expect(result.find((x) => x.stream === `run:${parent.runId}`)).toEqual({
    stream: `run:${parent.runId}`,
    key: `child:${child.fact.runId}`,
    fact: {
      _tag: "ChildRunEnded",
      childRunId: child.fact.runId,
      status: "skipped",
      output: { reason: "invalid" },
      cost: {
        billable: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        usage: "unavailable",
        usdEstimate: null,
      },
    },
  });
});

it("matches a param's pattern against the whole value", () => {
  const base = input();
  if (base.current._tag !== "Ready") throw new Error("fixture");
  const compiledWithRef = (() => {
    const r = compileWorkflow(
      {
        ...base.current.version.compiled.definition,
        params: { ref: { type: "string", pattern: "[a-z]+" } },
      },
      DEFAULT_HOST_LIMITS,
    );
    if (Result.isFailure(r)) throw new Error(JSON.stringify(r.failure));
    return r.success;
  })();
  const fired = trigger(1);
  if (fired.fact._tag !== "TriggerFired") throw new Error("fixture");
  const result = decideWorkflow({
    ...base,
    facts: [{ ...fired, fact: { ...fired.fact, params: { ref: "main --upload-pack=evil" } } }],
    current: { ...base.current, version: { ...base.current.version, compiled: compiledWithRef } },
  });
  expect(result.map((x) => x.fact)).toContainEqual({
    _tag: "TriggerSkipped",
    occurrence: "manual:1",
    reason: "invalid",
  });
});
