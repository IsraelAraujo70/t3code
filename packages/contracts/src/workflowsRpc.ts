/**
 * Workflows RPC group (friend fork), spread into `BOTS_RPCS` like the kanban group. Two server
 * services answer it: `WorkflowDefinitions` (the definitions repository) and `WorkflowEngine`
 * (runs). Design: docs/friend/workflows-design.md §1.5.
 */
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import { IsoDateTime, NonNegativeInt, PositiveInt } from "./baseSchemas.ts";
import {
  WorkflowCanvasLayout,
  WorkflowDefinition,
  WorkflowDiagnostic,
  WorkflowDocRevision,
  WorkflowDuration,
  WorkflowGateView,
  WorkflowHash,
  WorkflowId,
  WorkflowLedgerEntry,
  WorkflowLedgerId,
  WorkflowLedgerVerdict,
  WorkflowMetricReading,
  WorkflowRunId,
  WorkflowRunStatus,
  WorkflowRunSummary,
  WorkflowStepAttemptView,
  WorkflowStepKey,
  WorkflowStepStatus,
} from "./workflows.ts";

export class WorkflowsError extends Schema.TaggedError<WorkflowsError>()("WorkflowsError", {
  code: Schema.Literals(["not-found", "permission", "invalid-request", "unavailable", "internal"]),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

const MAX_SOURCE_LENGTH = 512 * 1024;
const WorkflowSource = Schema.String.check(Schema.isMaxLength(MAX_SOURCE_LENGTH));
const CommitMessage = Schema.String.check(Schema.isMaxLength(2_000));
/** Idempotency key of a mutation: the same key replays the first result. */
const ClientRequestId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._:-]{1,128}$/));
const WorkflowParamValue = Schema.Union([Schema.String, Schema.Number, Schema.Boolean]);
const Cursor = Schema.String.check(Schema.isMaxLength(200));
const PageLimit = PositiveInt.check(Schema.isLessThanOrEqualTo(200));

// ── Definitions ───────────────────────────────────────────────────────────────────────────────

export const WorkflowTriggerSummary = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  /** Human text: `0 3 * * * (America/Sao_Paulo)`, `tag v* on upstream`. */
  label: Schema.String,
  /** A webhook trigger's public URL once its task exists; null for other kinds. */
  webhookUrl: Schema.NullOr(Schema.String),
});
export type WorkflowTriggerSummary = typeof WorkflowTriggerSummary.Type;

export const WorkflowSummary = Schema.Struct({
  workflowId: WorkflowId,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  /** Path of the file inside the definitions repository. */
  path: Schema.String,
  valid: Schema.Boolean,
  /** The file on disk differs from its last commit (a hand edit not ingested, or an invalid one). */
  dirty: Schema.Boolean,
  enabled: Schema.Boolean,
  /** Paused by the engine (fatigue) until the user resumes it. */
  suspended: Schema.Boolean,
  diagnostics: NonNegativeInt,
  triggers: Schema.Array(WorkflowTriggerSummary),
  headCommit: Schema.NullOr(Schema.String),
  revision: Schema.NullOr(WorkflowDocRevision),
  updatedAt: Schema.NullOr(IsoDateTime),
  lastRun: Schema.NullOr(WorkflowRunSummary),
});
export type WorkflowSummary = typeof WorkflowSummary.Type;

/** A workflow whose file was deleted; `restore` brings back `commit`'s version. */
export const WorkflowDeletedSummary = Schema.Struct({
  workflowId: WorkflowId,
  title: Schema.String,
  deletedAt: IsoDateTime,
  /** The last commit that still had the file. */
  commit: Schema.String,
});
export type WorkflowDeletedSummary = typeof WorkflowDeletedSummary.Type;

/** A ready-made workflow shipped with the server; `fromTemplate` copies it into the repository. */
export const WorkflowTemplateSummary = Schema.Struct({
  templateId: WorkflowId,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  triggers: Schema.Array(WorkflowTriggerSummary),
});
export type WorkflowTemplateSummary = typeof WorkflowTemplateSummary.Type;

export const WorkflowsSnapshot = Schema.Struct({
  /** Absolute path of the definitions repository on the bots host (Settings shows it). */
  repoPath: Schema.String,
  workflows: Schema.Array(WorkflowSummary),
  deleted: Schema.Array(WorkflowDeletedSummary),
  templates: Schema.Array(WorkflowTemplateSummary),
});
export type WorkflowsSnapshot = typeof WorkflowsSnapshot.Type;

