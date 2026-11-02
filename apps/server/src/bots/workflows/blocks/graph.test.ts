import type { Json } from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { resolveModelUse } from "@t3tools/shared/workflows";

import type { Intent } from "../facts.ts";
import {
  compile,
  iso,
  RUN_ID,
  runStarted,
  T0,
  TestRun,
  turnSettled,
  unitExited,
} from "../testkit/decideHarness.ts";
import { validateGraphPlan } from "./graph.ts";
import { blockView } from "./registry.ts";

const sol = { provider: "codex", model: "gpt-6.1-sol", effort: "low" } as const;
const resolveModel = (use: Parameters<typeof resolveModelUse>[0]) => resolveModelUse(use, { sol });

const leaf = (id: string, owns: string[], deps: string[] = [], extra: object = {}) => ({
  id,
  goal: `Build ${id}`,
  owns,
  deps,
  accept: ["node", `test-${id}.ts`],
  ...extra,
});

const graphNode = {
  kind: "graph",
  goal: "Ship the feature",
  lead: "$lead",
  leaf: "$sol",
  workspace: { project: "t3code", base: "friend/main" },
  finalChecks: [{ argv: ["node", "check.ts"], cwd: "build.integration" }],
  reworkCap: 1,
  maxLeaves: 4,
  maxParallel: 2,
};

const start = (patch: Record<string, unknown> = {}) =>
  TestRun.start(
    compile({
      budget: { steps: 500, wall: "2h", tokens: 30_000_000 },
      fatigue: { consecutiveFailures: 50 },
      nodes: {
        build: { ...graphNode, ...patch },
        done: { kind: "output", status: "ready_for_review", value: {} },
        stuck: { kind: "output", status: "blocked", value: {} },
        broke: { kind: "output", status: "checks_failed", value: {} },
      },
      edges: ["build:ok -> done", "build:blocked -> stuck", "build:fail -> broke"],
    }),
    runStarted({ budget: { steps: 500, wallMs: 7_200_000, tokens: 30_000_000, usd: null } }),
  );

/** How the simulated host answers an intent; `hold` leaves it running. */
type Reply =
  | "hold"
  | {
      readonly fail?: string;
      readonly head?: string | null;
      readonly output?: Json;
      readonly exit?: number;
      readonly tail?: string;
      readonly sha?: string;
      readonly parseError?: string;
    };
type Respond = (intent: Intent) => Reply | undefined;

/** The leaf id and round of a leaf's run turn (`build/leaf/a/run_2` → a, 2). */
const leafRun = (step: string) => {
  const m = /^build\/leaf\/([a-z0-9_]+)\/run(?:_(\d+))?$/.exec(step);
  return m === null ? null : { id: m[1] ?? "", round: Number(m[2] ?? 1) };
};

/** A host where every child succeeds: leaves commit `h_<id>_<round>`, merges land at `m_<from>`. */
const world =
  (plan: ReadonlyArray<Json>, overrides: Respond = () => undefined) =>
  (intent: Intent): Reply => {
    const override = overrides(intent);
    if (override !== undefined) return override;
    if (intent._tag === "GitOp") return { sha: `m_${intent.op.from}` };
    if (intent._tag !== "StartTurn") return {};
    if (intent.step === "build/lead/contract") return { head: "contract0" };
    if (intent.step.startsWith("build/lead/plan")) return { output: { leaves: [...plan] } };
    const run = leafRun(intent.step);
    if (run !== null) return { head: `h_${run.id}_${run.round}`, output: {} };
    return { head: `lead_${intent.step.split("_").at(-1)}` };
  };

