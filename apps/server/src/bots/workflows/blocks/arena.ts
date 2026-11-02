/**
 * The arena block (§4.2): candidates in detached worktrees, drained when all settle or the timeout
 * passes; a judge of another family than the lead (the only one to see the rubric) picks a base;
 * the lead grafts onto it, rerun by `verify`. The drain and the verdict are pinned block events.
 */
import * as Result from "effect/Result";
import type { Json, JsonObject } from "effect/Schema";

import {
  type WorkflowModelRef,
  type WorkflowOutputShape,
  WorkflowStepKey,
  type WorkflowStepStatus,
} from "@t3tools/contracts";
import { isTruthy, type JsonValue, modelFamily } from "@t3tools/shared/workflows";

import { blockScope } from "./reader.ts";
import type {
  BlockDecider,
  BlockIO,
  BlockNode,
  BlockWorkspace,
  TurnObservation,
  UnitRequest,
} from "./types.ts";

type Node = BlockNode<"arena">;
type Roots = { readonly [root: string]: JsonValue };

/** A candidate that committed something: the judge and the graft read it. */
interface Candidate {
  readonly id: string;
  readonly sha: string;
  readonly path: string;
}
interface Graft {
  readonly from: string;
  readonly idea: string;
}
interface Verdict {
  readonly base: string;
  readonly scores: Json;
  readonly grafts: ReadonlyArray<Graft>;
}

interface State {
  readonly step: string;
  /** `<step>`, or `<step>/a<n>` for a retried block: its branches never collide with attempt 1's. */
  readonly scope: string;
  readonly runId: string;
  readonly candidates: ReadonlyArray<{ readonly id: string; readonly status: WorkflowStepStatus }>;
  /** The valid candidates, fixed when the arena drained. */
  readonly drained: ReadonlyArray<Candidate> | null;
  readonly verdict: Verdict | null;
}

const DEFAULT_TIMEOUT_MS = 6 * 3_600_000;
const DURATION_UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000 } as const;

const VERDICT_SHAPE: WorkflowOutputShape = {
  scores: { type: "json" },
  base: { type: "string" },
  graft: { type: "json" },
};

const durationMs = (text: string): number => {
  const unit = text.slice(-1);
  const scale = unit === "s" || unit === "m" || unit === "h" ? DURATION_UNIT_MS[unit] : 0;
  return Number(text.slice(0, -1)) * scale;
};
const slug = (text: string) => text.toLowerCase().replace(/[^a-z0-9_]/g, "_");
const graftBranch = (runId: string, step: string) =>
  `wf/${runId}/${step.replace(/[[\]]/g, "_")}/graft`;
/** The arena's own node id, the last segment of its step (`each[2]/duel` → `duel`). */
const nodeIdOf = (step: string) => (step.split("/").at(-1) ?? step).replace(/\[\d+\]$/, "");
const candidateId = (index: number) => `c${index}`;

// ── Json decoding of the pinned events and of the judge's output ──────────────────────────────

const isJsonObject = (value: Json | undefined): value is JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const asRecord = (value: Json | undefined): JsonObject | null =>
  isJsonObject(value) ? value : null;
const asString = (value: Json | undefined): string | null =>
  typeof value === "string" ? value : null;
const asArray = (value: Json | undefined): ReadonlyArray<Json> =>
  Array.isArray(value) ? value : [];

const decodeCandidate = (value: Json): Candidate | null => {
  const record = asRecord(value);
  const id = asString(record?.id);
  const sha = asString(record?.sha);
  const path = asString(record?.path);
  return id === null || sha === null || path === null ? null : { id, sha, path };
};
const candidateJson = (c: Candidate): Json => ({ id: c.id, sha: c.sha, path: c.path });

/** Ideas whose `from` is not a drained candidate, or that name nothing, are dropped. */
const decodeGrafts = (value: Json | undefined, valid: ReadonlySet<string>): Graft[] =>
  asArray(value).flatMap((item) => {
    const record = asRecord(item);
    const from = asString(record?.from)?.trim() ?? "";
    const idea = asString(record?.idea)?.trim() ?? "";
    return valid.has(from) && idea.length > 0 ? [{ from, idea }] : [];
  });
const graftsJson = (grafts: ReadonlyArray<Graft>): Json =>
  grafts.map((g) => ({ from: g.from, idea: g.idea }));

const decodeVerdict = (value: Json): Verdict | null => {
  const record = asRecord(value);
  const base = asString(record?.base);
  if (record === null || base === null) return null;
  const grafts = asArray(record.grafts).flatMap((item) => {
    const g = asRecord(item);
    const from = asString(g?.from);
    const idea = asString(g?.idea);
    return from === null || idea === null ? [] : [{ from, idea }];
  });
  return { base, scores: record.scores ?? null, grafts };
};

