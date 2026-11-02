/**
 * Run and list rules shared by the web and Android Workflows screens (friend fork): status tones,
 * the delta fold of `run.subscribe`, step rows, formatting and the run form. Design:
 * docs/friend/workflows-design.md §1.4, §8, §10.
 */
import type {
  EnvironmentId,
  WorkflowGateView,
  WorkflowParamSpec,
  WorkflowRunDelta,
  WorkflowRunId,
  WorkflowRunStatus,
  WorkflowRunView,
  WorkflowStepAttemptView,
  WorkflowStepStatus,
} from "@t3tools/contracts";

/** What a status means to the eye; each client maps a tone to its own colors. */
export type WorkflowTone = "neutral" | "info" | "success" | "warning" | "danger" | "muted";

export type WorkflowParamValue = string | number | boolean;

export interface WorkflowStepRow {
  readonly key: WorkflowStepAttemptView["key"];
  readonly node: string;
  /** The highest attempt. */
  readonly latest: WorkflowStepAttemptView;
  /** Ascending by attempt. */
  readonly attempts: ReadonlyArray<WorkflowStepAttemptView>;
}

export type ParsedRunParam =
  | { readonly ok: true; readonly value: WorkflowParamValue }
  | { readonly ok: false; readonly message: string };

/**
 * The functions this module exports, by name: `export const foldRunDelta:
 * WorkflowRunApi["foldRunDelta"] = …`.
 */
export interface WorkflowRunApi {
  readonly stepStatusTone: (status: WorkflowStepStatus) => WorkflowTone;
  readonly runStatusTone: (status: WorkflowRunStatus) => WorkflowTone;
  /** Sentence-case label: `Waiting for you`, `Timed out`. */
  readonly stepStatusLabel: (status: WorkflowStepStatus) => string;
  readonly runStatusLabel: (status: WorkflowRunStatus) => string;
  /** Queued, running or paused: the run still takes controls and deltas. */
  readonly isRunActive: (status: WorkflowRunStatus) => boolean;
  /**
   * Applies one `run.subscribe` delta: steps replace by `key`+`attempt`, blocks by `step`, gates by
   * `key`, and the summary and `seq` move forward. A delta at or below `view.seq` changes nothing.
   */
  readonly foldRunDelta: (view: WorkflowRunView, delta: WorkflowRunDelta) => WorkflowRunView;
  /**
   * One status per node id for the graph: the latest attempt of each step key, then, across the
   * instances of one node (`each[0]/x`, `each[1]/x`), the most urgent one: waiting_gate > running
   * > dispatched > failed, lost, timed_out, ambiguous > pending > cancelled > skipped > succeeded.
   */
  readonly nodeStatuses: (
    steps: ReadonlyArray<WorkflowStepAttemptView>,
  ) => ReadonlyMap<string, WorkflowStepStatus>;
  /** One row per step key, by the first attempt's start (never-started rows last, by key). */
  readonly stepRows: (
    steps: ReadonlyArray<WorkflowStepAttemptView>,
  ) => ReadonlyArray<WorkflowStepRow>;
  /** Running time of an attempt: end (or `nowMs` while it runs) minus start; null before it starts. */
  readonly stepDurationMs: (step: WorkflowStepAttemptView, nowMs: number) => number | null;
  /** `850ms`, `42s`, `4m 12s`, `2h 05m`. */
  readonly formatDuration: (ms: number) => string;
  /** `950`, `12.4k`, `3.1M`. */
  readonly formatTokens: (tokens: number) => string;
  /** `$0.42`, `<$0.01`; null is `unknown`, never `$0.00`. */
  readonly formatUsd: (usd: number | null) => string;
  /** Gates with no decision yet, oldest first. */
  readonly openGates: (gates: ReadonlyArray<WorkflowGateView>) => ReadonlyArray<WorkflowGateView>;
  /** Each param's default, or `""`/`0`/`false` by type. */
  readonly defaultRunParams: (
    params: Readonly<Record<string, WorkflowParamSpec>> | undefined,
  ) => Record<string, WorkflowParamValue>;
  /** Reads a form field as the param's type and checks its `pattern`. */
  readonly parseRunParam: (spec: WorkflowParamSpec, text: string) => ParsedRunParam;
  /** Web route of a run: `/workflows/<env>/runs/<runId>`. */
  readonly workflowRunHref: (environmentId: EnvironmentId, runId: WorkflowRunId) => string;
  /** Android tap path of a run notification (`alert_path`): `/bots/workflows/<env>/runs/<runId>`. */
  readonly workflowRunAlertPath: (environmentId: EnvironmentId, runId: WorkflowRunId) => string;
}

