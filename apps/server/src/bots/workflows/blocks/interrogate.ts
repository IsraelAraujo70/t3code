/**
 * The interrogate block (§4.4): each round, fresh read-only reviewers look at the target frozen at
 * the round's sha; the lead answers their findings in one write thread that carries over rounds,
 * then the checks run. Approval needs every reviewer of the round clean, and a review that failed
 * (error, timeout, invalid JSON) never counts as one. A last round where no reviewer answered fails.
 */
import * as Result from "effect/Result";
import type { Json } from "effect/Schema";

import {
  type WorkflowCommandSpec,
  type WorkflowOutputShape,
  WorkflowStepKey,
} from "@t3tools/contracts";
import type { JsonValue } from "@t3tools/shared/workflows";

import type {
  BlockDecider,
  BlockIO,
  BlockNode,
  BlockReader,
  BlockWorkspace,
  UnitObservation,
} from "./types.ts";

type Node = BlockNode<"interrogate">;

const SEVERITIES = ["blocker", "should", "nit"] as const;
type Severity = (typeof SEVERITIES)[number];
const RESOLUTIONS = ["fixed", "disagree", "declined"] as const;
type Resolution = (typeof RESOLUTIONS)[number];
const VERDICTS = ["APPROVE", "CHANGES"] as const;
type Verdict = (typeof VERDICTS)[number];

const FINDING_ID_MAX = 80;
const SPEC_TIMEOUT_MS = 6 * 3_600_000;
const DURATION_UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000 } as const;
const durationMs = (text: string): number =>
  Number(text.slice(0, -1)) * DURATION_UNIT_MS[text.slice(-1) as keyof typeof DURATION_UNIT_MS];

const REVIEW_OUTPUT: WorkflowOutputShape = {
  verdict: { type: "string" },
  findings: { type: "json" },
};
const LEAD_OUTPUT: WorkflowOutputShape = { resolutions: { type: "json" } };

const isRecord = (value: unknown): value is { readonly [key: string]: unknown } =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const oneOf = <T extends string>(values: ReadonlyArray<T>, value: unknown): value is T =>
  typeof value === "string" && (values as ReadonlyArray<string>).includes(value);

interface Finding {
  /** Unique in the block: the reviewer's id, prefixed by `rev<i>.` in a panel. */
  readonly key: string;
  /** The id as the reviewer wrote it, which it reuses in its next review. */
  readonly id: string;
  readonly reviewer: number;
  readonly severity: Severity;
  readonly file: string;
  readonly line: number | null;
  readonly claim: string;
  readonly evidence: string;
}

interface Review {
  readonly reviewer: number;
  /** Why the review does not count; null for a valid answer. */
  readonly error: string | null;
  readonly verdict: Verdict | null;
  readonly findings: ReadonlyArray<Finding>;
}

const parseFindings = (
  raw: unknown,
  reviewer: number,
  panel: boolean,
): ReadonlyArray<Finding> | string => {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return "`findings` must be an array";
  const findings: Finding[] = [];
  for (const [index, item] of raw.entries()) {
    const at = `findings[${index}]`;
    if (!isRecord(item)) return `${at} must be an object`;
    const { id, severity, file, line, claim, evidence } = item;
    if (typeof id !== "string" || id.trim() === "" || id.length > FINDING_ID_MAX)
      return `${at}.id must be a non-empty string of at most ${FINDING_ID_MAX} characters`;
    if (!oneOf(SEVERITIES, severity)) return `${at}.severity must be blocker, should or nit`;
    if (typeof claim !== "string" || claim.trim() === "")
      return `${at}.claim must be a non-empty string`;
    if (findings.some((f) => f.id === id)) return `${at}.id "${id}" is used twice`;
    findings.push({
      key: panel ? `rev${reviewer}.${id}` : id,
      id,
      reviewer,
      severity,
      file: typeof file === "string" ? file : "",
      line: typeof line === "number" && Number.isInteger(line) ? line : null,
      claim,
      evidence: typeof evidence === "string" ? evidence : "",
    });
  }
  return findings;
};

