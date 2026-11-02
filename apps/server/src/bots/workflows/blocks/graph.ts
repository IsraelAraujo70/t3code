/**
 * The graph block (§4.3): the lead commits a contract and plans leaves; each leaf runs in its own
 * worktree from the integrated sha, is checked against its `owns` and `accept`, and merges into
 * the integration worktree one at a time. A leaf that keeps failing is implemented by the lead.
 */
import * as Result from "effect/Result";
import type { Json } from "effect/Schema";

import {
  type WorkflowCommandSpec,
  type WorkflowModelRef,
  type WorkflowModelUse,
  type WorkflowOutputShape,
  WorkflowStepKey,
} from "@t3tools/contracts";
import { classifyCommand, type JsonValue } from "@t3tools/shared/workflows";

import { blockScope } from "./reader.ts";
import type {
  BlockDecider,
  BlockIO,
  BlockNode,
  BlockReader,
  BlockWorkspace,
  TurnObservation,
  UnitObservation,
} from "./types.ts";

export type GraphLeaf = {
  readonly id: string;
  readonly goal: string;
  readonly owns: ReadonlyArray<string>;
  readonly deps: ReadonlyArray<string>;
  readonly accept: ReadonlyArray<string>;
  /** A `$name` of the definition's models; absent runs the node's `leaf`. */
  readonly model?: string;
};
export type GraphPlan = { readonly leaves: ReadonlyArray<GraphLeaf> };

const LEAF_ID = /^[a-z][a-z0-9_]{0,40}$/;
const MODEL_NAME = /^\$[a-z_]+$/;
const PLAN_TURNS = 3;
const SCOPE_TIMEOUT_MS = 600_000;
const SPEC_TIMEOUT_MS = 6 * 3_600_000;
const DURATION_UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000 } as const;
const durationMs = (text: string): number =>
  Number(text.slice(0, -1)) * DURATION_UNIT_MS[text.slice(-1) as keyof typeof DURATION_UNIT_MS];

const PLAN_OUTPUT: WorkflowOutputShape = { leaves: { type: "json" } };
const LEAF_OUTPUT: WorkflowOutputShape = { blocked: { type: "string", optional: true } };

const isRecord = (value: unknown): value is { readonly [key: string]: unknown } =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isStrings = (value: unknown): value is ReadonlyArray<string> =>
  Array.isArray(value) && value.every((v: unknown) => typeof v === "string");