const scoreOf = (scores: Json, id: string): number | null => {
  const value = asRecord(scores)?.[id];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

// ── Derive ────────────────────────────────────────────────────────────────────────────────────

const derive: BlockDecider<"arena", State>["derive"] = (node, reader) => {
  let drained: Candidate[] | null = null;
  let verdict: Verdict | null = null;
  for (const { id, event } of reader.events) {
    if (id === "drained")
      drained = asArray(asRecord(event)?.candidates).flatMap((c) => {
        const candidate = decodeCandidate(c);
        return candidate === null ? [] : [candidate];
      });
    else if (id === "verdict") verdict = decodeVerdict(event);
  }
  return {
    step: reader.step,
    scope: blockScope(reader.step, reader.attempt),
    runId: reader.runId,
    candidates: node.runners.map((_, i) => ({
      id: candidateId(i),
      status: reader.childStatus(`${candidateId(i)}/run`),
    })),
    drained,
    verdict,
  };
};

// ── Helpers ───────────────────────────────────────────────────────────────────────────────────

/** A pass that cannot go on: still waiting, or it already finished the block. */
type Halt = "wait" | "finished";

const failBlock = (io: BlockIO, error: string): "finished" => {
  io.finish("fail", {}, { error });
  return "finished";
};

const rendered = (io: BlockIO, template: string, roots?: Roots): string | "finished" => {
  const result = io.render(template, roots);
  return Result.isFailure(result) ? failBlock(io, result.failure) : result.success;
};

const modelOf = (io: BlockIO, use: Node["lead"]): WorkflowModelRef | "finished" => {
  const model = io.model(use);
  return Result.isFailure(model) ? failBlock(io, model.failure) : model.success;
};

/** What every candidate and the graft read: the task and the artifact contract, never the rubric. */
const brief = (io: BlockIO, node: Node, child: string): string | "finished" => {
  const roots = { step: { dir: io.stepDir(child) } };
  const task = rendered(io, node.task, roots);
  if (task === "finished") return task;
  const artifact = rendered(io, node.artifact, roots);
  if (artifact === "finished") return artifact;
  return `${task}\n\nArtifact contract:\n${artifact}`;
};

const unitRequest = (
  io: BlockIO,
  spec: NonNullable<Node["verify"]>,
  cwd: BlockWorkspace,
  roots: Roots,
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
    replay: spec.replay ?? "never",
    timeoutMs: spec.timeout === undefined ? DEFAULT_TIMEOUT_MS : durationMs(spec.timeout),
    env,
    parse: spec.parse ?? "none",
    ...(spec.tokensFrom === undefined ? {} : { tokensFrom: spec.tokensFrom }),
    ...(spec.tokenReservation === undefined ? {} : { reservation: spec.tokenReservation }),
  };
};

// ── Phases ────────────────────────────────────────────────────────────────────────────────────

/**
 * Asks for every candidate and reads them back. Before the drain it returns the valid ones once
 * all settled (or the timeout passed, interrupting the live ones); after it, it only observes the
 * children it already started, so a late turn still settles in the run.
 */
const candidatesPhase = (
  node: Node,
  state: State,
  io: BlockIO,
  project: string,
  base: string,
): ReadonlyArray<Candidate> | Halt => {
  const drainedAlready = state.drained !== null;
  const valid: Candidate[] = [];
  const live: string[] = [];
  for (const [i, use] of node.runners.entries()) {
    const id = candidateId(i);
    const wsChild = `${id}/ws`;
    const runChild = `${id}/run`;
    if (drainedAlready && io.workspaceOf(wsChild)._tag === "Absent") continue;
    const prepared = io.workspace(wsChild, { project, baseRef: base, branch: null });
    if (prepared._tag === "Failed") continue;
    if (prepared._tag !== "Ready") {
      live.push(runChild);
      continue;
    }
    const ws = prepared.workspace;
    if (drainedAlready && io.turnOf(runChild)._tag === "Absent") continue;
    const model = modelOf(io, use);
    if (model === "finished") return model;
    const prompt = brief(io, node, runChild);
    if (prompt === "finished") return prompt;
    const ran: TurnObservation = io.turn(runChild, {
      model,
      prompt: `${prompt}\n\nCommit your work in this worktree; the engine reads HEAD and ignores what you report.`,
      workspace: ws,
      access: "write",
      ...(node.timeout === undefined ? {} : { timeoutMs: durationMs(node.timeout) }),
    });
    if (ran._tag === "Failed") continue;
    if (ran._tag !== "Settled") {
      live.push(runChild);
      continue;
    }
    if (!ran.ok) continue;
    if (ran.headSha === null || ran.headSha === ws.headSha) {
      io.settleChild(runChild, "failed", "no new commit");
      continue;
    }
    valid.push({ id, sha: ran.headSha, path: ws.path });
  }
  if (state.drained !== null) return state.drained;
  const timedOut = node.timeout !== undefined && io.activeMs() >= durationMs(node.timeout);
  if (live.length > 0 && !timedOut) return "wait";
  for (const child of live) io.interrupt(child);
  io.event("drained", { candidates: valid.map(candidateJson), timedOut: live.length > 0 });
  if (valid.length >= node.minCandidates) return valid;
  io.finish("insufficient", {
    candidates: valid.map(candidateJson),
    valid: valid.length,
    minCandidates: node.minCandidates,
  });
  return "finished";
};

