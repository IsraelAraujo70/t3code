import type { Json } from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import type { Intent } from "../facts.ts";
import {
  compile,
  iso,
  runStarted,
  T0,
  TestRun,
  turnSettled,
  unitExited,
} from "../testkit/decideHarness.ts";
import { blockView } from "./registry.ts";

const reviewNode = {
  kind: "interrogate",
  target: { workspace: "integ", baseRef: "friend/main" },
  intent: "Ship the feature",
  mode: "loop",
  reviewers: ["$sol"],
  lead: "$lead",
  checks: [{ argv: ["node", "check.ts"], cwd: "integ" }],
  rounds: 3,
};

/** `impl` commits `impl0` in the declared workspace `integ`, then `review` interrogates it. */
const start = (patch: object = {}, withImpl = true) =>
  TestRun.start(
    compile({
      budget: { steps: 500, wall: "2h", tokens: 30_000_000 },
      fatigue: { consecutiveFailures: 50 },
      nodes: {
        ...(withImpl
          ? {
              impl: {
                kind: "agent",
                model: "$lead",
                prompt: "Implement it",
                workspace: "integ",
                access: "write",
              },
            }
          : {}),
        review: { ...reviewNode, ...patch },
        done: { kind: "output", status: "ready_for_review", value: {} },
        stuck: { kind: "output", status: "blocked", value: {} },
        broke: { kind: "output", status: "checks_failed", value: {} },
      },
      edges: [
        ...(withImpl ? ["impl -> review"] : []),
        "review:approve -> done",
        "review:stuck -> stuck",
        "review:fail -> broke",
      ],
    }),
    runStarted({ budget: { steps: 500, wallMs: 7_200_000, tokens: 30_000_000, usd: null } }),
  );

/** How the simulated host answers an intent; `hold` leaves it running. */
type Reply =
  | "hold"
  | {
      readonly fail?: string;
      readonly status?: "completed" | "failed" | "interrupted";
      readonly text?: string;
      readonly head?: string | null;
      readonly output?: Json;
      readonly exit?: number;
      readonly tail?: string;
      readonly parseError?: string;
    };

const approve = { output: { verdict: "APPROVE", findings: [] } };
const finding = (id: string, severity: string) => ({
  id,
  severity,
  file: "src/a.ts",
  line: 3,
  claim: `claim ${id}`,
  evidence: "read it",
});
const changes = (...findings: Json[]) => ({
  output: { verdict: "CHANGES", findings },
});
const resolve = (state: string, ...ids: ReadonlyArray<string>) => ({
  output: { resolutions: ids.map((id) => ({ id, state })) },
});

/** Reviewer `r<n>/rev<i>` and lead `r<n>/lead` answers; the lead commits `lead<n>` by default. */
interface Script {
  readonly review: (round: number, reviewer: number) => Reply;
  readonly lead?: (round: number) => Exclude<Reply, "hold">;
  readonly unit?: (step: string) => Reply;
}