const stepTones = {
  pending: "muted",
  dispatched: "info",
  running: "info",
  waiting_gate: "warning",
  succeeded: "success",
  failed: "danger",
  skipped: "muted",
  cancelled: "muted",
  lost: "danger",
  timed_out: "danger",
  ambiguous: "warning",
} as const;
const runTones = {
  queued: "muted",
  skipped: "muted",
  running: "info",
  paused: "warning",
  succeeded: "success",
  failed: "danger",
  cancelled: "muted",
  budget_exhausted: "warning",
} as const;
export const stepStatusTone: WorkflowRunApi["stepStatusTone"] = (status) => stepTones[status];
export const runStatusTone: WorkflowRunApi["runStatusTone"] = (status) => runTones[status];
export const stepStatusLabel: WorkflowRunApi["stepStatusLabel"] = (status) =>
  ({
    pending: "Pending",
    dispatched: "Dispatched",
    running: "Running",
    waiting_gate: "Waiting for you",
    succeeded: "Succeeded",
    failed: "Failed",
    skipped: "Skipped",
    cancelled: "Cancelled",
    lost: "Lost",
    timed_out: "Timed out",
    ambiguous: "Ambiguous",
  })[status];
export const runStatusLabel: WorkflowRunApi["runStatusLabel"] = (status) =>
  ({
    queued: "Queued",
    skipped: "Skipped",
    running: "Running",
    paused: "Paused",
    succeeded: "Succeeded",
    failed: "Failed",
    cancelled: "Cancelled",
    budget_exhausted: "Budget exhausted",
  })[status];
export const isRunActive: WorkflowRunApi["isRunActive"] = (status) =>
  ["queued", "running", "paused"].includes(status);
function upsert<T>(old: readonly T[], incoming: readonly T[], key: (item: T) => string): T[] {
  const result = [...old];
  for (const item of incoming) {
    const index = result.findIndex((value) => key(value) === key(item));
    if (index < 0) result.push(item);
    else result[index] = item;
  }
  return result;
}
export const foldRunDelta: WorkflowRunApi["foldRunDelta"] = (view, delta) =>
  delta.seq <= view.seq
    ? view
    : {
        ...view,
        summary: delta.summary,
        seq: delta.seq,
        steps: upsert(view.steps, delta.steps, (s) => JSON.stringify([s.key, s.attempt])),
        blocks: upsert(view.blocks, delta.blocks, (b) => b.step),
        gates: upsert(view.gates, delta.gates, (g) => g.key),
      };