/** The literal directory a glob is confined to: `apps/server/**` → `apps/server/`, `a.ts` → `a.ts`. */
const globRoot = (glob: string): string => {
  const wild = glob.search(/[*?[{]/);
  return wild < 0 ? glob : glob.slice(0, glob.lastIndexOf("/", wild) + 1);
};
const within = (inner: string, outer: string) =>
  outer === "" || inner === outer || inner.startsWith(outer.endsWith("/") ? outer : `${outer}/`);
/** Approximate: two globs overlap when equal or when one's literal root contains the other's. */
const globsOverlap = (a: string, b: string): boolean => {
  if (a === b) return true;
  const ra = globRoot(a);
  const rb = globRoot(b);
  return within(ra, rb) || within(rb, ra);
};

/** Reads the leaves' shape; validation of the graph they form is `validateGraphPlan`'s. */
const parseLeaves = (plan: unknown, diagnostics: string[]): GraphLeaf[] => {
  if (!isRecord(plan) || !Array.isArray(plan.leaves)) {
    diagnostics.push("the plan must be an object with a `leaves` array");
    return [];
  }
  const leaves: GraphLeaf[] = [];
  plan.leaves.forEach((raw: unknown, index: number) => {
    const at = `leaves[${index}]`;
    if (!isRecord(raw)) return void diagnostics.push(`${at} must be an object`);
    const { id, goal, owns, deps = [], accept, model } = raw;
    const errors: string[] = [];
    if (typeof id !== "string" || !LEAF_ID.test(id))
      errors.push(`${at}.id must match ${LEAF_ID.source}`);
    if (typeof goal !== "string" || goal.trim() === "")
      errors.push(`${at}.goal must be a non-empty string`);
    if (!isStrings(owns) || owns.length === 0)
      errors.push(`${at}.owns must be a non-empty array of globs`);
    else
      for (const glob of owns)
        if (glob === "" || glob.startsWith("/") || glob.split("/").includes(".."))
          errors.push(`${at}.owns: "${glob}" must be a relative glob inside the repository`);
    if (!isStrings(deps)) errors.push(`${at}.deps must be an array of leaf ids`);
    if (!isStrings(accept) || accept.length === 0)
      errors.push(`${at}.accept must be a non-empty argv`);
    if (model !== undefined && (typeof model !== "string" || !MODEL_NAME.test(model)))
      errors.push(`${at}.model must be a $name of the workflow's models`);
    diagnostics.push(...errors);
    if (
      errors.length === 0 &&
      typeof id === "string" &&
      typeof goal === "string" &&
      isStrings(owns) &&
      isStrings(deps) &&
      isStrings(accept)
    )
      leaves.push({
        id,
        goal,
        owns,
        deps,
        accept,
        ...(typeof model === "string" ? { model } : {}),
      });
  });
  return leaves;
};

/** Ancestors of every leaf, or null when the deps form a cycle. */
const ancestorsOf = (
  leaves: ReadonlyArray<GraphLeaf>,
): ReadonlyMap<string, ReadonlySet<string>> | null => {
  const byId = new Map(leaves.map((l) => [l.id, l]));
  const done = new Map<string, ReadonlySet<string>>();
  const visiting = new Set<string>();
  const visit = (id: string): boolean => {
    if (done.has(id)) return true;
    if (visiting.has(id)) return false;
    visiting.add(id);
    const all = new Set<string>();
    for (const dep of byId.get(id)?.deps ?? []) {
      if (!visit(dep)) return false;
      all.add(dep);
      for (const a of done.get(dep) ?? []) all.add(a);
    }
    visiting.delete(id);
    done.set(id, all);
    return true;
  };
  for (const leaf of leaves) if (!visit(leaf.id)) return null;
  return done;
};

/**
 * Checks a lead's plan: leaf ids `^[a-z][a-z0-9_]{0,40}$` and unique, deps that exist and form no
 * cycle, at most `maxLeaves`, disjoint `owns` between leaves that can run together (neither is an
 * ancestor of the other), an `accept` argv `classifyCommand` allows, and models that resolve.
 */
export const validateGraphPlan = (
  plan: unknown,
  node: Pick<BlockNode<"graph">, "maxLeaves">,
  resolveModel: (use: WorkflowModelUse) => Result.Result<WorkflowModelRef, string>,
):
  | { readonly ok: true; readonly plan: GraphPlan }
  | { readonly ok: false; readonly diagnostics: string[] } => {
  const diagnostics: string[] = [];
  const leaves = parseLeaves(plan, diagnostics);
  if (diagnostics.length === 0 && leaves.length === 0) diagnostics.push("the plan has no leaves");
  if (leaves.length > node.maxLeaves)
    diagnostics.push(`the plan has ${leaves.length} leaves; at most ${node.maxLeaves} are allowed`);
  const ids = new Set<string>();
  for (const leaf of leaves) {
    if (ids.has(leaf.id)) diagnostics.push(`leaf id "${leaf.id}" is used twice`);
    ids.add(leaf.id);
  }
  for (const leaf of leaves) {
    for (const dep of leaf.deps)
      if (!ids.has(dep) || dep === leaf.id)
        diagnostics.push(`leaf ${leaf.id} depends on "${dep}", which is not another leaf`);
    const command = classifyCommand(leaf.accept);
    if (command.kind !== "allowed")
      diagnostics.push(`leaf ${leaf.id}: accept is ${command.kind} (${command.reason})`);
    if (leaf.model !== undefined) {
      const model = resolveModel(leaf.model);
      if (Result.isFailure(model)) diagnostics.push(`leaf ${leaf.id}: ${model.failure}`);
    }
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };
  const ancestors = ancestorsOf(leaves);
  if (ancestors === null) return { ok: false, diagnostics: ["the leaves' deps form a cycle"] };
  leaves.forEach((a, i) => {
    for (const b of leaves.slice(i + 1)) {
      if (ancestors.get(a.id)?.has(b.id) || ancestors.get(b.id)?.has(a.id)) continue;
      for (const ga of a.owns)
        for (const gb of b.owns)
          if (globsOverlap(ga, gb))
            diagnostics.push(
              `leaves ${a.id} and ${b.id} can run together but both own "${ga}" and "${gb}"`,
            );
    }
  });
  return diagnostics.length > 0 ? { ok: false, diagnostics } : { ok: true, plan: { leaves } };
};

const planJson = (plan: GraphPlan): Json => ({
  leaves: plan.leaves.map((leaf) => {
    const json: { [key: string]: Json } = {
      id: leaf.id,
      goal: leaf.goal,
      owns: [...leaf.owns],
      deps: [...leaf.deps],
      accept: [...leaf.accept],
    };
    if (leaf.model !== undefined) json.model = leaf.model;
    return json;
  }),
});

const shaOf = (event: Json): string | null =>
  isRecord(event) && typeof event.sha === "string" ? event.sha : null;

const runChild = (id: string, round: number) =>
  round === 1 ? `leaf/${id}/run` : `leaf/${id}/run_${round}`;
const planChild = (n: number) => (n === 1 ? "lead/plan" : `lead/plan_${n}`);

type LeafStatus = ReturnType<BlockReader["childStatus"]>;

interface LeafView {
  readonly leaf: GraphLeaf;
  readonly status: LeafStatus;
  readonly rework: number;
  /** The integrated sha once merged; null before. */
  readonly sha: string | null;
}

interface State {
  readonly step: string;
  /** The children's scope: `<step>` or `<step>/a<n>`. */
  readonly scope: string;
  readonly contractSha: string | null;
  readonly plan: GraphPlan | null;
  /** Integrated leaves in merge order, with the sha each one left the integration at. */
  readonly integrated: ReadonlyMap<string, string>;
  /** The integration's sha: the last integrated leaf's, else the contract's. */
  readonly integratedSha: string | null;
  readonly leaves: ReadonlyArray<LeafView>;
}

const derive = (_node: BlockNode<"graph">, reader: BlockReader): State => {
  let contractSha: string | null = null;
  let plan: GraphPlan | null = null;
  const integrated = new Map<string, string>();
  for (const entry of reader.events) {
    if (entry.id === "contract") contractSha = shaOf(entry.event);
    else if (entry.id === "plan") plan = { leaves: parseLeaves(entry.event, []) };
    else if (entry.id.startsWith("leaf_")) {
      const sha = shaOf(entry.event);
      if (sha !== null) integrated.set(entry.id.slice("leaf_".length), sha);
    }
  }
  const leaves = (plan?.leaves ?? []).map((leaf): LeafView => {
    let rounds = 0;
    while (reader.turnOf(runChild(leaf.id, rounds + 1))._tag !== "Absent") rounds++;
    const byLead = reader.turnOf(`lead/leaf_${leaf.id}`)._tag !== "Absent";
    return {
      leaf,
      status: byLead
        ? reader.childStatus(`lead/leaf_${leaf.id}`)
        : rounds === 0
          ? "pending"
          : reader.childStatus(runChild(leaf.id, rounds)),
      rework: Math.max(0, rounds - 1),
      sha: integrated.get(leaf.id) ?? null,
    };
  });
  return {
    step: reader.step,
    scope: blockScope(reader.step, reader.attempt),
    contractSha,
    plan,
    integrated,
    integratedSha: [...integrated.values()].at(-1) ?? contractSha,
    leaves,
  };
};

const contractPrompt = (goal: string) =>
  `You lead a change that parallel workers will implement. Goal:\n${goal}\n\n` +
  "First write only the shared types and contracts the work needs in this worktree, then commit " +
  "them. Workers build on that commit and never change it.";

const planPrompt = (node: BlockNode<"graph">) =>
  `Now split the implementation into at most ${node.maxLeaves} leaves for workers, at most ` +
  `${node.maxParallel} at a time, each in its own worktree from the integrated commit. For each ` +
  "leaf give `id` (lowercase, `^[a-z][a-z0-9_]{0,40}$`), `goal`, `owns` (globs of the only files " +
  "it may change; leaves that can run together must not overlap), `deps` (ids of the leaves it " +
  "builds on), `accept` (argv of a command, no shell, that exits 0 when the leaf is done) and " +
  "optionally `model` (a `$name` of the workflow's models).";

const replanPrompt = (diagnostics: ReadonlyArray<string>) =>
  `The plan is invalid:\n${diagnostics.map((d) => `- ${d}`).join("\n")}\n\nSend a corrected plan.`;

const leafPrompt = (leaf: GraphLeaf, contractSha: string) =>
  `Implement leaf ${leaf.id} of a larger change in this worktree.\n\nGoal:\n${leaf.goal}\n\n` +
  `Change only files matching: ${leaf.owns.join(", ")}.\n` +
  `It is done when this command exits 0: ${leaf.accept.join(" ")}\n` +
  `Commit your work. Never change the contract of commit ${contractSha}; if the leaf cannot be ` +
  'done without changing it, stop and answer {"blocked": "contract"}.';

const reworkPrompt = (reason: string) =>
  `Your leaf was rejected: ${reason}\n\nFix it in this worktree and commit.`;

const leadLeafPrompt = (leaf: GraphLeaf, reason: string) =>
  `Leaf ${leaf.id} could not be integrated (${reason}). Implement it yourself here in the ` +
  `integration worktree and commit.\n\nGoal:\n${leaf.goal}\n\n` +
  `It is done when this command exits 0: ${leaf.accept.join(" ")}`;

const leadMergePrompt = (leaf: GraphLeaf, sha: string, error: string) =>
  `Merging leaf ${leaf.id} into the integration worktree failed (${error}). Merge ${sha} here, ` +
  "resolve the conflicts and commit.";

type Busy = { readonly _tag: "Busy" };
const BUSY: Busy = { _tag: "Busy" };

/** Where a started leaf stands, read again from its children each pass. */
type LeafOutcome =
  | Busy
  | { readonly _tag: "Accepted"; readonly round: number; readonly head: string }
  | { readonly _tag: "ToLead"; readonly reason: string };

const turnFailure = (turn: Extract<TurnObservation, { _tag: "Settled" }>) =>
  turn.error ?? `the turn ended ${turn.status}`;

const checkRound = (
  leaf: GraphLeaf,
  ws: BlockWorkspace,
  round: number,
  turn: TurnObservation,
  io: BlockIO,
): LeafOutcome | { readonly _tag: "Rejected"; readonly reason: string } => {
  const rejected = (reason: string) => ({ _tag: "Rejected", reason }) as const;
  if (turn._tag === "Failed") return rejected(turn.error);
  if (turn._tag !== "Settled") return BUSY;
  if (!turn.ok) return rejected(turnFailure(turn));
  if (isRecord(turn.output) && turn.output.blocked === "contract")
    return { _tag: "ToLead", reason: "the leaf needs a change to the contract" };
  if (turn.headSha === null) return rejected("the engine read no HEAD after the turn");
  const head = turn.headSha;
  const scope = io.unit(`leaf/${leaf.id}/scope${round}`, {
    argv: [
      "git",
      "diff",
      "--name-only",
      ws.headSha,
      head,
      "--",
      ".",
      ...leaf.owns.map((glob) => `:(exclude,glob)${glob}`),
    ],
    cwd: ws,
    heavy: false,
    replay: "safe",
    timeoutMs: SCOPE_TIMEOUT_MS,
  });
  if (scope._tag === "Failed") return rejected(`the scope check failed: ${scope.error}`);
  if (scope._tag !== "Exited") return BUSY;
  if (!scope.ok) return rejected(`the scope check failed: ${scope.tail}`);
  if (scope.tail.trim() !== "")
    return rejected(
      `out-of-scope: it changed files outside ${leaf.owns.join(", ")}:\n${scope.tail.trim()}`,
    );
  const accept = io.unit(`leaf/${leaf.id}/accept${round}`, {
    argv: leaf.accept,
    cwd: ws,
    heavy: true,
    replay: "safe",
    timeoutMs: SPEC_TIMEOUT_MS,
  });
  if (accept._tag === "Failed") return rejected(`accept failed: ${accept.error}`);
  if (accept._tag !== "Exited") return BUSY;
  if (!accept.ok) return rejected(`accept failed (exit ${accept.exit}): ${accept.tail}`);
  return { _tag: "Accepted", round, head };
};

/** Runs the leaf's rounds: a rejected round goes back to its thread until `reworkCap`, then to the lead. */
const walkLeaf = (
  node: BlockNode<"graph">,
  leaf: GraphLeaf,
  ws: BlockWorkspace,
  model: WorkflowModelRef,
  contractSha: string,
  io: BlockIO,
): LeafOutcome => {
  let reason = "";
  for (let round = 1; round <= node.reworkCap + 1; round++) {
    const turn = io.turn(runChild(leaf.id, round), {
      model,
      prompt: round === 1 ? leafPrompt(leaf, contractSha) : reworkPrompt(reason),
      workspace: ws,
      access: "write",
      output: LEAF_OUTPUT,
      ...(round === 1 ? {} : { continues: runChild(leaf.id, 1) }),
    });
    const checked = checkRound(leaf, ws, round, turn, io);
    if (checked._tag !== "Rejected") return checked;
    reason = checked.reason;
  }
  return { _tag: "ToLead", reason };
};

type Invalid = { readonly _tag: "Invalid"; readonly error: string };

/** One of the node's command specs as a child unit, in the integration or a read-only copy of `sha`. */
const specUnit = (
  io: BlockIO,
  child: string,
  spec: WorkflowCommandSpec,
  integ: BlockWorkspace,
  sha: string,
): UnitObservation | Invalid => {
  const invalid = (error: string): Invalid => ({ _tag: "Invalid", error });
  let cwd = integ;
  if (typeof spec.cwd === "string") {
    if (!spec.cwd.endsWith(".integration"))
      return invalid(
        `a graph check runs in <node>.integration or a read-only project, not in ${spec.cwd}`,
      );
  } else {
    const project = io.render(spec.cwd.project);
    if (Result.isFailure(project)) return invalid(project.failure);
    const ro = io.workspace(`${child}_ro`, {
      project: project.success,
      baseRef: sha,
      branch: null,
    });
    if (ro._tag !== "Ready") return ro;
    cwd = ro.workspace;
  }
  const roots = { step: { dir: io.stepDir(child) } };
  const argv: string[] = [];
  for (const arg of spec.argv) {
    const rendered = io.render(arg, roots);
    if (Result.isFailure(rendered)) return invalid(rendered.failure);
    argv.push(rendered.success);
  }
  const env: { [name: string]: string } = {};
  for (const [name, template] of Object.entries(spec.env ?? {})) {
    const rendered = io.render(template, roots);
    if (Result.isFailure(rendered)) return invalid(rendered.failure);
    env[name] = rendered.success;
  }
  const unit = io.unit(child, {
    argv,
    cwd,
    heavy: spec.heavy === true,
    replay: spec.replay ?? "never",
    timeoutMs: spec.timeout === undefined ? SPEC_TIMEOUT_MS : durationMs(spec.timeout),
    env,
    parse: spec.parse ?? "none",
    ...(spec.tokensFrom === undefined
      ? {}
      : { tokensFrom: spec.tokensFrom, reservation: spec.tokenReservation ?? 0 }),
  });
  // Unparsable output fails before any check, as for a command node.
  if (
    unit._tag !== "Exited" ||
    spec.check === undefined ||
    unit.lost ||
    unit.signal !== null ||
    unit.parseError !== null
  )
    return unit;
  const check = io.evaluate(spec.check, { exit: unit.exit, out: unit.out as JsonValue });
  if (Result.isFailure(check)) return { ...unit, ok: false, tail: check.failure };
  return { ...unit, ok: check.success === true };
};

const decide = (node: BlockNode<"graph">, state: State, io: BlockIO): void => {
  const fail = (error: string) => io.finish("fail", {}, { error });
  const project = io.render(node.workspace.project);
  if (Result.isFailure(project)) return fail(project.failure);
  const base = io.render(node.workspace.base);
  if (Result.isFailure(base)) return fail(base.failure);
  const lead = io.model(node.lead);
  if (Result.isFailure(lead)) return fail(lead.failure);
  const integObs = io.workspace("integ", {
    project: project.success,
    baseRef: base.success,
    branch: `wf/${io.runId}/${state.scope.replace(/[[\]]/g, "_")}/integration`,
  });
  if (integObs._tag === "Failed") return fail(integObs.error);
  if (integObs._tag !== "Ready") return;
  const integ = integObs.workspace;
  const leadTurn = (child: string, prompt: string) =>
    io.turn(child, {
      model: lead.success,
      prompt,
      workspace: integ,
      access: "write",
      continues: "lead/contract",
    });

  if (state.contractSha === null) {
    const goal = io.render(node.goal);
    if (Result.isFailure(goal)) return fail(goal.failure);
    const turn = io.turn("lead/contract", {
      model: lead.success,
      prompt: contractPrompt(goal.success),
      workspace: integ,
      access: "write",
    });
    if (turn._tag === "Failed") return fail(turn.error);
    if (turn._tag !== "Settled") return;
    if (!turn.ok) return fail(turnFailure(turn));
    const sha = turn.headSha ?? integ.headSha;
    const check = node.finalChecks[0];
    if (check !== undefined) {
      const unit = specUnit(io, "contract/check", check, integ, sha);
      if (unit._tag === "Invalid") return fail(unit.error);
      if (unit._tag === "Failed")
        return io.finish("blocked", { contractSha: sha }, { error: unit.error });
      if (unit._tag !== "Exited") return;
      if (!unit.ok)
        return io.finish(
          "blocked",
          { contractSha: sha },
          { error: `the contract check failed: ${unit.tail}` },
        );
    }
    return io.event("contract", { sha });
  }
  const contractSha = state.contractSha;

  if (state.plan === null) {
    let diagnostics: ReadonlyArray<string> = [];
    for (let n = 1; n <= PLAN_TURNS; n++) {
      const turn = io.turn(planChild(n), {
        model: lead.success,
        prompt: n === 1 ? planPrompt(node) : replanPrompt(diagnostics),
        workspace: integ,
        access: "write",
        continues: "lead/contract",
        output: PLAN_OUTPUT,
      });
      if (turn._tag === "Waiting" || turn._tag === "Absent") return;
      const checked =
        turn._tag === "Failed"
          ? { ok: false as const, diagnostics: [turn.error] }
          : turn.ok
            ? validateGraphPlan(turn.output, node, io.model)
            : { ok: false as const, diagnostics: [turnFailure(turn)] };
      if (checked.ok) return io.event("plan", planJson(checked.plan));
      diagnostics = checked.diagnostics;
    }
    return io.finish(
      "blocked",
      { contractSha },
      { error: `the plan is still invalid:\n${diagnostics.join("\n")}` },
    );
  }

  const integratedSha = state.integratedSha ?? contractSha;
  const outcomes = new Map<string, LeafOutcome>();
  let live = state.leaves.filter(
    (l) =>
      !state.integrated.has(l.leaf.id) && io.workspaceOf(`leaf/${l.leaf.id}/ws1`)._tag !== "Absent",
  ).length;
  for (const { leaf } of state.leaves) {
    if (state.integrated.has(leaf.id)) continue;
    const wsChild = `leaf/${leaf.id}/ws1`;
    const started = io.workspaceOf(wsChild)._tag !== "Absent";
    if (!started) {
      if (live >= node.maxParallel || !leaf.deps.every((d) => state.integrated.has(d))) continue;
      live++;
    }
    const ws = io.workspace(wsChild, {
      project: project.success,
      baseRef: integratedSha,
      branch: null,
    });
    if (ws._tag === "Failed") {
      outcomes.set(leaf.id, { _tag: "ToLead", reason: `its worktree failed: ${ws.error}` });
      continue;
    }
    if (ws._tag !== "Ready") continue;
    const model = io.model(leaf.model ?? node.leaf);
    if (Result.isFailure(model)) return fail(model.failure);
    outcomes.set(leaf.id, walkLeaf(node, leaf, ws.workspace, model.success, contractSha, io));
  }

  // One integration at a time: each merge expects the HEAD the previous one left.
  const pending = state.leaves.flatMap(({ leaf }) => {
    const outcome = outcomes.get(leaf.id);
    return outcome === undefined || outcome._tag === "Busy" ? [] : [{ leaf, outcome }];
  });
  const begun = ({ leaf, outcome }: (typeof pending)[number]) =>
    outcome._tag === "Accepted"
      ? io.gitOf(`leaf/${leaf.id}/merge${outcome.round}`)._tag !== "Absent"
      : io.turnOf(`lead/leaf_${leaf.id}`)._tag !== "Absent";
  const next = pending.find(begun) ?? pending[0];
  if (next !== undefined) {
    const { leaf, outcome } = next;
    const integrate = (turn: TurnObservation): void => {
      if (turn._tag === "Failed")
        return fail(`the lead could not integrate ${leaf.id}: ${turn.error}`);
      if (turn._tag !== "Settled") return;
      if (!turn.ok || turn.headSha === null)
        return fail(`the lead could not integrate ${leaf.id}: ${turnFailure(turn)}`);
      io.event(`leaf_${leaf.id}`, { sha: turn.headSha });
    };
    if (outcome._tag === "ToLead")
      return integrate(leadTurn(`lead/leaf_${leaf.id}`, leadLeafPrompt(leaf, outcome.reason)));
    const merge = io.mergeLocal(`leaf/${leaf.id}/merge${outcome.round}`, {
      workspace: integ,
      from: outcome.head,
      expectHead: integratedSha,
    });
    if (merge._tag === "Done") return io.event(`leaf_${leaf.id}`, { sha: merge.sha });
    if (merge._tag === "Failed")
      return integrate(
        leadTurn(`lead/merge_${leaf.id}`, leadMergePrompt(leaf, outcome.head, merge.error)),
      );
    return;
  }
  if (state.integrated.size < state.leaves.length) return;

  let waiting = false;
  for (const [i, spec] of node.finalChecks.entries()) {
    const unit = specUnit(io, `final/check${i}`, spec, integ, integratedSha);
    if (unit._tag === "Invalid") return fail(unit.error);
    if (unit._tag === "Failed") return fail(`final check ${i} failed: ${unit.error}`);
    if (unit._tag !== "Exited") waiting = true;
    else if (!unit.ok) return fail(`final check ${i} failed (exit ${unit.exit}): ${unit.tail}`);
  }
  if (waiting) return;
  for (const { leaf } of state.leaves) {
    const ws = io.workspaceOf(`leaf/${leaf.id}/ws1`);
    if (ws._tag === "Ready") io.remove(ws.workspace);
  }
  io.finish(
    "ok",
    {
      sha: integratedSha,
      leaves: [...state.integrated].map(([id, sha]) => ({ id, sha })),
    },
    { exports: { integration: { workspace: integ, head: integratedSha } } },
  );
};

export const graph: BlockDecider<"graph", State> = {
  derive,
  decide,
  view: (_node, state) => ({
    _tag: "graph",
    step: WorkflowStepKey.make(state.step),
    leaves: state.leaves.map((l) => ({
      id: l.leaf.id,
      status: l.status,
      owns: [...l.leaf.owns],
      deps: [...l.leaf.deps],
      rework: l.rework,
      sha: l.sha,
    })),
  }),
};