/** A reviewer's answer as pinned: `{ reviewer, error, output }`, the output parsed here. */
const parseReview = (entry: unknown, panel: boolean): Review | null => {
  if (!isRecord(entry) || typeof entry.reviewer !== "number") return null;
  const reviewer = entry.reviewer;
  const invalid = (error: string): Review => ({ reviewer, error, verdict: null, findings: [] });
  if (typeof entry.error === "string") return invalid(entry.error);
  const output = entry.output;
  if (!isRecord(output)) return invalid("the review is not a JSON object");
  if (!oneOf(VERDICTS, output.verdict)) return invalid("`verdict` must be APPROVE or CHANGES");
  const findings = parseFindings(output.findings, reviewer, panel);
  if (typeof findings === "string") return invalid(findings);
  return { reviewer, error: null, verdict: output.verdict, findings };
};

/** Clean: a valid review with nothing above a nit (a bare CHANGES with no findings is not). */
const satisfied = (review: Review) =>
  review.error === null &&
  review.findings.every((f) => f.severity === "nit") &&
  (review.verdict === "APPROVE" || review.findings.length > 0);

const parseResolutions = (output: unknown): ReadonlyMap<string, Resolution> => {
  const resolutions = new Map<string, Resolution>();
  const raw = isRecord(output) ? output.resolutions : undefined;
  if (!Array.isArray(raw)) return resolutions;
  for (const item of raw)
    if (isRecord(item) && typeof item.id === "string" && oneOf(RESOLUTIONS, item.state))
      resolutions.set(item.id, item.state);
  return resolutions;
};

interface Round {
  readonly n: number;
  /** The target's HEAD when the round began: what its reviewers read. */
  readonly sha: string;
  readonly reviewers: ReadonlyArray<number>;
  readonly reviews: ReadonlyArray<Review> | null;
  /** The lead's answers by finding key; null until it settled. */
  readonly resolutions: ReadonlyMap<string, Resolution> | null;
  /** Check failures after the lead's turn; null until the checks ran. */
  readonly checks: ReadonlyArray<string> | null;
  /** Checks still failing from an earlier round: the lead fixes them too, and they bar approval. */
  readonly checksBefore: ReadonlyArray<string>;
  /** Findings or failing checks the lead must answer this round. */
  readonly needsLead: boolean;
  readonly complete: boolean;
}

type End = { readonly port: "approve" | "stuck" | "fail"; readonly reason: string };

interface FindingView {
  readonly finding: Finding;
  /** open, fixed, disagree, declined, or resolved once its reviewer no longer reports it. */
  readonly state: string;
}

interface State {
  readonly step: string;
  readonly rounds: ReadonlyArray<Round>;
  readonly findings: ReadonlyArray<FindingView>;
  readonly end: End | null;
}