/** One workflow file as it is on disk, with what the compiler says about it. */
export const WorkflowDocument = Schema.Struct({
  workflowId: WorkflowId,
  source: Schema.String,
  /** Decoded and normalized when `valid`; null otherwise. */
  definition: Schema.NullOr(WorkflowDefinition),
  /** Blob sha of the file on disk, layout included: the precondition of every save. */
  revision: WorkflowDocRevision,
  headCommit: Schema.NullOr(Schema.String),
  hash: Schema.NullOr(WorkflowHash),
  valid: Schema.Boolean,
  dirty: Schema.Boolean,
  diagnostics: Schema.Array(WorkflowDiagnostic),
  enabled: Schema.Boolean,
  suspended: Schema.Boolean,
  /** Author of the last commit: `Israel`, `Israel (hand edit)`, `Ralph (bot)`. */
  updatedBy: Schema.NullOr(Schema.String),
  updatedAt: Schema.NullOr(IsoDateTime),
});
export type WorkflowDocument = typeof WorkflowDocument.Type;

export const WorkflowDocumentInput = Schema.Struct({ workflowId: WorkflowId });
export type WorkflowDocumentInput = typeof WorkflowDocumentInput.Type;

export const WorkflowValidateInput = Schema.Union([
  Schema.Struct({ source: WorkflowSource }),
  Schema.Struct({ definition: WorkflowDefinition }),
]);
export type WorkflowValidateInput = typeof WorkflowValidateInput.Type;

export const WorkflowValidateResult = Schema.Struct({
  diagnostics: Schema.Array(WorkflowDiagnostic),
  /** Canonical YAML; null when there are diagnostics. */
  normalizedSource: Schema.NullOr(Schema.String),
  semanticHash: Schema.NullOr(WorkflowHash),
});
export type WorkflowValidateResult = typeof WorkflowValidateResult.Type;

const SaveCommon = {
  /** When given, it must equal the definition's `id`. */
  workflowId: Schema.optional(WorkflowId),
  /** Required to replace an existing file: the revision the edit started from. Absent creates. */
  baseRevision: Schema.optional(WorkflowDocRevision),
  message: CommitMessage,
};
export const WorkflowSaveInput = Schema.Union([
  Schema.Struct({ ...SaveCommon, source: WorkflowSource }),
  Schema.Struct({
    ...SaveCommon,
    definition: WorkflowDefinition,
    /** Replaces `definition.canvas` when given. */
    canvas: Schema.optional(WorkflowCanvasLayout),
  }),
]);
export type WorkflowSaveInput = typeof WorkflowSaveInput.Type;

export const WorkflowSaved = Schema.TaggedStruct("Saved", {
  workflowId: WorkflowId,
  revision: WorkflowDocRevision,
  /** The commit holding this version; the previous one when nothing changed. */
  commit: Schema.String,
  hash: WorkflowHash,
  enabled: Schema.Boolean,
});
export type WorkflowSaved = typeof WorkflowSaved.Type;

/** The file changed since `baseRevision` (or exists when creating). Nothing was written. */
export const WorkflowSaveConflict = Schema.TaggedStruct("Conflict", {
  workflowId: WorkflowId,
  /** The version at `baseRevision` when the repository still has it, for a three-way merge. */
  base: Schema.NullOr(Schema.Struct({ revision: WorkflowDocRevision, source: Schema.String })),
  /** The file on disk now, possibly dirty and invalid. Saving with its revision replaces it. */
  current: WorkflowDocument,
});
export type WorkflowSaveConflict = typeof WorkflowSaveConflict.Type;

export const WorkflowSaveInvalid = Schema.TaggedStruct("Invalid", {
  diagnostics: Schema.Array(WorkflowDiagnostic),
});
export type WorkflowSaveInvalid = typeof WorkflowSaveInvalid.Type;

export const WorkflowSaveResult = Schema.Union([
  WorkflowSaved,
  WorkflowSaveConflict,
  WorkflowSaveInvalid,
]);
export type WorkflowSaveResult = typeof WorkflowSaveResult.Type;

export const WorkflowFromTemplateInput = Schema.Struct({
  templateId: WorkflowId,
  /** The new workflow's id; the copy's `id` is rewritten to it. */
  workflowId: WorkflowId,
});
export type WorkflowFromTemplateInput = typeof WorkflowFromTemplateInput.Type;

