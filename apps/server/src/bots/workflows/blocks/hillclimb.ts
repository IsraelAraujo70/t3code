/**
 * The hillclimb block (§4.1). The origin is built and measured once; then each round proposes one
 * mechanism, pre-registers its key in the ledger, implements it in a fresh worktree off the best,
 * builds, measures and judges it. Every verdict is pinned as a block event (`origin`, `r<n>`,
 * `r<n>/dup`, `r<n>/confirm`, `end`), and the sub-state is folded back from those events alone.
 */
import * as Result from "effect/Result";
import type { Json, JsonObject } from "effect/Schema";

import {
  type WorkflowCommandSpec,
  type WorkflowModelRef,
  type WorkflowOutputShape,
  WorkflowStepKey,
  type WorkflowWorkspaceUse,
} from "@t3tools/contracts";
import { isTruthy, type JsonValue } from "@t3tools/shared/workflows";

import { ledgerDigest } from "./ledger.ts";
import { blockScope } from "./reader.ts";
import type {
  BlockDecider,
  BlockIO,
  BlockNode,
  BlockWorkspace,
  UnitObservation,
  UnitRequest,
} from "./types.ts";

type Node = BlockNode<"hillclimb">;
type Roots = { readonly [root: string]: JsonValue };

interface Reading {
  readonly objective: number;
  readonly values: { readonly [name: string]: JsonValue };
}
/** A measured commit: the origin, the best so far, or a candidate. */
interface Point {
  readonly sha: string;
  readonly artifact: string | null;
  readonly reading: Reading;
}
type Verdict = "kept" | "rejected" | "invalid" | "duplicate" | "exhausted";
type EndedBy = "target" | "plateau" | "exhausted" | "iterations" | "wall" | "tokens";
interface End {
  readonly port: "target" | "no_gain" | "budget";
  readonly endedBy: EndedBy;
}

interface State {
  readonly step: string;
  /** `<step>`, or `<step>/a<n>` for a retried block: its branches never collide with attempt 1's. */
  readonly scope: string;
  readonly runId: string;
  readonly origin: Point | null;
  readonly best: Point | null;
  /** Rounds with a final verdict (a kept round waiting for its confirmation is not one yet). */
  readonly closed: number;
  /** The round in progress. */
  readonly round: number;
  /** 2 once the round's first proposal turned out a duplicate. */
  readonly slot: 1 | 2;
  /** The round's kept point, while its confirmation against the origin runs. */
  readonly confirming: Point | null;
  readonly roundsWithoutGain: number;
  readonly exhausted: number;
  /** Implemented proposals that reached a verdict: kept, rejected or invalid. */
  readonly attempts: number;
  readonly end: End | null;
}

const HAIKU: WorkflowModelRef = { provider: "claude", model: "claude-haiku-5-5" };
const DEFAULT_TIMEOUT_MS = 6 * 3_600_000;
const COPY_TIMEOUT_MS = 10 * 60_000;
const DEDUPE_TIMEOUT_MS = 10 * 60_000;
const DEDUPE_RESERVATION = 50_000;
const DURATION_UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000 } as const;
const MAX_KEY_LENGTH = 120;

const PROPOSAL_SHAPE: WorkflowOutputShape = {
  key: { type: "string", optional: true },
  mechanism: { type: "string", optional: true },
  rationale: { type: "string", optional: true },
  exhausted: { type: "boolean", optional: true },
};
const REPEAT_SHAPE: WorkflowOutputShape = {
  repeat: { type: "boolean" },
  reason: { type: "string" },
};
const PROPOSE_INSTRUCTION =
  "\n\nPropose exactly ONE mechanism that has not been tried. Do not edit any file. Answer with " +
  "`key` (a short stable slug naming the mechanism), `mechanism` (what to change) and `rationale` " +
  '(why it should beat the current best). With no new idea left, answer `{ "exhausted": true }`.';