const judgePrompt = (node: Node, task: string, candidates: ReadonlyArray<Candidate>) =>
  [
    "Judge the candidates below. Each one worked this task in its own worktree and committed:",
    "",
    task,
    "",
    "Candidates (read their worktrees and commits; do not edit anything):",
    ...candidates.map((c) => `- ${c.id}: commit ${c.sha}, worktree ${c.path}`),
    "",
    "Rubric:",
    ...node.rubric.map((item, i) => `${i + 1}. ${item}`),
    "",
    "Score every candidate against the rubric. Answer `scores` (an object from candidate id to a " +
      "number), `base` (the id of the candidate the final result should start from) and `graft` " +
      "(a list of `{ from, idea }`: the ideas from other candidates worth grafting into the base).",
  ].join("\n");

const judgePhase = (
  node: Node,
  io: BlockIO,
  judge: WorkflowModelRef,
  project: string,
  base: string,
  candidates: ReadonlyArray<Candidate>,
): Verdict | Halt => {
  const prepared = io.workspace("judge/ws", { project, baseRef: base, branch: null });
  if (prepared._tag === "Failed") return failBlock(io, `judge worktree: ${prepared.error}`);
  if (prepared._tag !== "Ready") return "wait";
  const task = brief(io, node, "judge");
  if (task === "finished") return task;
  const judged = io.turn("judge", {
    model: judge,
    prompt: judgePrompt(node, task, candidates),
    workspace: prepared.workspace,
    access: "read",
    output: VERDICT_SHAPE,
  });
  if (judged._tag === "Failed") return failBlock(io, `judge: ${judged.error}`);
  if (judged._tag !== "Settled") return "wait";
  if (!judged.ok) return failBlock(io, `judge: ${judged.error ?? "the turn failed"}`);
  const output = asRecord(judged.output);
  const ids = new Set(candidates.map((c) => c.id));
  const chosen = asString(output?.base)?.trim() ?? "";
  if (!ids.has(chosen)) {
    const reason = `the judge chose no valid base (${chosen || "none"})`;
    io.settleChild("judge", "failed", reason);
    return failBlock(io, reason);
  }
  const verdict: Verdict = {
    base: chosen,
    scores: output?.scores ?? null,
    grafts: decodeGrafts(output?.graft, new Set([...ids].filter((id) => id !== chosen))),
  };
  io.event("verdict", { ...verdict, grafts: graftsJson(verdict.grafts) });
  return verdict;
};

const graftPrompt = (
  task: string,
  verdict: Verdict,
  base: Candidate,
  candidates: ReadonlyArray<Candidate>,
  failure: string | null,
) => {
  const byId = new Map(candidates.map((c) => [c.id, c]));
  const ideas =
    verdict.grafts.length === 0
      ? ["(none: keep the base as it is unless the task needs more)"]
      : verdict.grafts.map((g) => {
          const from = byId.get(g.from);
          return `- from ${g.from}${from === undefined ? "" : ` (commit ${from.sha}, worktree ${from.path})`}: ${g.idea}`;
        });
  return [
    task,
    "",
    `This worktree starts at candidate ${base.id} (commit ${base.sha}), the base a judge chose ` +
      "among the candidates. Graft these ideas from the other candidates into it:",
    ...ideas,
    "",
    "Read the other candidates' worktrees and commits, but never change them.",
    ...(failure === null
      ? []
      : ["", "The verification failed after the previous graft; fix it:", failure]),
    "",
    "Commit your work in this worktree; the engine reads HEAD and ignores what you report.",
  ].join("\n");
};

const verifyCwd = (
  io: BlockIO,
  node: Node,
  state: State,
  graftWs: BlockWorkspace,
): BlockWorkspace | "wait" | "finished" => {
  const use = node.verify?.cwd;
  if (use === undefined || use === `${nodeIdOf(state.step)}.graft`) return graftWs;
  if (typeof use === "string")
    return failBlock(io, `workspace "${use}" inside an arena verify is not supported`);
  const project = rendered(io, use.project);
  if (project === "finished") return project;
  const ws = io.workspace(`ro/${slug(project)}`, { project, baseRef: "HEAD", branch: null });
  if (ws._tag === "Failed") return failBlock(io, `verify worktree: ${ws.error}`);
  return ws._tag === "Ready" ? ws.workspace : "wait";
};

