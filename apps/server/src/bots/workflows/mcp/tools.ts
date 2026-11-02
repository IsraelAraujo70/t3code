/**
 * Workflow tools for bots (design §6). The handlers call the same `WorkflowDefinitions` and
 * `WorkflowEngine` methods as the RPCs. No tool decides a gate.
 */
import {
  OrchestratorMcpFailure,
  WorkflowDiagnostic,
  WorkflowDocRevision,
  WorkflowHash,
  WorkflowId,
  WorkflowLedgerEntry,
  WorkflowLedgerId,
  WorkflowLedgerVerdict,
  WorkflowRunId,
  WorkflowRunStatus,
  WorkflowRunSummary,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as BotsService from "../../BotsService.ts";
import * as WorkflowDefinitions from "../definitions/WorkflowDefinitions.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    BotsService.BotsService,
    WorkflowDefinitions.WorkflowDefinitions,
  ],
};

const WORKFLOW_LIST_LIMIT = 50;

const Limit = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: WORKFLOW_LIST_LIMIT }));
const ParamValue = Schema.Union([Schema.String, Schema.Number, Schema.Boolean]);

const WorkflowListTool = Tool.make("workflow_list", {
  ...shared,
  description: "List the workflows on the bots host, with validity, on/off state and triggers.",
  parameters: Schema.Struct({ includeTemplates: Schema.optional(Schema.Boolean) }),
  success: Schema.Struct({
    workflows: Schema.Array(
      Schema.Struct({
        id: WorkflowId,
        title: Schema.String,
        valid: Schema.Boolean,
        enabled: Schema.Boolean,
        triggers: Schema.Array(Schema.String),
        lastRun: Schema.NullOr(Schema.Struct({ runId: WorkflowRunId, status: WorkflowRunStatus })),
      }),
    ),
    templates: Schema.optional(
      Schema.Array(Schema.Struct({ id: WorkflowId, title: Schema.String })),
    ),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const WorkflowGetTool = Tool.make("workflow_get", {
  ...shared,
  description: "Read a workflow's YAML source, its revision, and its diagnostics.",
  parameters: Schema.Struct({ workflowId: WorkflowId }),
  success: Schema.Struct({
    source: Schema.String,
    revision: WorkflowDocRevision,
    hash: Schema.NullOr(WorkflowHash),
    valid: Schema.Boolean,
    diagnostics: Schema.Array(WorkflowDiagnostic),
    enabled: Schema.Boolean,
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const WorkflowSaveTool = Tool.make("workflow_save", {
  ...shared,
  description:
    "Save a workflow from its YAML source. Saving commits the file to the workflow repository. `dryRun: true` only validates. Pass `baseRevision` to replace an existing workflow.",
  parameters: Schema.Struct({
    workflowId: Schema.optional(WorkflowId),
    source: Schema.String,
    baseRevision: Schema.optional(WorkflowDocRevision),
    message: Schema.String,
    dryRun: Schema.optional(Schema.Boolean),
  }),
  success: Schema.Struct({
    ok: Schema.Boolean,
    workflowId: Schema.optional(WorkflowId),
    revision: Schema.optional(WorkflowDocRevision),
    commit: Schema.optional(Schema.String),
    enabled: Schema.optional(Schema.Boolean),
    diagnostics: Schema.Array(WorkflowDiagnostic),
    /** The file changed since `baseRevision`: what is on disk now. */
    conflict: Schema.optional(
      Schema.Struct({ revision: WorkflowDocRevision, source: Schema.String }),
    ),
  }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);

const WorkflowSetEnabledTool = Tool.make("workflow_set_enabled", {
  ...shared,
  description: "Turn a workflow's triggers on or off.",
  parameters: Schema.Struct({ workflowId: WorkflowId, enabled: Schema.Boolean }),
  success: Schema.Struct({ enabled: Schema.Boolean }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const WorkflowRunTool = Tool.make("workflow_run", {
  ...shared,
  description: "Start a run of a workflow.",
  parameters: Schema.Struct({
    workflowId: WorkflowId,
    params: Schema.optional(Schema.Record(Schema.String, ParamValue)),
    clientRequestId: Schema.optional(Schema.String),
  }),
  success: Schema.Struct({ runId: WorkflowRunId, status: WorkflowRunStatus, link: Schema.String }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false);

const WorkflowRunsTool = Tool.make("workflow_runs", {
  ...shared,
  description: "List recent workflow runs.",
  parameters: Schema.Struct({
    workflowId: Schema.optional(WorkflowId),
    status: Schema.optional(WorkflowRunStatus),
    limit: Schema.optional(Limit),
  }),
  success: Schema.Struct({ runs: Schema.Array(WorkflowRunSummary) }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const WorkflowRunStatusTool = Tool.make("workflow_run_status", {
  ...shared,
  description: "Read a run's status, its steps, and any open gates.",
  parameters: Schema.Struct({ runId: WorkflowRunId }),
  success: Schema.Struct({
    summary: WorkflowRunSummary,
    steps: Schema.Array(
      Schema.Struct({
        key: Schema.String,
        status: Schema.String,
        summary: Schema.NullOr(Schema.String),
      }),
    ),
    gates: Schema.Array(
      Schema.Struct({
        key: Schema.String,
        ask: Schema.String,
        options: Schema.Array(Schema.String),
        decided: Schema.NullOr(Schema.String),
      }),
    ),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const WorkflowRunCancelTool = Tool.make("workflow_run_cancel", {
  ...shared,
  description: "Cancel a running workflow run.",
  parameters: Schema.Struct({ runId: WorkflowRunId }),
  success: Schema.Struct({ status: WorkflowRunStatus }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true);

const WorkflowLedgerTool = Tool.make("workflow_ledger", {
  ...shared,
  description: "Read ledger entries: hypotheses tried by workflows and their verdicts.",
  parameters: Schema.Struct({
    ledger: Schema.optional(WorkflowLedgerId),
    workflowId: Schema.optional(WorkflowId),
    verdict: Schema.optional(WorkflowLedgerVerdict),
    limit: Schema.optional(Limit),
  }),
  success: Schema.Struct({ entries: Schema.Array(WorkflowLedgerEntry) }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

export const WorkflowToolkit = Toolkit.make(
  WorkflowListTool,
  WorkflowGetTool,
  WorkflowSaveTool,
  WorkflowSetEnabledTool,
  WorkflowRunTool,
  WorkflowRunsTool,
  WorkflowRunStatusTool,
  WorkflowRunCancelTool,
  WorkflowLedgerTool,
);