const durationMs = (text: string): number => {
  const unit = text.slice(-1);
  const scale = unit === "s" || unit === "m" || unit === "h" ? DURATION_UNIT_MS[unit] : 0;
  return Number(text.slice(0, -1)) * scale;
};
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9_]/g, "_");
/** FNV-1a (32 bit) of the bar, so a registration records which `keep`/`target` it ran under. */
const fnv1a = (text: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
};
const bestBranch = (runId: string, step: string) =>
  `wf/${runId}/${step.replace(/[[\]]/g, "_")}/best`;

// ── Json decoding of the pinned events and of model output ────────────────────────────────────

const isJsonObject = (value: Json | undefined): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const asRecord = (value: Json | undefined): JsonObject | null =>
  isJsonObject(value) ? value : null;
const asString = (value: Json | undefined): string | null =>
  typeof value === "string" ? value : null;
const asNumber = (value: JsonValue | undefined): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const readingJson = (reading: Reading): Json => ({
  objective: reading.objective,
  values: reading.values,
});
const pointJson = (point: Point): Json => ({
  sha: point.sha,
  artifact: point.artifact,
  reading: readingJson(point.reading),
});
const decodeReading = (value: Json | undefined): Reading | null => {
  const record = asRecord(value);
  const objective = asNumber(record?.objective);
  const values = asRecord(record?.values);
  return objective === null || values === null ? null : { objective, values };
};
const decodePoint = (value: Json | undefined): Point | null => {
  const record = asRecord(value);
  const sha = asString(record?.sha);
  const reading = decodeReading(record?.reading);
  if (record === null || sha === null || reading === null) return null;
  return { sha, artifact: asString(record.artifact), reading };
};

const VERDICTS: ReadonlyArray<Verdict> = ["kept", "rejected", "invalid", "duplicate", "exhausted"];
const PORTS: ReadonlyArray<End["port"]> = ["target", "no_gain", "budget"];
const ENDED_BY: ReadonlyArray<EndedBy> = [
  "target",
  "plateau",
  "exhausted",
  "iterations",
  "wall",
  "tokens",
];
const oneOf = <T extends string>(options: ReadonlyArray<T>, value: Json | undefined): T | null =>
  options.find((option) => option === value) ?? null;

interface Proposal {
  readonly key: string;
  readonly mechanism: string;
  readonly rationale: string;
}
const decodeProposal = (output: Json): Proposal | "exhausted" | null => {
  const record = asRecord(output);
  if (record?.exhausted === true) return "exhausted";
  const key = asString(record?.key)?.trim() ?? "";
  if (key.length === 0 || key.length > MAX_KEY_LENGTH) return null;
  return {
    key,
    mechanism: asString(record?.mechanism) ?? "",
    rationale: asString(record?.rationale) ?? "",
  };
};

// ── Derive ────────────────────────────────────────────────────────────────────────────────────

const ROUND = /^r(\d+)$/;
const DUP = /^r(\d+)\/dup$/;
const CONFIRM = /^r(\d+)\/confirm$/;

const derive: BlockDecider<"hillclimb", State>["derive"] = (_node, reader) => {
  let origin: Point | null = null;
  let best: Point | null = null;
  let closed = 0;
  let confirming: { readonly n: number; readonly point: Point } | null = null;
  let roundsWithoutGain = 0;
  let exhausted = 0;
  let attempts = 0;
  let end: End | null = null;
  const duplicated = new Set<number>();
  for (const { id, event } of reader.events) {
    const record = asRecord(event);
    if (id === "origin") {
      origin = decodePoint(event);
      best = origin;
    } else if (id === "end") {
      const port = oneOf(PORTS, record?.port);
      const endedBy = oneOf(ENDED_BY, record?.endedBy);
      if (port !== null && endedBy !== null) end = { port, endedBy };
    } else if (DUP.test(id)) {
      duplicated.add(Number(DUP.exec(id)?.[1]));
    } else if (CONFIRM.test(id)) {
      if (confirming !== null && confirming.n === Number(CONFIRM.exec(id)?.[1])) {
        closed = confirming.n;
        confirming = null;
      }
    } else if (ROUND.test(id)) {
      const n = Number(ROUND.exec(id)?.[1]);
      const verdict = oneOf(VERDICTS, record?.verdict);
      if (verdict === "kept") {
        const point = decodePoint(record?.point);
        if (point !== null) best = point;
        roundsWithoutGain = 0;
        if (record?.confirm === true && point !== null) confirming = { n, point };
        else closed = n;
      } else {
        if (verdict === "rejected") roundsWithoutGain += 1;
        if (verdict === "exhausted") exhausted += 1;
        closed = n;
      }
      if (verdict === "kept" || verdict === "rejected" || verdict === "invalid") attempts += 1;
    }
  }
  const round = confirming?.n ?? closed + 1;
  return {
    step: reader.step,
    scope: blockScope(reader.step, reader.attempt),
    runId: reader.runId,
    origin,
    best,
    closed,
    round,
    slot: duplicated.has(round) ? 2 : 1,
    confirming: confirming?.point ?? null,
    roundsWithoutGain,
    exhausted,
    attempts,
    end,
  };
};

