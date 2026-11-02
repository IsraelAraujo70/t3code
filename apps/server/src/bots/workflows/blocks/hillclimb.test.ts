import type { Json } from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import type { Intent, LedgerFact } from "../facts.ts";
import { compile, cost, RUN_ID, runStarted, TestRun } from "../testkit/decideHarness.ts";

const LEDGER = "ledger:exp";
const ARTIFACTS = `/runs/${RUN_ID}/artifacts`;

const climb = (patch: Record<string, unknown>) => ({
  kind: "hillclimb",
  workspace: { project: "t3code", base: "{{coalesce(ledgerBest('exp'), params.from)}}" },
  ledger: "exp",
  generator: {
    model: "$lead",
    workspace: { project: "t3code", readOnly: true },
    prompt: "Make it faster.",
  },
  build: { argv: ["make"], cwd: "attempt", heavy: true, replay: "safe", artifact: "out/bin" },
  measure: {
    bench: {
      argv: ["bench", "--base", "{{best.artifact}}", "--cand", "{{candidate.artifact}}"],
      cwd: { project: "t3code", readOnly: true },
    },
  },
  objective: { expr: "m.bench.ratio", direction: "max" },
  keep: "m.bench.complete && m.bench.ratio >= 1.05",
  target: "m.bench.ratio >= 1.5",
  plateau: { rounds: 2 },
  budget: { iterations: 10 },
  ...patch,
});

const start = (patch: Record<string, unknown> = {}) =>
  TestRun.start(
    compile({
      budget: { steps: 300, wall: "12h", tokens: 30_000_000 },
      fatigue: { consecutiveFailures: 10 },
      params: { from: { type: "string", default: "feat/x", pattern: "^[A-Za-z0-9._/-]+$" } },
      nodes: {
        climb: climb(patch),
        win: { kind: "output", status: "ready_for_review", value: {} },
        flat: { kind: "output", status: "no_gain", value: {} },
        stuck: { kind: "output", status: "blocked", value: {} },
      },
      edges: [
        "climb:target -> win",
        "climb:no_gain -> flat",
        "climb:budget -> flat",
        "climb:blocked -> stuck",
      ],
    }),
    runStarted({
      params: { from: "feat/x" },
      budget: { steps: 300, wallMs: 43_200_000, tokens: 30_000_000, usd: null },
    }),
  );

interface TurnAnswer {
  readonly output?: Json;
  readonly headSha?: string | null;
  readonly treeHash?: string | null;
}
interface UnitAnswer {
  readonly exit?: number;
  readonly out?: Json;
}
/** Answers by block child id (`r1/propose`); `undefined` leaves the child running. */
interface World {
  readonly turn?: (child: string) => TurnAnswer | undefined;
  readonly unit?: (child: string) => UnitAnswer | undefined;
}

const roundOf = (child: string) => child.match(/^r(\d+)/)?.[1] ?? "0";

/** Every proposal is new, every commit and tree is fresh, every measure is complete. */
const defaultTurn = (child: string): TurnAnswer | undefined => {
  const n = roundOf(child);
  if (/\/propose(_2)?$/.test(child))
    return { output: { key: `k${n}${child.endsWith("_2") ? "b" : ""}`, mechanism: `m${n}` } };
  if (/\/dedupe(_2)?$/.test(child)) return { output: { repeat: false, reason: "new" } };
  if (/\/implement(_2)?$/.test(child))
    return { headSha: `c${n}${child.endsWith("_2") ? "b" : ""}`, treeHash: `t${child}` };
  return undefined;
};
const bench = (ratio: number, extra: Record<string, Json> = {}): UnitAnswer => ({
  out: { complete: true, ratio, ...extra },
});
const defaultUnit = (child: string): UnitAnswer | undefined =>
  child.includes("/m_") || child.includes("/c_") ? bench(1) : { exit: 0 };

const REFS: Record<string, string> = { "feat/x": "o0", HEAD: "h0" };