export const WorkflowSetEnabledInput = Schema.Struct({
  workflowId: WorkflowId,
  enabled: Schema.Boolean,
  clientRequestId: ClientRequestId,
});
export type WorkflowSetEnabledInput = typeof WorkflowSetEnabledInput.Type;

export const WorkflowDeleteInput = Schema.Struct({ workflowId: WorkflowId });
export type WorkflowDeleteInput = typeof WorkflowDeleteInput.Type;

export const WorkflowDeleteResult = Schema.Struct({
  workflowId: WorkflowId,
  commit: Schema.String,
});
export type WorkflowDeleteResult = typeof WorkflowDeleteResult.Type;

export const WorkflowRestoreInput = Schema.Struct({ workflowId: WorkflowId });
export type WorkflowRestoreInput = typeof WorkflowRestoreInput.Type;

export const WorkflowHistoryInput = Schema.Struct({
  workflowId: WorkflowId,
  cursor: Schema.optional(Cursor),
  limit: Schema.optional(PageLimit),
});
export type WorkflowHistoryInput = typeof WorkflowHistoryInput.Type;

export const WorkflowVersion = Schema.Struct({
  commit: Schema.String,
  revision: WorkflowDocRevision,
  hash: WorkflowHash,
  author: Schema.String,
  message: Schema.String,
  at: IsoDateTime,
});
export type WorkflowVersion = typeof WorkflowVersion.Type;

export const WorkflowHistoryPage = Schema.Struct({
  versions: Schema.Array(WorkflowVersion),
  nextCursor: Schema.NullOr(Cursor),
});
export type WorkflowHistoryPage = typeof WorkflowHistoryPage.Type;

// ── Runs ──────────────────────────────────────────────────────────────────────────────────────

export const WorkflowRunStartInput = Schema.Struct({
  workflowId: WorkflowId,
  params: Schema.optional(Schema.Record(Schema.String, WorkflowParamValue)),
  /** The same id with other params is an error, never the old run. */
  clientRequestId: ClientRequestId,
});
export type WorkflowRunStartInput = typeof WorkflowRunStartInput.Type;

export const WorkflowRunsListInput = Schema.Struct({
  workflowId: Schema.optional(WorkflowId),
  status: Schema.optional(WorkflowRunStatus),
  cursor: Schema.optional(Cursor),
  limit: Schema.optional(PageLimit),
});
export type WorkflowRunsListInput = typeof WorkflowRunsListInput.Type;

export const WorkflowRunsPage = Schema.Struct({
  runs: Schema.Array(WorkflowRunSummary),
  nextCursor: Schema.NullOr(Cursor),
});
export type WorkflowRunsPage = typeof WorkflowRunsPage.Type;

/** A block's live sub-state (§4). */
export const WorkflowBlockView = Schema.Union([
  Schema.TaggedStruct("hillclimb", {
    step: WorkflowStepKey,
    round: NonNegativeInt,
    /** The sha each round starts from. */
    origin: Schema.NullOr(Schema.String),
    best: Schema.NullOr(WorkflowMetricReading),
    roundsWithoutGain: NonNegativeInt,
    attempts: NonNegativeInt,
  }),
  Schema.TaggedStruct("arena", {
    step: WorkflowStepKey,
    candidates: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        status: WorkflowStepStatus,
        score: Schema.NullOr(Schema.Number),
      }),
    ),
    base: Schema.NullOr(Schema.String),
    grafts: Schema.Array(Schema.String),
  }),
  Schema.TaggedStruct("graph", {
    step: WorkflowStepKey,
    leaves: Schema.Array(
      Schema.Struct({
        id: Schema.String,
        status: WorkflowStepStatus,
        owns: Schema.Array(Schema.String),
        deps: Schema.Array(Schema.String),
        rework: NonNegativeInt,
        sha: Schema.NullOr(Schema.String),
      }),
    ),
  }),
  Schema.TaggedStruct("interrogate", {
    step: WorkflowStepKey,
    round: NonNegativeInt,
    verdict: Schema.NullOr(Schema.String),
    findings: Schema.Array(
      Schema.Struct({ id: Schema.String, summary: Schema.String, state: Schema.String }),
    ),
  }),
]);
export type WorkflowBlockView = typeof WorkflowBlockView.Type;

export const WorkflowRunGetInput = Schema.Struct({
  runId: WorkflowRunId,
  stepsCursor: Schema.optional(Cursor),
});
export type WorkflowRunGetInput = typeof WorkflowRunGetInput.Type;

