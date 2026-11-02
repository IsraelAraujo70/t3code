import type { Json } from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import type { WorkflowModelRef } from "@t3tools/contracts";
import type { CompiledWorkflow } from "@t3tools/shared/workflows";

import type { Intent } from "../facts.ts";
import { compile, cost, RUN_ID, runStarted, T0, TestRun } from "../testkit/decideHarness.ts";
import { blockView } from "./registry.ts";

const RUBRIC = ["fewest moving parts", "a failing test comes first"];
const MODELS = {
  lead: { provider: "claude", model: "claude-opus-5-5" },
  sol: { provider: "codex", model: "gpt-6.1-sol", effort: "low" },
  judge: { provider: "codex", model: "gpt-6.1-sol", effort: "high" },
} satisfies Record<string, WorkflowModelRef>;
const MINUTE = 60_000;

const duel = (patch: Record<string, unknown>) => ({
  kind: "arena",
  task: "Propose a fix for {{params.topic}}.",
  artifact: "PROPOSAL.md at the worktree root.",
  runners: ["$lead", "$sol", "$sol"],
  minCandidates: 2,
  judge: "$judge",
  rubric: RUBRIC,
  lead: "$lead",
  maxReruns: 1,
  workspace: { project: "t3code", base: "friend/main" },
  ...patch,
});

const start = (
  patch: Record<string, unknown> = {},
  mutate: (compiled: CompiledWorkflow) => CompiledWorkflow = (c) => c,
) =>
  TestRun.start(
    mutate(
      compile({
        budget: { steps: 300, wall: "12h", tokens: 30_000_000 },
        fatigue: { consecutiveFailures: 10 },
        models: MODELS,
        params: { topic: { type: "string", default: "the flaky test" } },
        nodes: {
          duel: duel(patch),
          done: { kind: "output", status: "ready_for_review", value: {} },
          few: { kind: "output", status: "no_change", value: {} },
        },
        edges: ["duel -> done", "duel:insufficient -> few"],
      }),
    ),
    runStarted({
      params: { topic: "the flaky test" },
      budget: { steps: 300, wallMs: 43_200_000, tokens: 30_000_000, usd: null },
    }),
  );

/** A settled reply, or `running`: the turn started and never settles. */
type TurnAnswer =
  | "running"
  | {
      readonly status?: "completed" | "failed";
      readonly output?: Json;
      readonly headSha?: string | null;
    };
interface UnitAnswer {
  readonly exit: number;
  readonly tail?: string;
  readonly out?: Json;
  readonly signal?: string;
}
/** Answers by block child id (`c0/run`, `graft/r1`); `undefined` leaves the child unanswered. */
interface World {
  readonly turn?: (child: string) => TurnAnswer | undefined;
  readonly unit?: (child: string) => UnitAnswer | undefined;
}

const VERDICT = {
  scores: { c0: 7, c1: 9, c2: 4 },
  base: "c1",
  graft: [
    { from: "c0", idea: "reuse c0's retry helper" },
    { from: "zz", idea: "an idea from nobody" },
  ],
};
const defaultTurn = (child: string): TurnAnswer | undefined => {
  const candidate = /^c(\d+)\/run$/.exec(child);
  if (candidate !== null) return { headSha: `s${candidate[1]}` };
  if (child === "judge") return { output: VERDICT };
  const graft = /^graft\/r(\d+)$/.exec(child);
  if (graft !== null) return { headSha: `g${graft[1]}` };
  return undefined;
};
const defaultUnit = (): UnitAnswer => ({ exit: 0 });

const REFS: Record<string, string> = { "friend/main": "b0", HEAD: "h0" };