const world =
  (script: Script) =>
  (intent: Intent): Reply => {
    if (intent._tag === "StartUnit") return script.unit?.(intent.step) ?? {};
    if (intent._tag !== "StartTurn") return {};
    if (intent.step === "impl") return { head: "impl0" };
    const reviewer = /^review\/r(\d+)\/rev(\d+)$/.exec(intent.step);
    if (reviewer !== null) return script.review(Number(reviewer[1]), Number(reviewer[2]));
    const lead = /^review\/r(\d+)\/lead$/.exec(intent.step);
    if (lead !== null) {
      const n = Number(lead[1]);
      return { head: `lead${n}`, ...(script.lead?.(n) ?? resolve("fixed")) };
    }
    throw new Error(`unexpected turn ${intent.step}`);
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
        ...(intent.baseRef === "friend/main"
          ? { base: { ref: "refs/remotes/origin/friend/main", sha: "base0" } }
          : {}),
      });
      return;
    case "StartTurn": {
      run.result(intent.key, { _tag: "TurnStarted", threadId: intent.threadId });
      const nudge = intent.key.startsWith("nudge:") ? ":nudge" : "";
      const settled = turnSettled(intent.step, 1, reply.status ?? "completed", reply.output ?? {});
      if (settled._tag !== "TurnSettled") throw new Error("turnSettled built another fact");
      run.add(`settled:${intent.step}@1${nudge}`, {
        ...settled,
        headSha: reply.head ?? null,
        text: reply.text ?? settled.text,
      });
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

const resolution = (run: TestRun) => run.state().attempts.get("review")?.at(-1)?.resolved ?? null;
const turnIntent = (run: TestRun, step: string) => {
  const intent = run.intent(`turn:review/${step}@1`);
  return intent?._tag === "StartTurn" ? intent : undefined;
};
const view = (run: TestRun) => {
  const node = run.compiled.definition.nodes.review;
  if (node?.kind !== "interrogate") throw new Error("no interrogate node");
  return blockView(node, run.state(), "review", 1, T0);
};

describe("interrogate block", () => {
  it("approves a clean APPROVE without a lead turn", () => {
    const run = play(start(), world({ review: () => approve }));

    expect(run.intent("ws:review/r1/rev0/ws")).toMatchObject({ baseRef: "impl0", branch: null });
    expect(turnIntent(run, "r1/rev0")).toMatchObject({
      mode: "new",
      access: "read",
      workspace: { name: "review/r1/rev0/ws" },
    });
    expect(turnIntent(run, "r1/rev0")?.prompt).toContain("git diff base0..HEAD");
    expect(run.intent("rm:review/r1/rev0/ws")).toBeDefined();
    expect(turnIntent(run, "r1/lead")).toBeUndefined();
    expect(resolution(run)).toMatchObject({
      port: "approve",
      output: { rounds: 1, verdict: "approve", findings: [] },
    });
  });

  it("stops early with approve when only nits are open", () => {
    const run = play(start(), world({ review: () => changes(finding("n1", "nit")) }));

    expect(turnIntent(run, "r1/lead")).toBeUndefined();
    expect(resolution(run)).toMatchObject({
      port: "approve",
      output: { rounds: 1, findings: [{ id: "n1", severity: "nit", state: "open" }] },
    });
  });

  it("opens new reviewer threads each round and continues the lead's thread", () => {
    const run = play(
      start(),
      world({
        review: (n) =>
          n === 1
            ? changes(finding("b1", "blocker"))
            : n === 2
              ? changes(finding("s1", "should"))
              : approve,
      }),
    );

    const reviewers = [1, 2, 3].map((n) => turnIntent(run, `r${n}/rev0`));
    for (const reviewer of reviewers) expect(reviewer).toMatchObject({ mode: "new" });
    expect(new Set(reviewers.map((r) => r?.threadId)).size).toBe(3);
    expect(run.intent("ws:review/r2/rev0/ws")).toMatchObject({ baseRef: "lead1" });
    expect(run.intent("ws:review/r3/rev0/ws")).toMatchObject({ baseRef: "lead2" });
    expect(reviewers[1]?.prompt).toContain("git diff impl0..HEAD");
    expect(reviewers[1]?.prompt).toContain("b1 [blocker]");

    const lead1 = turnIntent(run, "r1/lead");
    expect(lead1).toMatchObject({ mode: "new", access: "write", workspace: { name: "integ" } });
    expect(lead1?.prompt).toContain("b1 [blocker] src/a.ts:3: claim b1");
    expect(turnIntent(run, "r2/lead")).toMatchObject({
      mode: "continue",
      threadId: lead1?.threadId,
    });
    expect(run.intent("unit:review/r1/check0@1")).toMatchObject({
      argv: ["node", "check.ts"],
      cwd: { name: "integ" },
    });
    expect(resolution(run)).toMatchObject({
      port: "approve",
      output: {
        rounds: 3,
        findings: [
          { id: "b1", state: "resolved" },
          { id: "s1", state: "resolved" },
        ],
      },
    });
    expect(view(run)).toMatchObject({
      round: 3,
      verdict: "approve",
      findings: [{ id: "b1", summary: "claim b1", state: "resolved" }, { id: "s1" }],
    });
  });

  it.each<{ name: string; first: Reply }>([
    { name: "times out", first: { status: "interrupted" } },
    { name: "fails to launch", first: { fail: "provider down" } },
    { name: "answers invalid JSON", first: { output: { verdict: "LGTM", findings: [] } } },
  ])("never counts a reviewer that $name as an approval", ({ first }) => {
    const run = play(start(), world({ review: (n) => (n === 1 ? first : approve) }));

    expect(turnIntent(run, "r1/lead")).toBeUndefined();
    expect(turnIntent(run, "r2/rev0")).toMatchObject({ mode: "new" });
    expect(resolution(run)).toMatchObject({ port: "approve", output: { rounds: 2 } });
  });

  it("is stuck at the round cap, with the last round's failing checks", () => {
    const run = play(
      start({ rounds: 2 }),
      world({
        review: () => changes(finding("b1", "blocker")),
        lead: () => resolve("fixed", "b1"),
        unit: (step) => (step === "review/r2/check0" ? { exit: 1, tail: "red" } : {}),
      }),
    );

    expect(run.intent("unit:review/r2/check0@1")).toBeDefined();
    expect(turnIntent(run, "r3/rev0")).toBeUndefined();
    expect(resolution(run)).toMatchObject({
      port: "stuck",
      output: {
        rounds: 2,
        verdict: "stuck",
        reason: expect.stringContaining("check 0 (exit 1): red"),
        findings: [{ id: "b1", state: "fixed" }],
      },
    });
  });

  it("counts a check whose output does not parse as failing, even when its check would pass", () => {
    const run = play(
      start({
        rounds: 2,
        checks: [{ argv: ["node", "check.ts"], cwd: "integ", parse: "json", check: "exit == 0" }],
      }),
      world({
        review: () => changes(finding("b1", "blocker")),
        lead: () => resolve("fixed", "b1"),
        unit: () => ({ exit: 0, tail: "not json", parseError: "Unexpected token" }),
      }),
    );
    expect(resolution(run)).toMatchObject({
      port: "stuck",
      output: { reason: expect.stringContaining("check 0") },
    });
  });

  it("fails, not stuck, when no reviewer answered the last round", () => {
    const error = "stream disconnected before completion: Unable to verify model access right now.";
    const run = play(start(), world({ review: () => ({ status: "failed", text: error }) }));

    expect(turnIntent(run, "r3/rev0")).toBeDefined();
    expect(resolution(run)).toMatchObject({
      status: "failed",
      port: "fail",
      error: expect.stringContaining(`no reviewer answered in round 3:\nreviewer 0: ${error}`),
    });
    expect(run.state().attempts.get("broke")?.at(-1)?.resolved?.status).toBe("succeeded");
  });

  it("is stuck when the lead disputes the same finding in two rounds", () => {
    const run = play(
      start(),
      world({
        review: () => changes(finding("b1", "blocker")),
        lead: () => resolve("disagree", "b1"),
      }),
    );

    expect(turnIntent(run, "r2/rev0")?.prompt).toContain("lead: disagree");
    expect(run.intent("unit:review/r2/check0@1")).toBeUndefined();
    expect(resolution(run)).toMatchObject({
      port: "stuck",
      output: { rounds: 2, reason: expect.stringContaining("b1 was disputed") },
    });
  });

  it("panel: reviews round two only with the reviewers that had open findings", () => {
    const run = play(
      start({ mode: "panel", reviewers: ["$sol", "$lead"] }),
      world({
        review: (n, i) => (n === 1 && i === 1 ? changes(finding("x", "should")) : approve),
      }),
    );

    expect(turnIntent(run, "r1/rev0")).toBeDefined();
    expect(turnIntent(run, "r1/rev1")).toBeDefined();
    expect(turnIntent(run, "r1/lead")?.prompt).toContain("rev1.x [should]");
    expect(turnIntent(run, "r2/rev0")).toBeUndefined();
    expect(turnIntent(run, "r2/rev1")).toMatchObject({ mode: "new" });
    expect(resolution(run)).toMatchObject({
      port: "approve",
      output: { rounds: 2, findings: [{ id: "rev1.x", state: "resolved" }] },
    });
  });

  it("fails when the target workspace was never prepared", () => {
    const run = play(start({}, false), world({ review: () => approve }));

    expect(turnIntent(run, "r1/rev0")).toBeUndefined();
    expect(resolution(run)).toMatchObject({
      port: "fail",
      error: expect.stringContaining("target workspace integ was never prepared"),
    });
  });
});