// ── Children ──────────────────────────────────────────────────────────────────────────────────

/** A pass that cannot go on: still waiting, or it already finished the block. */
type Halt = "wait" | "finished";
const isHalt = (value: unknown): value is Halt => value === "wait" || value === "finished";

const failBlock = (io: BlockIO, error: string): "finished" => {
  io.finish("fail", {}, { error });
  return "finished";
};

const rendered = (io: BlockIO, template: string, roots?: Roots): string | "finished" => {
  const result = io.render(template, roots);
  return Result.isFailure(result) ? failBlock(io, result.failure) : result.success;
};

const projectOf = (io: BlockIO, node: Node) => rendered(io, node.workspace.project);

/** A detached read-only worktree at the project's pinned HEAD, prepared once per child id. */
const readOnlyWorkspace = (
  io: BlockIO,
  child: string,
  project: string,
): BlockWorkspace | Halt | { readonly failed: string } => {
  const ws = io.workspace(child, { project, baseRef: "HEAD", branch: null });
  if (ws._tag === "Ready") return ws.workspace;
  return ws._tag === "Failed" ? { failed: ws.error } : "wait";
};

const cwdOf = (
  io: BlockIO,
  use: WorkflowWorkspaceUse,
  attempt: BlockWorkspace,
): BlockWorkspace | Halt | { readonly failed: string } => {
  if (use === "attempt") return attempt;
  if (typeof use === "string")
    return failBlock(io, `workspace "${use}" inside a hillclimb spec is not supported`);
  const project = rendered(io, use.project);
  if (project === "finished") return project;
  return readOnlyWorkspace(io, `ro/${slug(project)}`, project);
};

const unitRequest = (
  io: BlockIO,
  spec: WorkflowCommandSpec,
  cwd: BlockWorkspace,
  roots: Roots,
  defaults: { readonly parse: "none" | "json"; readonly replay: "safe" | "never" },
): UnitRequest | "finished" => {
  const argv: string[] = [];
  for (const arg of spec.argv) {
    const text = rendered(io, arg, roots);
    if (text === "finished") return text;
    argv.push(text);
  }
  const env: { [name: string]: string } = {};
  for (const [name, template] of Object.entries(spec.env ?? {})) {
    const text = rendered(io, template, roots);
    if (text === "finished") return text;
    env[name] = text;
  }
  return {
    argv,
    cwd,
    heavy: spec.heavy ?? false,
    replay: spec.replay ?? defaults.replay,
    timeoutMs: spec.timeout === undefined ? DEFAULT_TIMEOUT_MS : durationMs(spec.timeout),
    env,
    parse: spec.parse ?? defaults.parse,
    ...(spec.tokensFrom === undefined ? {} : { tokensFrom: spec.tokensFrom }),
    ...(spec.tokenReservation === undefined ? {} : { reservation: spec.tokenReservation }),
  };
};

const exitedOk = (seen: UnitObservation) => seen._tag === "Exited" && seen.ok;