export const stepRows: WorkflowRunApi["stepRows"] = (steps) => {
  const groups = new Map<string, WorkflowStepAttemptView[]>();
  for (const step of steps) {
    const group = groups.get(step.key) ?? [];
    group.push(step);
    groups.set(step.key, group);
  }
  const rows = [...groups.values()].map((attempts) => {
    attempts.sort((a, b) => a.attempt - b.attempt);
    const latest = attempts[attempts.length - 1]!;
    return { key: latest.key, node: latest.node, latest, attempts };
  });
  const start = (row: WorkflowStepRow) =>
    row.attempts.flatMap((a) => (a.startedAt === null ? [] : [a.startedAt])).sort()[0];
  return rows.sort((a, b) => {
    const x = start(a),
      y = start(b);
    return x === y
      ? a.key.localeCompare(b.key)
      : x === undefined
        ? 1
        : y === undefined
          ? -1
          : x.localeCompare(y);
  });
};
export const nodeStatuses: WorkflowRunApi["nodeStatuses"] = (steps) => {
  const rank: Record<WorkflowStepStatus, number> = {
    waiting_gate: 0,
    running: 1,
    dispatched: 2,
    failed: 3,
    lost: 3,
    timed_out: 3,
    ambiguous: 3,
    pending: 4,
    cancelled: 5,
    skipped: 6,
    succeeded: 7,
  };
  const result = new Map<string, WorkflowStepStatus>();
  for (const { latest } of stepRows(steps)) {
    const current = result.get(latest.node);
    if (current === undefined || rank[latest.status] < rank[current])
      result.set(latest.node, latest.status);
  }
  return result;
};
export const stepDurationMs: WorkflowRunApi["stepDurationMs"] = (step, nowMs) =>
  step.startedAt === null
    ? null
    : Math.max(
        0,
        (step.endedAt === null ? nowMs : Date.parse(step.endedAt)) - Date.parse(step.startedAt),
      );
export const formatDuration: WorkflowRunApi["formatDuration"] = (ms) => {
  const seconds = Math.floor(ms / 1000);
  return ms < 1000
    ? `${Math.floor(ms)}ms`
    : seconds < 60
      ? `${seconds}s`
      : seconds < 3600
        ? `${Math.floor(seconds / 60)}m ${seconds % 60}s`
        : `${Math.floor(seconds / 3600)}h ${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}m`;
};
export const formatTokens: WorkflowRunApi["formatTokens"] = (tokens) =>
  tokens < 1000
    ? String(Math.floor(tokens))
    : `${(tokens / (tokens < 1e6 ? 1000 : 1e6)).toFixed(1).replace(/\.0$/, "")}${tokens < 1e6 ? "k" : "M"}`;
export const formatUsd: WorkflowRunApi["formatUsd"] = (usd) =>
  usd === null ? "unknown" : usd > 0 && usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
export const openGates: WorkflowRunApi["openGates"] = (gates) =>
  gates.filter((g) => g.decision === null).sort((a, b) => a.openedAt.localeCompare(b.openedAt));
export const defaultRunParams: WorkflowRunApi["defaultRunParams"] = (params) =>
  Object.fromEntries(
    Object.entries(params ?? {}).map(([key, spec]) => [
      key,
      spec.default ?? (spec.type === "string" ? "" : spec.type === "number" ? 0 : false),
    ]),
  );
export const parseRunParam: WorkflowRunApi["parseRunParam"] = (spec, text) => {
  if (spec.type === "number")
    return text.trim() !== "" && Number.isFinite(Number(text.trim()))
      ? { ok: true, value: Number(text.trim()) }
      : { ok: false, message: "Enter a number." };
  if (spec.type === "boolean")
    return /^(true|false)$/i.test(text)
      ? { ok: true, value: text.toLowerCase() === "true" }
      : { ok: false, message: "Enter true or false." };
  if (spec.pattern !== undefined) {
    try {
      if (!new RegExp(`^(?:${spec.pattern})$`).test(text))
        return { ok: false, message: `Doesn't match ${spec.pattern}.` };
    } catch {
      return { ok: false, message: "Invalid pattern." };
    }
  }
  return { ok: true, value: text };
};
export const workflowRunHref: WorkflowRunApi["workflowRunHref"] = (env, id) =>
  `/workflows/${encodeURIComponent(env)}/runs/${id}`;
export const workflowRunAlertPath: WorkflowRunApi["workflowRunAlertPath"] = (env, id) =>
  `/bots${workflowRunHref(env, id)}`;