const answer = (run: TestRun, intent: Intent, reply: Exclude<Reply, "hold">) => {
  if (reply.fail !== undefined) {
    run.result(intent.key, { _tag: "IntentFailed", error: reply.fail, retryable: false });
    return;
  }
  switch (intent._tag) {
    case "PrepareWorkspace":
      run.result(intent.key, {
        _tag: "WorkspaceReady",
        name: intent.name,
        path: `/w/${intent.name}`,
        branch: intent.branch,
        headSha: intent.baseRef === "friend/main" ? "base0" : intent.baseRef,
      });
      return;
    case "StartTurn": {
      run.result(intent.key, { _tag: "TurnStarted", threadId: intent.threadId });
      const nudge = intent.key.startsWith("nudge:") ? ":nudge" : "";
      const settled = turnSettled(intent.step, 1, "completed", reply.output ?? {});
      if (settled._tag !== "TurnSettled") throw new Error("turnSettled built another fact");
      run.add(`settled:${intent.step}@1${nudge}`, { ...settled, headSha: reply.head ?? null });
      return;
    }
    case "StartUnit":
      run.result(intent.key, { _tag: "UnitSpawned", unit: intent.key, at: iso(T0) });
      run.add(
        `exited:${intent.step}@1`,
        unitExited(intent.step, 1, reply.exit ?? 0, {
          tail: reply.tail ?? "",
          parseError: reply.parseError ?? null,
        }),
      );
      return;
    case "GitOp":
      run.result(intent.key, { _tag: "GitOpDone", sha: reply.sha ?? "" });
      return;
    case "RemoveWorkspace":
      run.result(intent.key, { _tag: "WorkspaceRemoved" });
      return;
    case "UpsertCard":
      run.result(intent.key, { _tag: "CardUpserted" });
      return;
    case "Notify":
      run.result(intent.key, { _tag: "Notified" });
      return;
    default:
      throw new Error(`unexpected intent ${intent._tag}`);
  }
};

/** Drives the run, answering every pending intent, until a pass changes nothing. */
const play = (run: TestRun, respond: (intent: Intent) => Reply): TestRun => {
  for (let pass = 0; pass < 300; pass++) {
    const out = run.drive();
    let answered = 0;
    for (const entry of run.state().intents.values()) {
      if (entry.result !== null) continue;
      const reply = respond(entry.intent);
      if (reply === "hold") continue;
      answer(run, entry.intent, reply);
      answered++;
    }
    if (out.length === 0 && answered === 0) return run;
  }
  throw new Error("the run never settled");
};

const resolution = (run: TestRun) => run.state().attempts.get("build")?.at(-1)?.resolved ?? null;
const turnIntent = (run: TestRun, step: string) => {
  const intent = run.intent(`turn:${step}@1`);
  return intent?._tag === "StartTurn" ? intent : undefined;
};
const view = (run: TestRun) => {
  const node = run.compiled.definition.nodes.build;
  if (node?.kind !== "graph") throw new Error("no graph node");
  return blockView(node, run.state(), "build", 1, T0);
};

describe("validateGraphPlan", () => {
  it.each([
    {
      name: "accepts overlapping owns of a leaf and its dependent",
      leaves: [leaf("a", ["src/**"]), leaf("b", ["src/b.ts"], ["a"])],
      diagnostic: null,
    },
    {
      name: "refuses a cycle",
      leaves: [leaf("a", ["a/**"], ["b"]), leaf("b", ["b/**"], ["a"])],
      diagnostic: "cycle",
    },
    {
      name: "refuses a missing dep",
      leaves: [leaf("a", ["a/**"], ["ghost"])],
      diagnostic: 'depends on "ghost"',
    },
    {
      name: "refuses overlapping owns of leaves that run together",
      leaves: [leaf("a", ["src/**"]), leaf("b", ["src/b/*.ts"])],
      diagnostic: "can run together",
    },
    {
      name: "refuses an accept through bash -c",
      leaves: [leaf("a", ["a/**"], [], { accept: ["bash", "-c", "vp test"] })],
      diagnostic: "inline-shell",
    },
    {
      name: "refuses more than maxLeaves",
      leaves: ["a", "b", "c"].map((id) => leaf(id, [`${id}/**`])),
      diagnostic: "at most 2",
    },
    {
      name: "refuses an id that is not a step segment",
      leaves: [leaf("Bad-Id", ["a/**"])],
      diagnostic: "id must match",
    },
    {
      name: "refuses an unknown model",
      leaves: [leaf("a", ["a/**"], [], { model: "$ghost" })],
      diagnostic: "Missing $ghost",
    },
  ])("$name", ({ leaves, diagnostic }) => {
    const result = validateGraphPlan({ leaves }, { maxLeaves: 2 }, resolveModel);
    expect(result).toMatchObject(
      diagnostic === null
        ? { ok: true }
        : {
            ok: false,
            diagnostics: expect.arrayContaining([expect.stringContaining(diagnostic)]),
          },
    );
  });
});