/** Builds in `ws` and copies the artifact under the run, so measuring outlives the worktree. */
const buildArtifact = (
  io: BlockIO,
  node: Node,
  prefix: string,
  suffix: string,
  ws: BlockWorkspace,
  sha: string,
): { readonly artifact: string | null } | { readonly failed: string } | Halt => {
  const build = node.build;
  if (build === undefined) return { artifact: null };
  const cwd = cwdOf(io, build.cwd, ws);
  if (isHalt(cwd) || "failed" in cwd) return cwd;
  const buildChild = `${prefix}/build${suffix}`;
  const request = unitRequest(
    io,
    build,
    cwd,
    { step: { dir: io.stepDir(buildChild) } },
    { parse: "none", replay: "never" },
  );
  if (request === "finished") return request;
  const built = io.unit(buildChild, request);
  if (built._tag === "Failed") return { failed: built.error };
  if (built._tag !== "Exited") return "wait";
  if (!built.ok) return { failed: `build exited ${built.exit ?? built.signal}` };
  if (build.artifact === undefined) return { artifact: null };
  const relative = rendered(io, build.artifact);
  if (relative === "finished") return relative;
  const artifact = `${io.runDir}/artifacts/${sha}/${relative.split("/").pop() ?? relative}`;
  const copied = io.unit(`${prefix}/artifact${suffix}`, {
    argv: ["install", "-D", `${ws.path}/${relative}`, artifact],
    cwd: ws,
    heavy: false,
    replay: "safe",
    timeoutMs: COPY_TIMEOUT_MS,
  });
  if (copied._tag === "Failed") return { failed: copied.error };
  if (copied._tag !== "Exited") return "wait";
  return copied.ok ? { artifact } : { failed: `artifact copy exited ${copied.exit}` };
};

/**
 * Runs every `measure` under `childOf(name)`. Exited children are settled only once all are,
 * so an incomplete one is settled failed (one failure per reading, for fatigue) and the rest by
 * default.
 */
const measureAll = (
  io: BlockIO,
  node: Node,
  childOf: (name: string) => string,
  attempt: BlockWorkspace,
  roots: Roots,
): { readonly reading: Reading } | { readonly invalid: string } | Halt => {
  const children: Array<{
    readonly name: string;
    readonly child: string;
    readonly request: UnitRequest;
    readonly seen: UnitObservation;
  }> = [];
  let waiting = false;
  for (const [name, spec] of Object.entries(node.measure)) {
    const child = childOf(name);
    const cwd = cwdOf(io, spec.cwd, attempt);
    if (cwd === "finished") return cwd;
    if (cwd === "wait") {
      waiting = true;
      continue;
    }
    if ("failed" in cwd) return { invalid: `${name}: ${cwd.failed}` };
    const request = unitRequest(
      io,
      spec,
      cwd,
      { ...roots, step: { dir: io.stepDir(child) } },
      { parse: "json", replay: "never" },
    );
    if (request === "finished") return request;
    let seen = io.unitOf(child);
    if (seen._tag === "Absent") seen = io.unit(child, request);
    if (seen._tag !== "Exited" && seen._tag !== "Failed") waiting = true;
    children.push({ name, child, request, seen });
  }
  if (waiting) return "wait";

  const values: { [name: string]: JsonValue } = {};
  let culprit: { readonly child: string; readonly reason: string } | null = null;
  for (const { name, child, seen } of children) {
    const out = seen._tag === "Exited" ? asRecord(seen.out) : null;
    const reason =
      seen._tag === "Failed"
        ? seen.error
        : seen._tag !== "Exited"
          ? "not run"
          : !seen.ok
            ? (seen.parseError ?? `exited ${seen.exit ?? seen.signal}`)
            : out === null
              ? "the output is not a JSON object"
              : out.complete === false
                ? "the measurement reports complete: false"
                : null;
    if (reason !== null && culprit === null) culprit = { child, reason: `${name}: ${reason}` };
    if (out !== null) values[name] = out;
  }
  let objective: number | null = null;
  if (culprit === null) {
    const evaluated = io.evaluate(node.objective.expr, { m: values });
    objective = Result.isSuccess(evaluated) ? asNumber(evaluated.success) : null;
    const first = children[0];
    if (objective === null && first !== undefined)
      culprit = {
        child: first.child,
        reason: Result.isFailure(evaluated)
          ? `objective: ${evaluated.failure}`
          : "objective: not a number",
      };
  }
  for (const { child, request, seen } of children) {
    if (culprit?.child === child && exitedOk(seen)) io.settleChild(child, "failed", culprit.reason);
    else io.unit(child, request);
  }
  if (culprit !== null || objective === null)
    return { invalid: culprit?.reason ?? "objective: not a number" };
  return { reading: { objective, values } };
};