const graftPhase = (
  node: Node,
  state: State,
  io: BlockIO,
  lead: WorkflowModelRef,
  project: string,
  verdict: Verdict,
  candidates: ReadonlyArray<Candidate>,
): void => {
  const base = candidates.find((c) => c.id === verdict.base);
  if (base === undefined) return void failBlock(io, `the base ${verdict.base} was not drained`);
  const prepared = io.workspace("graft/ws", {
    project,
    baseRef: base.sha,
    branch: graftBranch(state.runId, state.scope),
  });
  if (prepared._tag === "Failed") return void failBlock(io, `graft worktree: ${prepared.error}`);
  if (prepared._tag !== "Ready") return;
  const ws = prepared.workspace;

  let head = ws.headSha;
  let failure: string | null = null;
  let k = 0;
  while (true) {
    k += 1;
    const child = `graft/r${k}`;
    const task = brief(io, node, child);
    if (task === "finished") return;
    const grafted = io.turn(child, {
      model: lead,
      prompt: graftPrompt(task, verdict, base, candidates, failure),
      workspace: ws,
      access: "write",
    });
    if (grafted._tag === "Failed") return void failBlock(io, `${child}: ${grafted.error}`);
    if (grafted._tag !== "Settled") return;
    if (!grafted.ok) return void failBlock(io, `${child}: ${grafted.error ?? "the turn failed"}`);
    head = grafted.headSha ?? head;

    const spec = node.verify;
    if (spec === undefined) break;
    const cwd = verifyCwd(io, node, state, ws);
    if (cwd === "wait" || cwd === "finished") return;
    const verifyChild = `verify/r${k}`;
    const request = unitRequest(io, spec, cwd, {
      step: { dir: io.stepDir(verifyChild) },
    });
    if (request === "finished") return;
    const verified = io.unit(verifyChild, request);
    if (verified._tag === "Waiting" || verified._tag === "Absent") return;
    // A spec's `check` decides pass or fail over `{ exit, out }`, as for a command node.
    // A timeout, a lost unit or unparsable output fails before any check, as for a command node.
    const checked =
      verified._tag !== "Exited" ||
      spec.check === undefined ||
      verified.lost ||
      verified.signal === "TIMEOUT" ||
      verified.parseError !== null
        ? null
        : io.evaluate(spec.check, { exit: verified.exit, out: verified.out as JsonValue });
    if (checked !== null && Result.isSuccess(checked) && isTruthy(checked.success)) break;
    if (checked === null && spec.check === undefined && verified._tag === "Exited" && verified.ok)
      break;
    failure =
      verified._tag === "Failed"
        ? verified.error
        : checked !== null && Result.isFailure(checked)
          ? `check: ${checked.failure}`
          : `exit ${verified.exit ?? verified.signal}${verified.parseError === null ? "" : ` (${verified.parseError})`}${checked === null ? "" : " (check false)"}\n${verified.tail}`;
    if (k > node.maxReruns)
      return void failBlock(io, `verify failed after ${k} graft${k === 1 ? "" : "s"}`);
  }
  io.finish(
    "ok",
    {
      base: verdict.base,
      scores: verdict.scores,
      grafts: graftsJson(verdict.grafts),
      sha: head,
    },
    { exports: { graft: { workspace: ws, head } } },
  );
};

export const arena: BlockDecider<"arena", State> = {
  derive,
  decide: (node, state, io) => {
    const judge = modelOf(io, node.judge);
    if (judge === "finished") return;
    const lead = modelOf(io, node.lead);
    if (lead === "finished") return;
    if (modelFamily(judge) === modelFamily(lead))
      return void io.finish("fail", {}, { error: "judge-family" });
    const project = rendered(io, node.workspace.project);
    if (project === "finished") return;
    const base = rendered(io, node.workspace.base);
    if (base === "finished") return;

    const candidates = candidatesPhase(node, state, io, project, base);
    if (candidates === "wait" || candidates === "finished") return;
    const verdict = state.verdict ?? judgePhase(node, io, judge, project, base, candidates);
    if (verdict === "wait" || verdict === "finished") return;
    graftPhase(node, state, io, lead, project, verdict, candidates);
  },
  view: (_node, state) => ({
    _tag: "arena",
    step: WorkflowStepKey.make(state.step),
    candidates: state.candidates.map((c) => ({
      id: c.id,
      status: c.status,
      score: state.verdict === null ? null : scoreOf(state.verdict.scores, c.id),
    })),
    base: state.verdict?.base ?? null,
    grafts: state.verdict?.grafts.map((g) => g.idea) ?? [],
  }),
};