/** Plays the interpreter: drives until quiet at `now`, answering every pending intent from `world`. */
const play = (run: TestRun, world: World = {}, now = T0 + 1_000) => {
  const answered = new Set<string>();
  // A retried arena scopes its children under `duel/a<n>/`; answer them by the same child id.
  const childOf = (step: string) => step.replace(/^duel\/(a\d+\/)?/, "");
  const answer = (key: string, intent: Intent): boolean => {
    switch (intent._tag) {
      case "PrepareWorkspace":
        run.result(key, {
          _tag: "WorkspaceReady",
          name: intent.name,
          path: `/wt/${intent.name}`,
          branch: intent.branch,
          headSha: REFS[intent.baseRef] ?? intent.baseRef,
        });
        return true;
      case "StartTurn": {
        const reply = (world.turn ?? defaultTurn)(childOf(intent.step));
        if (reply === undefined) return false;
        run.result(key, { _tag: "TurnStarted", threadId: intent.threadId });
        if (reply === "running") return true;
        run.add(`settled:${intent.step}@1`, {
          _tag: "TurnSettled",
          step: intent.step,
          attempt: 1,
          status: reply.status ?? "completed",
          text: "reply",
          output: reply.output ?? null,
          outputError: null,
          cost,
          headSha: reply.headSha ?? null,
          treeHash: null,
        });
        return true;
      }
      case "StartUnit": {
        const reply = (world.unit ?? defaultUnit)(childOf(intent.step));
        if (reply === undefined) return false;
        run.result(key, { _tag: "UnitSpawned", unit: key, at: "2026-11-02T10:00:01.000Z" });
        run.add(`exited:${intent.step}@1`, {
          _tag: "UnitExited",
          step: intent.step,
          attempt: 1,
          exit: reply.exit,
          signal: reply.signal ?? null,
          queuedMs: 0,
          out: reply.out ?? null,
          tail: reply.tail ?? "",
          lost: false,
          started: true,
        });
        return true;
      }
      default:
        return false;
    }
  };
  for (let pass = 0; pass < 200; pass += 1) {
    const emitted = run.drive(now).length;
    let progressed = false;
    for (const [key, entry] of run.state().intents) {
      if (entry.result !== null || answered.has(key)) continue;
      answered.add(key);
      if (answer(key, entry.intent)) progressed = true;
    }
    if (emitted === 0 && !progressed) return run;
  }
  throw new Error("the block never went quiet");
};

const resolution = (run: TestRun, step = "duel") =>
  run
    .state()
    .attempts.get(step)
    ?.find((a) => a.attempt === 1)?.resolved ?? null;
const turnIntent = (run: TestRun, child: string) => {
  const intent = run.intent(`turn:duel/${child}@1`);
  return intent?._tag === "StartTurn" ? intent : null;
};
const turnSteps = (run: TestRun) =>
  [...run.state().intents.values()].flatMap(({ intent }) =>
    intent._tag === "StartTurn" ? [intent] : [],
  );
const view = (run: TestRun) => {
  const node = run.compiled.root.nodes.get("duel")?.node;
  if (node?.kind !== "arena") throw new Error("no arena node");
  return blockView(node, run.state(), "duel", 1, 0);
};

interface Case {
  readonly name: string;
  readonly patch?: Record<string, unknown>;
  readonly mutate?: (compiled: CompiledWorkflow) => CompiledWorkflow;
  /** Plays the run; the default plays once at T0 + 1s. */
  readonly play?: (run: TestRun) => TestRun;
  readonly world?: World;
  readonly check: (run: TestRun) => void;
}

const verifySpec = { argv: ["vp", "test", "run"], cwd: "duel.graft", replay: "safe" };