const pointRoots = (point: { readonly sha: string; readonly artifact: string | null }) => ({
  sha: point.sha,
  artifact: point.artifact,
});
/** A point as a metric root: `best.bench.…` reads its values, `best.artifact` its binary. */
const metricRoots = (point: Point): JsonValue => ({
  ...point.reading.values,
  ...pointRoots(point),
});

// ── Phases ────────────────────────────────────────────────────────────────────────────────────

const blocked = (io: BlockIO, reason: string) =>
  io.finish("blocked", { endedBy: "blocked", reason }, { error: reason });

const originPhase = (node: Node, state: State, io: BlockIO): void => {
  const project = projectOf(io, node);
  if (project === "finished") return;
  const base = rendered(io, node.workspace.base);
  if (base === "finished") return;
  const prepared = io.workspace("origin", {
    project,
    baseRef: base,
    branch: bestBranch(state.runId, state.scope),
  });
  if (prepared._tag === "Failed") return blocked(io, `origin: ${prepared.error}`);
  if (prepared._tag !== "Ready") return;
  const ws = prepared.workspace;
  const built = buildArtifact(io, node, "origin", "", ws, ws.headSha);
  if (isHalt(built)) return;
  if ("failed" in built) return blocked(io, `origin does not build: ${built.failed}`);
  const self = pointRoots({ sha: ws.headSha, artifact: built.artifact });
  const measured = measureAll(io, node, (name) => `origin/m_${slug(name)}`, ws, {
    best: self,
    candidate: self,
    origin: self,
  });
  if (isHalt(measured)) return;
  if ("invalid" in measured) return blocked(io, `origin reading is invalid: ${measured.invalid}`);
  io.event("origin", pointJson({ ...self, reading: measured.reading }));
};

const outputOf = (state: State, endedBy: string): { readonly [key: string]: Json } => ({
  endedBy,
  bestSha: state.best?.sha ?? null,
  bestBranch: bestBranch(state.runId, state.scope),
  origin: state.origin === null ? null : pointJson(state.origin),
  best: state.best === null ? null : pointJson(state.best),
  attempts: state.attempts,
});

const finishPhase = (node: Node, state: State, io: BlockIO, end: End): void => {
  const best = state.best;
  if (best === null) return void io.finish(end.port, outputOf(state, end.endedBy));
  const project = projectOf(io, node);
  if (project === "finished") return;
  const ws = io.workspace("best", { project, baseRef: best.sha, branch: null });
  if (ws._tag === "Failed") return void failBlock(io, `best: ${ws.error}`);
  if (ws._tag !== "Ready") return;
  io.finish(end.port, outputOf(state, end.endedBy), {
    // The detached worktree publishes as the best branch the CAS advanced.
    exports: {
      best: {
        workspace: { ...ws.workspace, branch: bestBranch(state.runId, state.scope) },
        head: best.sha,
      },
    },
  });
};

const stopOf = (node: Node, state: State, io: BlockIO): End | null => {
  if (state.exhausted >= 2) return { port: "no_gain", endedBy: "exhausted" };
  if (state.roundsWithoutGain >= node.plateau.rounds)
    return { port: "no_gain", endedBy: "plateau" };
  const budget = node.budget;
  if (budget.iterations !== undefined && state.round > budget.iterations)
    return { port: "budget", endedBy: "iterations" };
  if (budget.wall !== undefined && io.activeMs() >= durationMs(budget.wall))
    return { port: "budget", endedBy: "wall" };
  if (budget.tokens !== undefined && io.spent() >= budget.tokens)
    return { port: "budget", endedBy: "tokens" };
  return null;
};