/** A run with its pinned definition; `run.subscribe` sends the rest as deltas after `seq`. */
export const WorkflowRunView = Schema.Struct({
  summary: WorkflowRunSummary,
  /** The pinned version; null while queued or skipped. */
  definition: Schema.NullOr(WorkflowDefinition),
  seq: NonNegativeInt,
  steps: Schema.Array(WorkflowStepAttemptView),
  nextStepsCursor: Schema.NullOr(Cursor),
  blocks: Schema.Array(WorkflowBlockView),
  gates: Schema.Array(WorkflowGateView),
});
export type WorkflowRunView = typeof WorkflowRunView.Type;

export const WorkflowRunSubscribeInput = Schema.Struct({
  runId: WorkflowRunId,
  afterSeq: NonNegativeInt,
});
export type WorkflowRunSubscribeInput = typeof WorkflowRunSubscribeInput.Type;

/** Only the steps, blocks and gates that changed after the subscriber's `afterSeq`. */
export const WorkflowRunDelta = Schema.Struct({
  runId: WorkflowRunId,
  seq: NonNegativeInt,
  summary: WorkflowRunSummary,
  steps: Schema.Array(WorkflowStepAttemptView),
  blocks: Schema.Array(WorkflowBlockView),
  gates: Schema.Array(WorkflowGateView),
});
export type WorkflowRunDelta = typeof WorkflowRunDelta.Type;

export const WorkflowRunStepInput = Schema.Struct({
  runId: WorkflowRunId,
  step: WorkflowStepKey,
  attempt: PositiveInt,
});
export type WorkflowRunStepInput = typeof WorkflowRunStepInput.Type;

export const WorkflowStepDetail = Schema.Struct({
  view: WorkflowStepAttemptView,
  /** The step's decoded output, as the journal holds it. */
  output: Schema.NullOr(Schema.Unknown),
  /** The agent's final text (16 KiB). */
  text: Schema.NullOr(Schema.String),
  logs: Schema.Array(
    Schema.Struct({ name: Schema.String, tail: Schema.String, path: Schema.NullOr(Schema.String) }),
  ),
});
export type WorkflowStepDetail = typeof WorkflowStepDetail.Type;

export const WorkflowRunControl = Schema.Union([
  Schema.TaggedStruct("cancel", {}),
  Schema.TaggedStruct("pause", {}),
  Schema.TaggedStruct("resume", {}),
  Schema.TaggedStruct("retry", { step: WorkflowStepKey }),
  Schema.TaggedStruct("amendBudget", {
    steps: Schema.optional(PositiveInt),
    wall: Schema.optional(WorkflowDuration),
    tokens: Schema.optional(PositiveInt),
  }),
]);
export type WorkflowRunControl = typeof WorkflowRunControl.Type;

export const WorkflowRunControlInput = Schema.Struct({
  runId: WorkflowRunId,
  control: WorkflowRunControl,
  clientRequestId: ClientRequestId,
});
export type WorkflowRunControlInput = typeof WorkflowRunControlInput.Type;

export const WorkflowGateDecideInput = Schema.Struct({
  runId: WorkflowRunId,
  gateKey: Schema.String,
  option: Schema.String,
  note: Schema.optional(Schema.String.check(Schema.isMaxLength(4_000))),
});
export type WorkflowGateDecideInput = typeof WorkflowGateDecideInput.Type;

export const WorkflowMetricsInput = Schema.Struct({
  workflowId: WorkflowId,
  since: Schema.optional(IsoDateTime),
});
export type WorkflowMetricsInput = typeof WorkflowMetricsInput.Type;

export const WorkflowMetrics = Schema.Struct({
  workflowId: WorkflowId,
  since: Schema.NullOr(IsoDateTime),
  runsByStatus: Schema.Array(Schema.Struct({ status: WorkflowRunStatus, count: NonNegativeInt })),
  /** One point per run, oldest first. */
  runs: Schema.Array(
    Schema.Struct({
      runId: WorkflowRunId,
      status: WorkflowRunStatus,
      startedAt: IsoDateTime,
      activeMs: Schema.NullOr(NonNegativeInt),
      billable: NonNegativeInt,
      usdEstimate: Schema.NullOr(Schema.Number),
    }),
  ),
  nodes: Schema.Array(
    Schema.Struct({
      node: Schema.String,
      attempts: NonNegativeInt,
      failures: NonNegativeInt,
      averageBillable: Schema.NullOr(Schema.Number),
    }),
  ),
  /** Metrics the commands emit (`throughput_ratio`, …), with each point's ledger verdict. */
  series: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      points: Schema.Array(
        Schema.Struct({
          runId: WorkflowRunId,
          at: IsoDateTime,
          value: Schema.Number,
          verdict: Schema.NullOr(WorkflowLedgerVerdict),
        }),
      ),
    }),
  ),
});
export type WorkflowMetrics = typeof WorkflowMetrics.Type;

