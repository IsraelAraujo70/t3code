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
