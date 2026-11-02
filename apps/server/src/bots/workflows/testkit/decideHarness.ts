/** Test harness for the pure deciders: compile a definition, build a run's facts, decide. */
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";
import type { Json } from "effect/Schema";

import type { WorkflowStepCost } from "@t3tools/contracts";
import {
  compileWorkflow,
  DEFAULT_HOST_LIMITS,
  type CompiledWorkflow,
} from "@t3tools/shared/workflows";

import { decide, nextDeadline } from "../decide.ts";
import type { Fact, NewFact, RunFact, StoredFact } from "../facts.ts";
import { foldRun } from "../fold.ts";
import type { RunState } from "../state.ts";

export const RUN_ID = "wfr_00000000000000000000";
export const T0 = Date.parse("2026-11-02T10:00:00.000Z");
export const iso = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

type Definition = Record<string, unknown>;

/** A valid one-node workflow; `patch` replaces top-level fields (nodes, edges, workspaces…). */
export const definition = (patch: Definition = {}): Definition => ({
  schema: "t3.workflow/v1",
  id: "demo",
  title: "Demo",
  home: { project: "t3code" },
  budget: { steps: 20, wall: "2h", tokens: 100_000 },
  fatigue: { consecutiveFailures: 2 },
  models: {
    lead: { provider: "claude", model: "claude-opus-5-5" },
    sol: { provider: "codex", model: "gpt-6.1-sol", effort: "low" },
  },
  workspaces: { integ: { project: "t3code", base: "friend/main", branch: "wf/demo" } },
  nodes: { only: { kind: "output", status: "no_change", value: {} } },
  edges: [],
  ...patch,
});

export const compile = (patch: Definition = {}): CompiledWorkflow => {
  const result = compileWorkflow(definition(patch), DEFAULT_HOST_LIMITS);
  if (Result.isFailure(result)) throw new Error(JSON.stringify(result.failure, null, 2));
  return result.success;
};

export const cost: WorkflowStepCost = {
  billable: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  usage: "complete",
  usdEstimate: null,
};

export const runStarted = (
  overrides: Partial<Extract<RunFact, { _tag: "RunStarted" }>> = {},
): RunFact => ({
  _tag: "RunStarted",
  workflowId: "demo",
  commit: "c1",
  hash: "h",
  title: "Demo",
  params: {},
  trigger: { kind: "manual", occurrence: "manual:1", label: "manual", payload: null },
  budget: { steps: 20, wallMs: 7_200_000, tokens: 100_000, usd: null },
  parent: null,
  causalDepth: 0,
  at: iso(T0),
  ...overrides,
});

export const turnSettled = (
  step: string,
  attempt: number,
  status: "completed" | "failed" | "cancelled" | "interrupted",
  output: Json = null,
  outputError: string | null = null,
): RunFact => ({
  _tag: "TurnSettled",
  step,
  attempt,
  status,
  text: "reply",
  output,
  outputError,
  cost,
  headSha: null,
});

export const unitExited = (
  step: string,
  attempt: number,
  exit: number | null,
  extra: Partial<Extract<RunFact, { _tag: "UnitExited" }>> = {},
): RunFact => ({
  _tag: "UnitExited",
  step,
  attempt,
  exit,
  signal: null,
  queuedMs: 0,
  out: null,
  tail: "",
  lost: false,
  started: true,
  ...extra,
});

/**
 * One run's journal in memory. `decide(now)` runs one pass; `drive(now)` also appends the pass's
 * run-stream facts, as the actor would, and returns what the pass emitted (every stream).
 */
export class TestRun {
  readonly facts: StoredFact[] = [];
  readonly compiled: CompiledWorkflow;
  readonly failureSubscribers: ReadonlyArray<{
    readonly workflowId: string;
    readonly triggerId: string;
  }>;
  constructor(
    compiled: CompiledWorkflow,
    failureSubscribers: ReadonlyArray<{
      readonly workflowId: string;
      readonly triggerId: string;
    }> = [],
  ) {
    this.compiled = compiled;
    this.failureSubscribers = failureSubscribers;
  }

  static start(compiled: CompiledWorkflow, started: RunFact = runStarted()): TestRun {
    const run = new TestRun(compiled);
    run.add("started", started);
    return run;
  }

  add(key: string, fact: Fact, at: number = T0): this {
    this.facts.push({
      stream: `run:${RUN_ID}`,
      seq: this.facts.length + 1,
      key,
      fact,
      at: iso(at),
    });
    return this;
  }

  state(): RunState {
    return foldRun(RUN_ID, this.facts);
  }

  decide(now: number = T0 + 1_000): ReadonlyArray<NewFact> {
    return decide(this.compiled, this.state(), {
      now,
      runDir: `/runs/${RUN_ID}`,
      failureSubscribers: this.failureSubscribers,
    });
  }

  drive(now: number = T0 + 1_000): ReadonlyArray<NewFact> {
    const out = this.decide(now);
    for (const f of out) if (f.stream === `run:${RUN_ID}`) this.add(f.key, f.fact, now);
    return out;
  }

  deadline(now: number = T0): number | null {
    return nextDeadline(this.compiled, this.state(), now);
  }

  /** The intent recorded under `key`, if any. */
  intent(key: string) {
    return this.state().intents.get(key)?.intent;
  }
}

/** The keys of a pass, `stream key` for facts outside the run's stream. */
export const keysOf = (out: ReadonlyArray<NewFact>): ReadonlyArray<string> =>
  out.map((f) => (f.stream === `run:${RUN_ID}` ? f.key : `${f.stream} ${f.key}`));