const cases: ReadonlyArray<Case> = [
  {
    name: "the rubric reaches the judge and never a candidate or the graft",
    check: (run) => {
      const turns = turnSteps(run);
      expect(turns.map((t) => t.step).toSorted()).toEqual([
        "duel/c0/run",
        "duel/c1/run",
        "duel/c2/run",
        "duel/graft/r1",
        "duel/judge",
      ]);
      for (const turn of turns) {
        if (turn.step === "duel/judge") continue;
        expect(turn.prompt).toContain("Propose a fix for the flaky test.");
        for (const item of RUBRIC) expect(turn.prompt).not.toContain(item);
      }
      const judge = turnIntent(run, "judge");
      for (const item of RUBRIC) expect(judge?.prompt).toContain(item);
      expect(judge?.prompt).toContain("c2: commit s2, worktree /wt/duel/c2/ws");
      expect(turnIntent(run, "c0/run")).toMatchObject({
        mode: "new",
        access: "write",
        model: MODELS.lead,
        workspace: { name: "duel/c0/ws" },
      });
      expect(turnIntent(run, "c1/run")?.model).toEqual(MODELS.sol);
      expect(run.intent("ws:duel/c2/ws")).toMatchObject({ baseRef: "friend/main", branch: null });
    },
  },
  {
    name: "the judge runs the judge model, read-only on a new thread, of another family than the lead",
    check: (run) => {
      const judge = turnIntent(run, "judge");
      expect(judge).toMatchObject({ mode: "new", access: "read", model: MODELS.judge });
      expect(judge?.threadId).not.toBe(turnIntent(run, "c0/run")?.threadId);
      expect(run.intent("ws:duel/judge/ws")).toMatchObject({
        baseRef: "friend/main",
        branch: null,
      });
      expect(turnIntent(run, "graft/r1")?.model).toEqual(MODELS.lead);
    },
  },
  {
    // The compiler refuses this definition (compile.test.ts, "an arena judged by the lead's family");
    // here the judge's $ref resolves to the lead's family only at run time.
    name: "a judge of the lead's family at run time fails before any candidate starts",
    mutate: (compiled) => ({
      ...compiled,
      definition: { ...compiled.definition, models: { ...MODELS, judge: MODELS.lead } },
    }),
    check: (run) => {
      expect(resolution(run)).toMatchObject({ status: "failed", port: "fail" });
      expect(resolution(run)?.error).toBe("judge-family");
      expect(turnSteps(run)).toEqual([]);
    },
  },
  {
    name: "fewer valid candidates than minCandidates end insufficient without a judge",
    world: {
      turn: (c) =>
        c === "c0/run"
          ? { headSha: "b0" }
          : c === "c1/run"
            ? { status: "failed", headSha: "s1" }
            : defaultTurn(c),
    },
    check: (run) => {
      expect(resolution(run)).toMatchObject({ status: "succeeded", port: "insufficient" });
      expect(resolution(run)?.output).toMatchObject({
        candidates: [{ id: "c2", sha: "s2", path: "/wt/duel/c2/ws" }],
        valid: 1,
        minCandidates: 2,
      });
      expect(resolution(run, "duel/c0/run")).toMatchObject({
        status: "failed",
        error: "no new commit",
      });
      expect(turnIntent(run, "judge")).toBeNull();
      expect(run.intent("ws:duel/judge/ws")).toBeUndefined();
    },
  },
  {
    name: "the node timeout interrupts the live candidates and drains the settled ones",
    patch: { timeout: "30m" },
    play: (run) => {
      const live = (c: string) => (c === "c1/run" ? "running" : defaultTurn(c));
      const waiting = play(run, { turn: live });
      expect(turnIntent(waiting, "judge")).toBeNull();
      expect(waiting.intent("interrupt:turn:duel/c1/run@1")).toBeUndefined();
      const judged = (c: string) =>
        c === "judge" ? { output: { ...VERDICT, base: "c2" } } : live(c);
      return play(waiting, { turn: judged }, T0 + 31 * MINUTE);
    },
    check: (run) => {
      expect(turnIntent(run, "c1/run")?.timeoutMs).toBe(30 * MINUTE);
      expect(run.intent("interrupt:turn:duel/c1/run@1")).toMatchObject({
        _tag: "Interrupt",
        step: "duel/c1/run",
      });
      const judge = turnIntent(run, "judge");
      expect(judge?.prompt).toContain("c0: commit s0");
      expect(judge?.prompt).toContain("c2: commit s2");
      expect(judge?.prompt).not.toContain("c1: commit");
      expect(run.intent("ws:duel/graft/ws")).toMatchObject({ baseRef: "s2" });
      expect(resolution(run)).toMatchObject({ status: "succeeded", port: "ok" });
    },
  },
  {
    name: "the graft starts at the base candidate's sha on a new write thread, candidates intact",
    check: (run) => {
      expect(run.intent("ws:duel/graft/ws")).toMatchObject({
        baseRef: "s1",
        branch: `wf/${RUN_ID}/duel/graft`,
      });
      const graft = turnIntent(run, "graft/r1");
      expect(graft).toMatchObject({
        mode: "new",
        access: "write",
        workspace: { name: "duel/graft/ws" },
      });
      expect(graft?.prompt).toContain("candidate c1 (commit s1)");
      expect(graft?.prompt).toContain("from c0 (commit s0, worktree /wt/duel/c0/ws)");
      expect(graft?.prompt).not.toContain("an idea from nobody");
      // The block never removes a candidate; the run's end cleans worktrees by `retain`.
      const endedSeq = run.state().endedSeq;
      expect(
        [...run.state().intents.values()].filter(
          (e) => e.intent._tag === "RemoveWorkspace" && e.seq < endedSeq,
        ),
      ).toEqual([]);
      expect(view(run)).toEqual({
        _tag: "arena",
        step: "duel",
        candidates: [
          { id: "c0", status: "succeeded", score: 7 },
          { id: "c1", status: "succeeded", score: 9 },
          { id: "c2", status: "succeeded", score: 4 },
        ],
        base: "c1",
        grafts: ["reuse c0's retry helper"],
      });
    },
  },
  {
    name: "a judge without a valid base fails the arena",
    world: {
      turn: (c) => (c === "judge" ? { output: { ...VERDICT, base: "c9" } } : defaultTurn(c)),
    },
    check: (run) => {
      expect(resolution(run)).toMatchObject({ status: "failed", port: "fail" });
      expect(resolution(run, "duel/judge")?.status).toBe("failed");
      expect(run.intent("ws:duel/graft/ws")).toBeUndefined();
    },
  },
  {
    name: "verify failing past maxReruns fails after one rerun on a new thread",
    patch: { verify: verifySpec },
    world: { unit: () => ({ exit: 1, tail: "1 test failed" }) },
    check: (run) => {
      expect(run.intent("unit:duel/verify/r1@1")).toMatchObject({
        argv: ["vp", "test", "run"],
        cwd: { name: "duel/graft/ws" },
        replay: "safe",
      });
      const rerun = turnIntent(run, "graft/r2");
      expect(rerun).toMatchObject({ mode: "new", workspace: { name: "duel/graft/ws" } });
      expect(rerun?.threadId).not.toBe(turnIntent(run, "graft/r1")?.threadId);
      expect(rerun?.prompt).toContain("1 test failed");
      expect(run.intent("unit:duel/verify/r2@1")).toBeDefined();
      expect(turnIntent(run, "graft/r3")).toBeNull();
      expect(resolution(run)).toMatchObject({ status: "failed", port: "fail" });
    },
  },
  {
    name: "verify passes by its check, not by exit 0 alone",
    patch: { verify: { ...verifySpec, parse: "json", check: "out.pass == true" } },
    world: {
      unit: (c) => ({ exit: 0, out: { pass: c !== "verify/r1" } }),
    },
    check: (run) => {
      expect(turnIntent(run, "graft/r2")?.prompt).toContain("check false");
      expect(resolution(run)).toMatchObject({ status: "succeeded", port: "ok" });
    },
  },
  {
    name: "a verify that timed out fails even when its output passes the check",
    patch: { verify: { ...verifySpec, parse: "json", check: "out.pass == true" }, maxReruns: 0 },
    world: { unit: () => ({ exit: 0, out: { pass: true }, signal: "TIMEOUT" }) },
    check: (run) => {
      expect(resolution(run)).toMatchObject({ status: "failed", port: "fail" });
    },
  },
  {
    name: "a retried arena grafts on a branch of its own attempt",
    patch: { verify: verifySpec, maxReruns: 0, retry: { max: 1, on: ["failed"] } },
    world: { unit: () => ({ exit: 1, tail: "red" }) },
    check: (run) => {
      const grafts = [...run.state().intents.values()].flatMap((e) =>
        e.intent._tag === "PrepareWorkspace" && e.intent.name.endsWith("graft/ws")
          ? [e.intent.branch]
          : [],
      );
      expect(grafts).toEqual([`wf/${RUN_ID}/duel/graft`, `wf/${RUN_ID}/duel/a2/graft`]);
    },
  },
  {
    name: "a verified graft ends ok and exports the graft worktree at its last head",
    patch: { verify: verifySpec },
    world: { unit: (c) => (c === "verify/r1" ? { exit: 1 } : { exit: 0 }) },
    check: (run) => {
      expect(resolution(run)).toMatchObject({ status: "succeeded", port: "ok" });
      expect(resolution(run)?.output).toEqual({
        base: "c1",
        scores: VERDICT.scores,
        grafts: [{ from: "c0", idea: "reuse c0's retry helper" }],
        sha: "g2",
        exports: {
          graft: {
            name: "duel/graft/ws",
            path: "/wt/duel/graft/ws",
            project: "t3code",
            branch: `wf/${RUN_ID}/duel/graft`,
            head: "g2",
          },
        },
      });
    },
  },
];

describe("arena block", () => {
  it.each(cases)("$name", ({ patch, mutate, world, check, play: playCase }) => {
    const run = start(patch, mutate);
    check(playCase === undefined ? play(run, world) : playCase(run));
  });
});