export const WorkflowLedgerInput = Schema.Struct({
  ledger: Schema.optional(WorkflowLedgerId),
  workflowId: Schema.optional(WorkflowId),
  verdict: Schema.optional(WorkflowLedgerVerdict),
  cursor: Schema.optional(Cursor),
  limit: Schema.optional(PageLimit),
});
export type WorkflowLedgerInput = typeof WorkflowLedgerInput.Type;

export const WorkflowLedgerPage = Schema.Struct({
  entries: Schema.Array(WorkflowLedgerEntry),
  nextCursor: Schema.NullOr(Cursor),
});
export type WorkflowLedgerPage = typeof WorkflowLedgerPage.Type;

// ── RPCs ──────────────────────────────────────────────────────────────────────────────────────

export const WORKFLOWS_WS_METHODS = {
  workflowsSubscribe: "bots.workflows.subscribe",
  workflowsDocumentSubscribe: "bots.workflows.document.subscribe",
  workflowsValidate: "bots.workflows.validate",
  workflowsSave: "bots.workflows.save",
  workflowsFromTemplate: "bots.workflows.fromTemplate",
  workflowsSetEnabled: "bots.workflows.setEnabled",
  workflowsDelete: "bots.workflows.delete",
  workflowsRestore: "bots.workflows.restore",
  workflowsHistory: "bots.workflows.history",
  workflowsRunStart: "bots.workflows.run.start",
  workflowsRunsList: "bots.workflows.runs.list",
  workflowsRunGet: "bots.workflows.run.get",
  workflowsRunSubscribe: "bots.workflows.run.subscribe",
  workflowsRunStep: "bots.workflows.run.step",
  workflowsRunControl: "bots.workflows.run.control",
  workflowsGateDecide: "bots.workflows.gate.decide",
  workflowsMetrics: "bots.workflows.metrics",
  workflowsLedger: "bots.workflows.ledger",
} as const;

const WorkflowsRpcError = Schema.Union([WorkflowsError, EnvironmentAuthorizationError]);
const M = WORKFLOWS_WS_METHODS;

const WorkflowsSubscribeRpc = Rpc.make(M.workflowsSubscribe, {
  payload: Schema.Struct({}),
  success: WorkflowsSnapshot,
  error: WorkflowsRpcError,
  stream: true,
});
/** Emits the document now and after every save, from any writer, and every hand edit. */
const WorkflowsDocumentSubscribeRpc = Rpc.make(M.workflowsDocumentSubscribe, {
  payload: WorkflowDocumentInput,
  success: WorkflowDocument,
  error: WorkflowsRpcError,
  stream: true,
});
const WorkflowsValidateRpc = Rpc.make(M.workflowsValidate, {
  payload: WorkflowValidateInput,
  success: WorkflowValidateResult,
  error: WorkflowsRpcError,
});
const WorkflowsSaveRpc = Rpc.make(M.workflowsSave, {
  payload: WorkflowSaveInput,
  success: WorkflowSaveResult,
  error: WorkflowsRpcError,
});
const WorkflowsFromTemplateRpc = Rpc.make(M.workflowsFromTemplate, {
  payload: WorkflowFromTemplateInput,
  success: WorkflowSaveResult,
  error: WorkflowsRpcError,
});
const WorkflowsSetEnabledRpc = Rpc.make(M.workflowsSetEnabled, {
  payload: WorkflowSetEnabledInput,
  success: WorkflowSummary,
  error: WorkflowsRpcError,
});
const WorkflowsDeleteRpc = Rpc.make(M.workflowsDelete, {
  payload: WorkflowDeleteInput,
  success: WorkflowDeleteResult,
  error: WorkflowsRpcError,
});
const WorkflowsRestoreRpc = Rpc.make(M.workflowsRestore, {
  payload: WorkflowRestoreInput,
  success: WorkflowSummary,
  error: WorkflowsRpcError,
});
const WorkflowsHistoryRpc = Rpc.make(M.workflowsHistory, {
  payload: WorkflowHistoryInput,
  success: WorkflowHistoryPage,
  error: WorkflowsRpcError,
});
const WorkflowsRunStartRpc = Rpc.make(M.workflowsRunStart, {
  payload: WorkflowRunStartInput,
  success: WorkflowRunSummary,
  error: WorkflowsRpcError,
});
const WorkflowsRunsListRpc = Rpc.make(M.workflowsRunsList, {
  payload: WorkflowRunsListInput,
  success: WorkflowRunsPage,
  error: WorkflowsRpcError,
});
/** A run id that is queued or was skipped resolves to its summary, never "not found". */
const WorkflowsRunGetRpc = Rpc.make(M.workflowsRunGet, {
  payload: WorkflowRunGetInput,
  success: WorkflowRunView,
  error: WorkflowsRpcError,
});
const WorkflowsRunSubscribeRpc = Rpc.make(M.workflowsRunSubscribe, {
  payload: WorkflowRunSubscribeInput,
  success: WorkflowRunDelta,
  error: WorkflowsRpcError,
  stream: true,
});
const WorkflowsRunStepRpc = Rpc.make(M.workflowsRunStep, {
  payload: WorkflowRunStepInput,
  success: WorkflowStepDetail,
  error: WorkflowsRpcError,
});
const WorkflowsRunControlRpc = Rpc.make(M.workflowsRunControl, {
  payload: WorkflowRunControlInput,
  success: WorkflowRunSummary,
  error: WorkflowsRpcError,
});
/** Owner-only approval of a gate: no MCP tool pairs with it, so no bot or step can decide one. */
const WorkflowsGateDecideRpc = Rpc.make(M.workflowsGateDecide, {
  payload: WorkflowGateDecideInput,
  success: WorkflowGateView,
  error: WorkflowsRpcError,
});
const WorkflowsMetricsRpc = Rpc.make(M.workflowsMetrics, {
  payload: WorkflowMetricsInput,
  success: WorkflowMetrics,
  error: WorkflowsRpcError,
});
const WorkflowsLedgerRpc = Rpc.make(M.workflowsLedger, {
  payload: WorkflowLedgerInput,
  success: WorkflowLedgerPage,
  error: WorkflowsRpcError,
});