/** Plays the interpreter: drives until quiet, answering every pending intent from `world`. */
const play = (run: TestRun, world: World = {}) => {
  const answered = new Set<string>();
  const childOf = (step: string) => step.slice("climb/".length);
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
        run.add(`settled:${intent.step}@1`, {
          _tag: "TurnSettled",
          step: intent.step,
          attempt: 1,
          status: "completed",
          text: "reply",
          output: reply.output ?? null,
          outputError: null,
          cost,
          headSha: reply.headSha ?? null,
          treeHash: reply.treeHash ?? null,
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
          exit: reply.exit ?? 0,
          signal: null,
          queuedMs: 0,
          out: reply.out ?? null,
          tail: "",
          lost: false,
          started: true,
        });
        return true;
      }
      case "GitOp":
        run.result(key, {
          _tag: "GitOpDone",
          sha: intent.op.kind === "advance" ? intent.op.to : "merged",
        });
        return true;
      case "RemoveWorkspace":
        run.result(key, { _tag: "WorkspaceRemoved" });
        return true;
      default:
        return false;
    }
  };
  for (let pass = 0; pass < 200; pass += 1) {
    const emitted = run.drive().length;
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

const resolution = (run: TestRun, step = "climb") =>
  run
    .state()
    .attempts.get(step)
    ?.find((a) => a.attempt === 1)?.resolved ?? null;
const argvOf = (run: TestRun, child: string) => {
  const intent = run.intent(`unit:climb/${child}@1`);
  return intent?._tag === "StartUnit" ? intent.argv : null;
};
const turnIntent = (run: TestRun, child: string) => {
  const intent = run.intent(`turn:climb/${child}@1`);
  return intent?._tag === "StartTurn" ? intent : null;
};
const entry = (run: TestRun, key: string) => run.ledgers().get("exp")?.entries.get(key);
const foreign = (key: string, sha: string | null = null): ReadonlyArray<LedgerFact> => [
  {
    _tag: "EntryRegistered",
    key,
    workflowId: "demo",
    runId: "other",
    step: "climb/r1",
    hypothesis: "old",
    barHash: "bar",
    at: "now",
  },
  ...(sha === null
    ? []
    : [
        {
          _tag: "EntryResolved",
          key,
          verdict: "kept",
          before: null,
          after: null,
          sha,
          note: null,
          at: "now",
        } satisfies LedgerFact,
      ]),
];
const seed = (run: TestRun, facts: ReadonlyArray<LedgerFact>) =>
  facts.reduce((r, fact, i) => r.addLedger(LEDGER, `seed:${i}`, fact), run);

interface Case {
  readonly name: string;
  readonly patch?: Record<string, unknown>;
  readonly ledger?: ReadonlyArray<LedgerFact>;
  readonly world?: World;
  readonly check: (run: TestRun) => void;
}

const cases: ReadonlyArray<Case> = [
  {
    name: "a key another run registered sends the round to a second proposal",
    ledger: foreign("k1"),
    world: { turn: (c) => (c === "r1/implement_2" ? undefined : defaultTurn(c)) },
    check: (run) => {
      expect(turnIntent(run, "r1/propose_2")?.mode).toBe("new");
      expect(turnIntent(run, "r1/implement")).toBeNull();
      expect(turnIntent(run, "r1/implement_2")).not.toBeNull();
      expect(entry(run, "k1")?.runId).toBe("other");
      expect(entry(run, "k1b")).toMatchObject({ runId: RUN_ID, step: "climb/r1_2" });
    },
  },
  {
    name: "a tree another entry claimed is a duplicate: discarded, then a second proposal",
    ledger: [{ _tag: "TreeSeen", treeHash: "tr1/implement", entryKey: "old", runId: "other" }],
    world: { turn: (c) => (c === "r1/implement_2" ? undefined : defaultTurn(c)) },
    check: (run) => {
      expect(entry(run, "k1")?.verdict).toBe("duplicate");
      expect(run.intent("rm:climb/r1/ws")?._tag).toBe("RemoveWorkspace");
      expect(argvOf(run, "r1/build")).toBeNull();
      expect(turnIntent(run, "r1/propose_2")).not.toBeNull();
    },
  },
  {
    name: "rounds without gain up to the plateau end no_gain at the origin",
    check: (run) => {
      expect(resolution(run)).toMatchObject({ status: "succeeded", port: "no_gain" });
      expect(resolution(run)?.output).toMatchObject({
        endedBy: "plateau",
        bestSha: "o0",
        attempts: 2,
        // Published as the best branch, so an output's pull request can push it.
        exports: { best: { head: "o0", branch: `wf/${RUN_ID}/climb/best` } },
      });
      expect(entry(run, "k1")?.verdict).toBe("rejected");
      expect(entry(run, "k2")?.verdict).toBe("rejected");
      expect(turnIntent(run, "r3/propose")).toBeNull();
      expect(run.intent("ws:climb/best")).toMatchObject({ baseRef: "o0", branch: null });
    },
  },
  {
    name: "the bar is read only on the confirmation against the origin (miss)",
    patch: { plateau: { rounds: 1 } },
    world: {
      unit: (c) =>
        c === "r1/m_bench" ? bench(2) : c === "r1/c_bench" ? bench(1.2) : defaultUnit(c),
    },
    check: (run) => {
      expect(argvOf(run, "r1/c_bench")).toEqual([
        "bench",
        "--base",
        `${ARTIFACTS}/o0/bin`,
        "--cand",
        `${ARTIFACTS}/c1/bin`,
      ]);
      expect(argvOf(run, "r2/m_bench")?.[2]).toBe(`${ARTIFACTS}/c1/bin`);
      expect(run.intent("git:climb/r1/advance")).toMatchObject({
        op: { kind: "advance", branch: `wf/${RUN_ID}/climb/best`, from: "o0", to: "c1" },
      });
      expect(entry(run, "k1")?.verdict).toBe("kept");
      expect(resolution(run)).toMatchObject({ port: "no_gain" });
      expect(resolution(run)?.output).toMatchObject({ endedBy: "plateau", bestSha: "c1" });
    },
  },
  {
    name: "the bar is read only on the confirmation against the origin (hit)",
    world: {
      unit: (c) =>
        c === "r1/m_bench" ? bench(1.1) : c === "r1/c_bench" ? bench(1.6) : defaultUnit(c),
    },
    check: (run) => {
      expect(resolution(run)).toMatchObject({ status: "succeeded", port: "target" });
      expect(resolution(run)?.output).toMatchObject({
        endedBy: "target",
        bestSha: "c1",
        bestBranch: `wf/${RUN_ID}/climb/best`,
        origin: { sha: "o0", artifact: `${ARTIFACTS}/o0/bin` },
        exports: { best: { head: "c1" } },
      });
      expect(run.intent("rm:climb/r1/ws")?._tag).toBe("RemoveWorkspace");
      expect(turnIntent(run, "r2/propose")).toBeNull();
    },
  },
  {
    name: "confirmWhen false skips the confirmation, so the bar is never read",
    patch: { confirmWhen: "m.bench.ratio >= 3", plateau: { rounds: 1 } },
    world: { unit: (c) => (c === "r1/m_bench" ? bench(2) : defaultUnit(c)) },
    check: (run) => {
      expect(argvOf(run, "r1/c_bench")).toBeNull();
      expect(resolution(run)).toMatchObject({ port: "no_gain" });
    },
  },
  {
    name: "ledgerBest ignores an entry only kept: the base falls back to params.from",
    ledger: foreign("k0", "s9"),
    world: { turn: () => undefined },
    check: (run) => {
      expect(run.intent("ws:climb/origin")).toMatchObject({
        baseRef: "feat/x",
        branch: `wf/${RUN_ID}/climb/best`,
      });
    },
  },
  {
    name: "ledgerBest names a validated entry as the base",
    ledger: [
      ...foreign("k0", "s9"),
      { _tag: "EntryValidated", key: "k0", runId: "other", at: "now" },
    ],
    world: { turn: () => undefined },
    check: (run) => {
      expect(run.intent("ws:climb/origin")).toMatchObject({ baseRef: "s9" });
    },
  },
  {
    name: "implementing opens a new write thread, never the proposal's read thread",
    world: { turn: (c) => (c === "r1/implement" ? undefined : defaultTurn(c)) },
    check: (run) => {
      const propose = turnIntent(run, "r1/propose");
      const implement = turnIntent(run, "r1/implement");
      expect(propose).toMatchObject({ mode: "new", access: "read" });
      expect(implement).toMatchObject({ mode: "new", access: "write" });
      expect(implement?.threadId).not.toBe(propose?.threadId);
      expect(implement?.workspace.name).toBe("climb/r1/ws");
      expect(run.intent("ws:climb/r1/ws")).toMatchObject({ baseRef: "o0", branch: null });
    },
  },
  {
    name: "an incomplete measurement fails its child and does not count for the plateau",
    patch: { plateau: { rounds: 1 } },
    world: {
      unit: (c) => (c === "r1/m_bench" ? bench(2, { complete: false }) : defaultUnit(c)),
    },
    check: (run) => {
      expect(resolution(run, "climb/r1/m_bench")?.status).toBe("failed");
      expect(entry(run, "k1")?.verdict).toBe("invalid");
      expect(run.intent("git:climb/r1/advance")).toBeUndefined();
      expect(entry(run, "k2")?.verdict).toBe("rejected");
      expect(resolution(run)).toMatchObject({ port: "no_gain" });
      expect(resolution(run)?.output).toMatchObject({ endedBy: "plateau", attempts: 2 });
    },
  },
  {
    name: "an origin that does not build ends blocked",
    world: { unit: (c) => (c === "origin/build" ? { exit: 2 } : defaultUnit(c)) },
    check: (run) => {
      expect(resolution(run)).toMatchObject({ port: "blocked" });
      expect(turnIntent(run, "r1/propose")).toBeNull();
    },
  },
  {
    name: "a generator exhausted twice ends no_gain",
    world: {
      turn: (c) => (/\/propose$/.test(c) ? { output: { exhausted: true } } : defaultTurn(c)),
    },
    check: (run) => {
      expect(resolution(run)?.output).toMatchObject({ endedBy: "exhausted", attempts: 0 });
      expect(turnIntent(run, "r3/propose")).toBeNull();
    },
  },
];

describe("hillclimb block", () => {
  it.each(cases)("$name", ({ patch, ledger = [], world, check }) => {
    check(play(seed(start(patch), ledger), world));
  });
});