const confirmPhase = (node: Node, state: State, io: BlockIO, point: Point): void => {
  const origin = state.origin;
  if (origin === null) return;
  const r = `r${state.round}`;
  const suffix = state.slot === 1 ? "" : "_2";
  const attempt = io.workspaceOf(`${r}/ws${suffix}`);
  if (attempt._tag !== "Ready") return void failBlock(io, `${r}: the attempt worktree is gone`);
  const originRoots = metricRoots(origin);
  const measured = measureAll(
    io,
    node,
    (name) => `${r}/c_${slug(name)}${suffix}`,
    attempt.workspace,
    { best: originRoots, candidate: pointRoots(point), origin: originRoots },
  );
  if (isHalt(measured)) return;
  let hit = false;
  if ("reading" in measured) {
    const target = io.evaluate(node.target, {
      m: measured.reading.values,
      best: originRoots,
      origin: originRoots,
    });
    hit = Result.isSuccess(target) && isTruthy(target.success);
  }
  io.event(`${r}/confirm`, {
    hit,
    reading: "reading" in measured ? readingJson(measured.reading) : null,
    note: "invalid" in measured ? measured.invalid : null,
  });
  io.remove(attempt.workspace);
  if (hit) {
    const end: End = { port: "target", endedBy: "target" };
    io.event("end", { port: end.port, endedBy: end.endedBy });
    finishPhase(node, state, io, end);
  }
};

const proposePrompt = (io: BlockIO, node: Node, child: string) => {
  const prompt = rendered(io, node.generator.prompt, { step: { dir: io.stepDir(child) } });
  return prompt === "finished" ? prompt : prompt + PROPOSE_INSTRUCTION;
};

const dedupePrompt = (proposal: Proposal, digest: string) =>
  [
    "Decide whether this proposed experiment repeats one already tried, even under another key.",
    `Proposal key: ${proposal.key}`,
    `Mechanism: ${proposal.mechanism}`,
    "",
    "Ledger:",
    digest,
    "",
    "Answer `repeat: true` only when the mechanism is essentially one already tried.",
  ].join("\n");

const implementPrompt = (io: BlockIO, node: Node, child: string, proposal: Proposal) => {
  const goal = rendered(io, node.generator.prompt, { step: { dir: io.stepDir(child) } });
  if (goal === "finished") return goal;
  return [
    goal,
    "",
    "Implement this registered proposal, and only it:",
    `key: ${proposal.key}`,
    `mechanism: ${proposal.mechanism}`,
    `rationale: ${proposal.rationale}`,
    "",
    "Commit your change in this worktree; the engine reads HEAD and ignores what you report.",
  ].join("\n");
};