export const WORKFLOWS_RPCS = [
  WorkflowsSubscribeRpc,
  WorkflowsDocumentSubscribeRpc,
  WorkflowsValidateRpc,
  WorkflowsSaveRpc,
  WorkflowsFromTemplateRpc,
  WorkflowsSetEnabledRpc,
  WorkflowsDeleteRpc,
  WorkflowsRestoreRpc,
  WorkflowsHistoryRpc,
  WorkflowsRunStartRpc,
  WorkflowsRunsListRpc,
  WorkflowsRunGetRpc,
  WorkflowsRunSubscribeRpc,
  WorkflowsRunStepRpc,
  WorkflowsRunControlRpc,
  WorkflowsGateDecideRpc,
  WorkflowsMetricsRpc,
  WorkflowsLedgerRpc,
] as const;

/** Writes, runs and gate decisions: guarded on clients and enforced on the server. */
export const WORKFLOWS_GUARDED_RPC_SCOPES = {
  [M.workflowsSave]: AuthOrchestrationOperateScope,
  [M.workflowsFromTemplate]: AuthOrchestrationOperateScope,
  [M.workflowsSetEnabled]: AuthOrchestrationOperateScope,
  [M.workflowsDelete]: AuthOrchestrationOperateScope,
  [M.workflowsRestore]: AuthOrchestrationOperateScope,
  [M.workflowsRunStart]: AuthOrchestrationOperateScope,
  [M.workflowsRunControl]: AuthOrchestrationOperateScope,
  // The user's session only, never a tool: bots and workflow steps never approve a gate.
  [M.workflowsGateDecide]: AuthOrchestrationOperateScope,
} as const;

export const WORKFLOWS_READ_RPC_SCOPES = {
  [M.workflowsSubscribe]: AuthOrchestrationReadScope,
  [M.workflowsDocumentSubscribe]: AuthOrchestrationReadScope,
  [M.workflowsValidate]: AuthOrchestrationReadScope,
  [M.workflowsHistory]: AuthOrchestrationReadScope,
  [M.workflowsRunsList]: AuthOrchestrationReadScope,
  [M.workflowsRunGet]: AuthOrchestrationReadScope,
  [M.workflowsRunSubscribe]: AuthOrchestrationReadScope,
  [M.workflowsRunStep]: AuthOrchestrationReadScope,
  [M.workflowsMetrics]: AuthOrchestrationReadScope,
  [M.workflowsLedger]: AuthOrchestrationReadScope,
} as const;