const derive = (node: Node, reader: BlockReader): State => {
  const pinned = new Map(reader.events.map((e) => [e.id, e.event]));
  const panel = node.mode === "panel";
  const rounds: Round[] = [];
  const findings = new Map<string, FindingView>();
  const disputes = new Map<string, number>();
  let checksFailing: ReadonlyArray<string> = [];
  let end: End | null = null;

  for (let n = 1; end === null && pinned.has(`r${n}`); n++) {
    const start = pinned.get(`r${n}`);
    const sha = isRecord(start) && typeof start.sha === "string" ? start.sha : "";
    const reviewers =
      isRecord(start) && Array.isArray(start.reviewers)
        ? start.reviewers.filter((i): i is number => typeof i === "number")
        : [];
    const checksBefore = checksFailing;
    const reviewsEvent = pinned.get(`r${n}_reviews`);
    const reviews =
      isRecord(reviewsEvent) && Array.isArray(reviewsEvent.reviews)
        ? reviewsEvent.reviews.flatMap((entry) => parseReview(entry, panel) ?? [])
        : null;
    const base = { n, sha, reviewers, checksBefore };
    if (reviews === null) {
      rounds.push({
        ...base,
        reviews,
        resolutions: null,
        checks: null,
        needsLead: false,
        complete: false,
      });
      break;
    }

    for (const review of reviews) {
      if (review.error !== null) continue;
      for (const [key, view] of findings)
        if (
          view.finding.reviewer === review.reviewer &&
          !review.findings.some((f) => f.key === key)
        )
          findings.set(key, { ...view, state: "resolved" });
      for (const finding of review.findings) findings.set(finding.key, { finding, state: "open" });
    }

    const approved = reviews.length > 0 && reviews.every(satisfied) && checksBefore.length === 0;
    const raised = reviews.flatMap((r) => (r.error === null ? r.findings : []));
    const needsLead = !approved && (raised.length > 0 || checksBefore.length > 0);
    const leadEvent = pinned.get(`r${n}_lead`);
    const resolutions =
      needsLead && pinned.has(`r${n}_lead`)
        ? new Map(
            [...parseResolutions(isRecord(leadEvent) ? leadEvent.output : null)].filter(([key]) =>
              raised.some((f) => f.key === key),
            ),
          )
        : null;
    const checksEvent = pinned.get(`r${n}_checks`);
    const checks =
      resolutions !== null && isRecord(checksEvent) && Array.isArray(checksEvent.failed)
        ? checksEvent.failed.filter((f): f is string => typeof f === "string")
        : null;
    if (checks !== null) checksFailing = checks;
    const complete = !needsLead || checks !== null;

    for (const [key, state] of resolutions ?? []) {
      const view = findings.get(key);
      if (view !== undefined) findings.set(key, { ...view, state });
      if (state !== "disagree") continue;
      const count = (disputes.get(key) ?? 0) + 1;
      disputes.set(key, count);
      if (count >= 2 && end === null)
        end = { port: "stuck", reason: `finding ${key} was disputed in two rounds` };
    }
    if (approved)
      end = {
        port: "approve",
        reason: raised.length > 0 ? "only nits are open" : "every reviewer approved",
      };
    else if (end === null && complete && n >= node.rounds && reviews.every((r) => r.error !== null))
      // Reviewers that never answered are not reviewers stuck on the change: nobody judged it.
      end = {
        port: "fail",
        reason:
          `no reviewer answered in round ${n}:\n` +
          reviews.map((r) => `reviewer ${r.reviewer}: ${r.error}`).join("\n"),
      };
    else if (end === null && complete && n >= node.rounds)
      end = {
        port: "stuck",
        reason:
          checksFailing.length > 0
            ? `the checks still fail after ${n} rounds:\n${checksFailing.join("\n")}`
            : `no approval after ${n} rounds`,
      };
    rounds.push({ ...base, reviews, resolutions, checks, needsLead, complete });
  }

  return { step: reader.step, rounds, findings: [...findings.values()], end };
};

/** loop: the first reviewer; panel: all of them, then those whose last review was not clean. */
const reviewersOf = (node: Node, previous: Round | undefined): ReadonlyArray<number> => {
  if (node.mode === "loop") return [0];
  if (previous === undefined || previous.reviews === null) return node.reviewers.map((_, i) => i);
  const open = previous.reviewers.filter((i) => {
    const review = previous.reviews?.find((r) => r.reviewer === i);
    return review === undefined || !satisfied(review);
  });
  return open.length > 0 ? open : previous.reviewers;
};

const findingLine = (f: Finding, id: string, state?: string) =>
  `- ${id} [${f.severity}] ${f.file}${f.line === null ? "" : `:${f.line}`}: ${f.claim}` +
  (f.evidence === "" ? "" : `\n  evidence: ${f.evidence}`) +
  (state === undefined ? "" : `\n  lead: ${state}`);

const reviewerPrompt = (
  intent: string,
  baseRef: string,
  round: Round,
  previous: { readonly sha: string; readonly findings: ReadonlyArray<FindingView> } | null,
) =>
  `Review a change made for this intent:\n${intent}\n\n` +
  `This worktree is a read-only copy of the change at ${round.sha}. Read it with ` +
  `\`git diff ${baseRef}..HEAD\` and the files it touches; change nothing.` +
  (previous === null
    ? ""
    : `\n\nSince the previous review the lead changed \`git diff ${previous.sha}..HEAD\`.` +
      (previous.findings.length === 0
        ? ""
        : " Your findings then, with the lead's answer:\n" +
          previous.findings.map((v) => findingLine(v.finding, v.finding.id, v.state)).join("\n") +
          "\nKeep the id of a finding that still holds; leave out the ones that are fixed.")) +
  "\n\nAnswer `verdict` APPROVE when nothing blocks the change, else CHANGES, and `findings`: " +
  "objects with `id` (short and stable), `severity` (blocker: wrong or unsafe; should: fix before " +
  "merging; nit: optional), `file`, `line`, `claim` and `evidence` you checked.";