describe("graph block", () => {
  it("integrates a dependent from its dep's merge and exports the integration", () => {
    const plan = [leaf("a", ["src/a/**"]), leaf("b", ["src/b/**"], ["a"])];
    const run = play(start(), world(plan));

    expect(run.intent("ws:build/integ")).toMatchObject({
      baseRef: "friend/main",
      branch: `wf/${RUN_ID}/build/integration`,
    });
    expect(run.intent("unit:build/contract/check@1")).toMatchObject({
      argv: ["node", "check.ts"],
      cwd: { name: "build/integ" },
    });
    expect(turnIntent(run, "build/lead/plan")).toMatchObject({
      mode: "continue",
      threadId: turnIntent(run, "build/lead/contract")?.threadId,
    });
    expect(run.intent("ws:build/leaf/a/ws1")).toMatchObject({ baseRef: "contract0", branch: null });
    expect(run.intent("unit:build/leaf/a/scope1@1")).toMatchObject({
      argv: [
        "git",
        "diff",
        "--name-only",
        "contract0",
        "h_a_1",
        "--",
        ".",
        ":(exclude,glob)src/a/**",
      ],
    });
    expect(run.intent("ws:build/leaf/b/ws1")).toMatchObject({ baseRef: "m_h_a_1" });
    expect(run.intent("git:build/leaf/b/merge1")).toMatchObject({
      op: { kind: "mergeLocal", from: "h_b_1", expectHead: "m_h_a_1" },
    });
    expect(run.intent("unit:build/final/check0@1")).toBeDefined();
    expect(run.intent("rm:build/leaf/a/ws1")).toBeDefined();
    expect(resolution(run)).toMatchObject({
      port: "ok",
      output: {
        sha: "m_h_b_1",
        exports: { integration: { name: "build/integ", head: "m_h_b_1" } },
      },
    });
    expect(view(run)).toMatchObject({
      leaves: [
        { id: "a", status: "succeeded", rework: 0, sha: "m_h_a_1" },
        { id: "b", status: "succeeded", deps: ["a"], sha: "m_h_b_1" },
      ],
    });
  });

  it("sends a leaf that changed files outside owns back to its thread", () => {
    const plan = [leaf("a", ["src/a/**"])];
    const run = play(
      start(),
      world(plan, (intent) =>
        intent._tag === "StartUnit" && intent.step === "build/leaf/a/scope1"
          ? { tail: "src/other.ts\n" }
          : undefined,
      ),
    );

    const rework = turnIntent(run, "build/leaf/a/run_2");
    expect(rework).toMatchObject({
      mode: "continue",
      threadId: turnIntent(run, "build/leaf/a/run")?.threadId,
      workspace: { name: "build/leaf/a/ws1" },
    });
    expect(rework?.prompt).toContain("out-of-scope");
    expect(rework?.prompt).toContain("src/other.ts");
    expect(run.intent("unit:build/leaf/a/accept1@1")).toBeUndefined();
    expect(run.intent("git:build/leaf/a/merge2")).toMatchObject({ op: { from: "h_a_2" } });
    expect(resolution(run)).toMatchObject({ port: "ok", output: { sha: "m_h_a_2" } });
    expect(view(run)).toMatchObject({ leaves: [{ id: "a", rework: 1 }] });
  });

  it("hands a leaf blocked on the contract to the lead's thread", () => {
    const plan = [leaf("a", ["src/a/**"])];
    const run = play(
      start(),
      world(plan, (intent) =>
        intent._tag === "StartTurn" && intent.step === "build/leaf/a/run"
          ? { head: "h_a_1", output: { blocked: "contract" } }
          : undefined,
      ),
    );

    expect(turnIntent(run, "build/lead/leaf_a")).toMatchObject({
      mode: "continue",
      threadId: turnIntent(run, "build/lead/contract")?.threadId,
    });
    expect(run.intent("unit:build/leaf/a/scope1@1")).toBeUndefined();
    expect(turnIntent(run, "build/leaf/a/run_2")).toBeUndefined();
    expect(resolution(run)).toMatchObject({ port: "ok", output: { sha: "lead_a" } });
  });

  it("runs at most maxParallel leaves at once", () => {
    const plan = ["a", "b", "c"].map((id) => leaf(id, [`src/${id}/**`]));
    const holdLeaves = world(plan, (intent) =>
      intent._tag === "StartTurn" && leafRun(intent.step) !== null ? "hold" : undefined,
    );
    const run = play(start(), holdLeaves);

    expect(run.intent("ws:build/leaf/a/ws1")).toBeDefined();
    expect(run.intent("ws:build/leaf/b/ws1")).toBeDefined();
    expect(run.intent("ws:build/leaf/c/ws1")).toBeUndefined();

    play(run, world(plan));
    expect(run.intent("ws:build/leaf/c/ws1")).toMatchObject({ baseRef: "m_h_a_1" });
    expect(resolution(run)).toMatchObject({ port: "ok", output: { sha: "m_h_c_1" } });
  });

  it("blocks a plan that is still invalid after two retries", () => {
    const cyclic = world([], (intent) =>
      intent._tag === "StartTurn" && intent.step.startsWith("build/lead/plan")
        ? { output: { leaves: [leaf("a", ["a/**"], ["a"])] } }
        : undefined,
    );
    const run = play(start(), cyclic);

    expect(turnIntent(run, "build/lead/plan_3")).toMatchObject({ mode: "continue" });
    expect(turnIntent(run, "build/lead/plan_3")?.prompt).toContain("not another leaf");
    expect(run.intent("turn:build/lead/plan_4@1")).toBeUndefined();
    expect(resolution(run)).toMatchObject({
      port: "blocked",
      error: expect.stringContaining("still invalid"),
    });
  });

  it.each([
    {
      name: "blocks a contract that fails the first check",
      step: "contract/check",
      port: "blocked",
    },
    { name: "fails on a red final check", step: "final/check0", port: "fail" },
  ])("$name", ({ step, port }) => {
    const red = world([leaf("a", ["src/a/**"])], (intent) =>
      intent._tag === "StartUnit" && intent.step === `build/${step}`
        ? { exit: 1, tail: "red" }
        : undefined,
    );
    const run = play(start(), red);
    expect(resolution(run)).toMatchObject({ port, error: expect.stringContaining("red") });
  });

  it("fails a final check whose output does not parse, even when its check would pass", () => {
    const unparsable = world([leaf("a", ["src/a/**"])], (intent) =>
      intent._tag === "StartUnit" && intent.step === "build/final/check0"
        ? { exit: 0, tail: "not json", parseError: "Unexpected token" }
        : undefined,
    );
    const run = play(
      start({
        finalChecks: [
          {
            argv: ["node", "check.ts"],
            cwd: "build.integration",
            parse: "json",
            check: "exit == 0",
          },
        ],
      }),
      unparsable,
    );
    expect(resolution(run)).toMatchObject({ port: "fail" });
  });
});