const roundPhase = (node: Node, state: State, io: BlockIO, best: Point, origin: Point): void => {
  const r = `r${state.round}`;
  const suffix = state.slot === 1 ? "" : "_2";
  const closeRound = (verdict: Exclude<Verdict, "kept">, note: string | null) =>
    io.event(r, { verdict, note });
  const duplicate = (reason: string) =>
    state.slot === 1 ? io.event(`${r}/dup`, { reason }) : closeRound("duplicate", reason);

  const generator = node.generator;
  const project = projectOf(io, node);
  if (project === "finished") return;
  let genProject = project;
  if (typeof generator.workspace === "object") {
    const text = rendered(io, generator.workspace.project);
    if (text === "finished") return;
    genProject = text;
  } else if (generator.workspace !== "attempt") {
    return void failBlock(
      io,
      `workspace "${generator.workspace}" inside a hillclimb spec is not supported`,
    );
  }
  const readWs = readOnlyWorkspace(io, "ro/gen", genProject);
  if (isHalt(readWs)) return;
  if ("failed" in readWs) return void closeRound("invalid", `generator: ${readWs.failed}`);
  const model = io.model(generator.model);
  if (Result.isFailure(model)) return void failBlock(io, model.failure);
  const turnLimits = {
    ...(generator.tokenReservation === undefined
      ? {}
      : { reservation: generator.tokenReservation }),
    ...(generator.timeout === undefined ? {} : { timeoutMs: durationMs(generator.timeout) }),
  };

  const proposeChild = `${r}/propose${suffix}`;
  const prompt = proposePrompt(io, node, proposeChild);
  if (prompt === "finished") return;
  const proposed = io.turn(proposeChild, {
    model: model.success,
    prompt,
    workspace: readWs,
    access: "read",
    output: PROPOSAL_SHAPE,
    ...turnLimits,
  });
  if (proposed._tag === "Failed") return void closeRound("invalid", proposed.error);
  if (proposed._tag !== "Settled") return;
  if (!proposed.ok) return void closeRound("invalid", proposed.error);
  const proposal = decodeProposal(proposed.output);
  if (proposal === "exhausted") return void closeRound("exhausted", null);
  if (proposal === null) {
    io.settleChild(proposeChild, "failed", "the proposal has no valid key");
    return void closeRound("invalid", "the proposal has no valid key");
  }

  // Repetition judge, then pre-registration before any code exists.
  const judged = io.turn(`${r}/dedupe${suffix}`, {
    model: HAIKU,
    prompt: dedupePrompt(proposal, ledgerDigest(io.ledger(node.ledger))),
    workspace: readWs,
    access: "read",
    output: REPEAT_SHAPE,
    reservation: DEDUPE_RESERVATION,
    timeoutMs: DEDUPE_TIMEOUT_MS,
  });
  if (judged._tag === "Waiting" || judged._tag === "Absent") return;
  const verdict = judged._tag === "Settled" && judged.ok ? asRecord(judged.output) : null;
  if (verdict?.repeat === true)
    return void duplicate(`judge: ${asString(verdict.reason) ?? "repeat"}`);
  const claim = io.register(node.ledger, `${r}${suffix}`, {
    key: proposal.key,
    hypothesis: proposal.mechanism,
    barHash: fnv1a(`${node.keep}\n${node.target}`),
  });
  if (claim === "pending") return;
  if (claim === "taken") return void duplicate(`key ${proposal.key} is already in the ledger`);

  const invalid = (note: string, ws: BlockWorkspace | null, sha: string | null) => {
    io.resolveEntry(node.ledger, {
      key: proposal.key,
      verdict: "invalid",
      before: readingJson(best.reading),
      after: null,
      sha,
      note,
    });
    if (ws !== null) io.remove(ws);
    closeRound("invalid", note);
  };

  const prepared = io.workspace(`${r}/ws${suffix}`, {
    project,
    baseRef: best.sha,
    branch: null,
  });
  if (prepared._tag === "Failed") return invalid(`worktree: ${prepared.error}`, null, null);
  if (prepared._tag !== "Ready") return;
  const ws = prepared.workspace;
  const implementChild = `${r}/implement${suffix}`;
  const implementText = implementPrompt(io, node, implementChild, proposal);
  if (implementText === "finished") return;
  const implemented = io.turn(implementChild, {
    model: model.success,
    prompt: implementText,
    workspace: ws,
    access: "write",
    ...turnLimits,
  });
  if (implemented._tag === "Failed") return invalid(implemented.error, ws, null);
  if (implemented._tag !== "Settled") return;
  if (!implemented.ok) return invalid(implemented.error ?? "the turn failed", ws, null);
  const sha = implemented.headSha;
  if (sha === null || sha === best.sha) {
    io.settleChild(implementChild, "failed", "no new commit");
    return invalid("no new commit", ws, null);
  }
  if (implemented.treeHash === null) {
    io.settleChild(implementChild, "failed", "no tree hash");
    return invalid("no tree hash", ws, sha);
  }
  const tree = io.seeTree(node.ledger, implemented.treeHash, proposal.key);
  if (tree === "pending") return;
  if (tree === "taken") {
    io.resolveEntry(node.ledger, {
      key: proposal.key,
      verdict: "duplicate",
      before: readingJson(best.reading),
      after: null,
      sha,
      note: `tree ${implemented.treeHash} was already measured`,
    });
    io.remove(ws);
    return void duplicate(`tree ${implemented.treeHash} was already measured`);
  }

  const built = buildArtifact(io, node, r, suffix, ws, sha);
  if (isHalt(built)) return;
  if ("failed" in built) return invalid(built.failed, ws, sha);
  const candidate = pointRoots({ sha, artifact: built.artifact });
  const bestRoots = metricRoots(best);
  const originRoots = metricRoots(origin);
  const measured = measureAll(io, node, (name) => `${r}/m_${slug(name)}${suffix}`, ws, {
    best: bestRoots,
    candidate,
    origin: originRoots,
  });
  if (isHalt(measured)) return;
  if ("invalid" in measured) return invalid(measured.invalid, ws, sha);
  const point: Point = { ...candidate, reading: measured.reading };
  const judgeRoots = { m: measured.reading.values, best: bestRoots, origin: originRoots };
  const keep = io.evaluate(node.keep, judgeRoots);
  if (Result.isFailure(keep)) return invalid(`keep: ${keep.failure}`, ws, sha);
  if (!isTruthy(keep.success)) {
    io.resolveEntry(node.ledger, {
      key: proposal.key,
      verdict: "rejected",
      before: readingJson(best.reading),
      after: readingJson(point.reading),
      sha,
      note: null,
    });
    io.remove(ws);
    return void closeRound("rejected", null);
  }
  const originWs = io.workspaceOf("origin");
  if (originWs._tag !== "Ready") return void failBlock(io, "the origin worktree is gone");
  const advanced = io.advance(`${r}/advance${suffix}`, {
    workspace: originWs.workspace,
    branch: bestBranch(state.runId, state.scope),
    from: best.sha,
    to: sha,
  });
  if (advanced._tag === "Failed") return void failBlock(io, `advance: ${advanced.error}`);
  if (advanced._tag !== "Done") return;
  const confirmWhen =
    node.confirmWhen === undefined ? null : io.evaluate(node.confirmWhen, judgeRoots);
  const confirm =
    confirmWhen === null || (Result.isSuccess(confirmWhen) && isTruthy(confirmWhen.success));
  io.resolveEntry(node.ledger, {
    key: proposal.key,
    verdict: "kept",
    before: readingJson(best.reading),
    after: readingJson(point.reading),
    sha,
    note: null,
  });
  io.event(r, { verdict: "kept", point: pointJson(point), confirm });
  // A confirmation may measure in the attempt's worktree; it removes the worktree itself.
  if (!confirm) io.remove(ws);
};

export const hillclimb: BlockDecider<"hillclimb", State> = {
  derive,
  decide: (node, state, io) => {
    if (state.end !== null) return finishPhase(node, state, io, state.end);
    const { origin, best } = state;
    if (origin === null || best === null) return originPhase(node, state, io);
    if (state.confirming !== null) return confirmPhase(node, state, io, state.confirming);
    // Stops are checked between rounds only: a started round runs to its verdict.
    const fresh = state.slot === 1 && io.turnOf(`r${state.round}/propose`)._tag === "Absent";
    const stop = fresh ? stopOf(node, state, io) : null;
    if (stop !== null) {
      io.event("end", { port: stop.port, endedBy: stop.endedBy });
      return finishPhase(node, state, io, stop);
    }
    roundPhase(node, state, io, best, origin);
  },
  view: (_node, state) => ({
    _tag: "hillclimb",
    step: WorkflowStepKey.make(state.step),
    round: state.end === null ? (state.origin === null ? 0 : state.round) : state.closed,
    origin: state.origin?.sha ?? null,
    best: state.best?.reading ?? null,
    roundsWithoutGain: state.roundsWithoutGain,
    attempts: state.attempts,
  }),
};