const leadPrompt = (intent: string, round: Round, raised: ReadonlyArray<Finding>) =>
  `Reviewers read ${round.sha} against this intent:\n${intent}` +
  (raised.length === 0
    ? ""
    : "\n\nVerify each finding below in this worktree. Fix the ones that hold and commit; " +
      "disagree, with evidence, with the ones that do not; decline only a nit you leave as is.\n" +
      raised.map((f) => findingLine(f, f.key)).join("\n")) +
  (round.checksBefore.length === 0
    ? ""
    : `\n\nThe checks fail after your previous changes; make them pass and commit:\n${round.checksBefore.join("\n")}`) +
  "\n\nAnswer `resolutions`: one `{ id, state }` per finding id, state fixed, disagree or declined.";

type Invalid = { readonly _tag: "Invalid"; readonly error: string };

/** A check in the target, or in a detached copy of a project when it asks for a read-only one. */
const checkUnit = (
  io: BlockIO,
  node: Node,
  child: string,
  index: number,
  spec: WorkflowCommandSpec,
  target: BlockWorkspace,
): UnitObservation | Invalid => {
  const invalid = (error: string): Invalid => ({ _tag: "Invalid", error });
  let cwd = target;
  if (typeof spec.cwd === "string") {
    if (spec.cwd !== node.target.workspace)
      return invalid(`workspace "${spec.cwd}" inside an interrogate check is not supported`);
  } else {
    const project = io.render(spec.cwd.project);
    if (Result.isFailure(project)) return invalid(project.failure);
    const ro = io.workspace(`ro/check${index}`, {
      project: project.success,
      baseRef: "HEAD",
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
    ...(spec.tokensFrom === undefined ? {} : { tokensFrom: spec.tokensFrom }),
    ...(spec.tokenReservation === undefined ? {} : { reservation: spec.tokenReservation }),
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

const findingJson = (view: FindingView): Json => ({
  id: view.finding.key,
  severity: view.finding.severity,
  file: view.finding.file,
  line: view.finding.line,
  claim: view.finding.claim,
  evidence: view.finding.evidence,
  state: view.state,
});

const decide = (node: Node, state: State, io: BlockIO): void => {
  const fail = (error: string) => io.finish("fail", {}, { error });
  // Each pin fills the slot derive found empty, so deriving again always moves the round on.
  const again = () => decide(node, derive(node, io), io);
  if (state.end !== null)
    return io.finish(
      state.end.port,
      {
        rounds: state.rounds.length,
        verdict: state.end.port,
        reason: state.end.reason,
        findings: state.findings.map(findingJson),
      },
      state.end.port === "fail" ? { error: state.end.reason } : {},
    );
  const target = io.namedWorkspace(node.target.workspace);
  if (target === null) return fail(`target workspace ${node.target.workspace} was never prepared`);

  const last = state.rounds.at(-1);
  if (last === undefined || last.complete) {
    io.event(`r${(last?.n ?? 0) + 1}`, {
      sha: target.headSha,
      reviewers: [...reviewersOf(node, last)],
    });
    return again();
  }
  const round = last;
  const intent = io.render(node.intent);
  if (Result.isFailure(intent)) return fail(intent.failure);

  if (round.reviews === null) {
    const rendered = io.render(node.target.baseRef);
    if (Result.isFailure(rendered)) return fail(rendered.failure);
    // The worktree started from a fetched remote tip; the same name in a reviewer's checkout is
    // the local branch, which may be behind it.
    const baseRef = target.base?.ref === rendered.success ? target.base.sha : rendered.success;
    const prior = state.rounds.at(-2);
    const entries: Json[] = [];
    let waiting = false;
    for (const i of round.reviewers) {
      const use = node.reviewers[i];
      if (use === undefined) return fail(`reviewer ${i} is not declared`);
      const model = io.model(use);
      if (Result.isFailure(model)) return fail(model.failure);
      const child = `r${round.n}/rev${i}`;
      const ws = io.workspace(`${child}/ws`, {
        project: target.project,
        baseRef: round.sha,
        branch: null,
      });
      if (ws._tag === "Failed") {
        entries.push({ reviewer: i, error: `its worktree failed: ${ws.error}`, output: null });
        continue;
      }
      if (ws._tag !== "Ready") {
        waiting = true;
        continue;
      }
      const lastReview = state.rounds
        .flatMap((r) => (r.reviews ?? []).map((review) => ({ r, review })))
        .findLast(({ review }) => review.reviewer === i && review.error === null);
      const previous =
        prior === undefined
          ? null
          : {
              sha: prior.sha,
              findings: (lastReview?.review.findings ?? []).map((finding) => ({
                finding,
                state: lastReview?.r.resolutions?.get(finding.key) ?? "no answer",
              })),
            };
      const turn = io.turn(child, {
        model: model.success,
        prompt: reviewerPrompt(intent.success, baseRef, round, previous),
        workspace: ws.workspace,
        access: "read",
        output: REVIEW_OUTPUT,
      });
      if (turn._tag === "Failed") entries.push({ reviewer: i, error: turn.error, output: null });
      else if (turn._tag !== "Settled") waiting = true;
      else if (!turn.ok)
        entries.push({
          reviewer: i,
          error: turn.error ?? `the turn ended ${turn.status}`,
          output: null,
        });
      else {
        const parsed = parseReview({ reviewer: i, output: turn.output }, node.mode === "panel");
        if (parsed !== null && parsed.error !== null) io.settleChild(child, "failed", parsed.error);
        entries.push({ reviewer: i, error: null, output: turn.output });
      }
    }
    if (waiting) return;
    for (const i of round.reviewers) {
      const ws = io.workspaceOf(`r${round.n}/rev${i}/ws`);
      if (ws._tag === "Ready") io.remove(ws.workspace);
    }
    io.event(`r${round.n}_reviews`, { reviews: entries });
    return again();
  }

  if (round.resolutions === null) {
    const lead = io.model(node.lead);
    if (Result.isFailure(lead)) return fail(lead.failure);
    const first = state.rounds.find((r) => io.turnOf(`r${r.n}/lead`)._tag !== "Absent");
    const raised = round.reviews.flatMap((r) => (r.error === null ? r.findings : []));
    const turn = io.turn(`r${round.n}/lead`, {
      model: lead.success,
      prompt: leadPrompt(intent.success, round, raised),
      workspace: target,
      access: "write",
      output: LEAD_OUTPUT,
      ...(first === undefined || first.n === round.n ? {} : { continues: `r${first.n}/lead` }),
    });
    if (turn._tag === "Failed") return fail(`the lead failed in round ${round.n}: ${turn.error}`);
    if (turn._tag !== "Settled") return;
    if (!turn.ok)
      return fail(
        `the lead failed in round ${round.n}: ${turn.error ?? `the turn ended ${turn.status}`}`,
      );
    io.event(`r${round.n}_lead`, { output: turn.output });
    return again();
  }

  const failed: string[] = [];
  let waiting = false;
  for (const [i, spec] of node.checks.entries()) {
    const unit = checkUnit(io, node, `r${round.n}/check${i}`, i, spec, target);
    if (unit._tag === "Invalid") return fail(unit.error);
    if (unit._tag === "Failed") failed.push(`check ${i}: ${unit.error}`);
    else if (unit._tag !== "Exited") waiting = true;
    else if (!unit.ok) failed.push(`check ${i} (exit ${unit.exit}): ${unit.tail}`);
  }
  if (waiting) return;
  io.event(`r${round.n}_checks`, { failed });
  return again();
};

export const interrogate: BlockDecider<"interrogate", State> = {
  derive,
  decide,
  view: (_node, state) => {
    const reviewed = state.rounds.findLast((r) => r.reviews !== null);
    return {
      _tag: "interrogate",
      step: WorkflowStepKey.make(state.step),
      round: state.rounds.length,
      verdict:
        state.end?.port ??
        (reviewed === undefined
          ? null
          : reviewed.reviews?.every(satisfied) === true
            ? "APPROVE"
            : "CHANGES"),
      findings: state.findings.map((v) => ({
        id: v.finding.key,
        summary: v.finding.claim,
        state: v.state,
      })),
    };
  },
};
