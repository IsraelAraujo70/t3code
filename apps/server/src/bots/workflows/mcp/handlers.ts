import { OrchestratorMcpFailure, type WorkflowsError } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import * as BotsService from "../../BotsService.ts";
import * as WorkflowDefinitions from "../definitions/WorkflowDefinitions.ts";
import { WorkflowToolkit } from "./tools.ts";

const failure = (error: WorkflowsError) =>
  new OrchestratorMcpFailure({
    code:
      error.code === "permission"
        ? "capability_denied"
        : error.code === "not-found" || error.code === "invalid-request"
          ? "invalid_request"
          : "orchestration_error",
    message: error.message,
  });
// Replaced by isWorkflowStepThreadId from @t3tools/contracts when the hide work lands.
const isWorkflowStepThread = (threadId: string) => threadId.startsWith("wf:");
const callerBot = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const denied = new OrchestratorMcpFailure({
    code: "capability_denied",
    message: "Workflow tools are only available in a bot's conversation.",
  });
  if (!scope.thread) return yield* denied;
  if (isWorkflowStepThread(scope.thread.threadId))
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message:
        "Workflow tools are not available inside a workflow step: a workflow does not edit, run or cancel workflows.",
    });
  const bots = yield* BotsService.BotsService;
  const bot = yield* bots
    .botForThread(scope.thread.threadId)
    .pipe(
      Effect.mapError(
        (error) =>
          new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
      ),
    );
  if (Option.isNone(bot)) return yield* denied;
  return {
    bot: bot.value,
    author: { kind: "bot" as const, name: bot.value.name, canManageBots: bot.value.canManageBots },
  };
});
const engineUnavailable = Effect.gen(function* () {
  yield* callerBot;
  return yield* new OrchestratorMcpFailure({
    code: "provider_unavailable",
    message: "The workflow engine is not available on this server yet.",
  });
});
export const layer = McpToolAccess.toLayer(WorkflowToolkit, {
  workflow_list: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      yield* callerBot;
      const definitions = yield* WorkflowDefinitions.WorkflowDefinitions;
      const workflows = (yield* definitions.list.pipe(Effect.mapError(failure))).map((w) => ({
        id: w.workflowId,
        title: w.title,
        valid: w.valid,
        enabled: w.enabled,
        triggers: w.triggers.map((t) => t.label),
        lastRun: w.lastRun ? { runId: w.lastRun.runId, status: w.lastRun.status } : null,
      }));
      if (!input.includeTemplates) return { workflows };
      const snapshot = yield* Stream.runHead(definitions.snapshot).pipe(Effect.mapError(failure));
      return {
        workflows,
        templates: Option.isSome(snapshot)
          ? snapshot.value.templates.map((t) => ({ id: t.templateId, title: t.title }))
          : [],
      };
    }),
  ),
  workflow_get: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      yield* callerBot;
      const definitions = yield* WorkflowDefinitions.WorkflowDefinitions;
      const d = yield* definitions.document(input.workflowId).pipe(Effect.mapError(failure));
      return {
        source: d.source,
        revision: d.revision,
        hash: d.hash,
        valid: d.valid,
        diagnostics: d.diagnostics,
        enabled: d.enabled,
      };
    }),
  ),
  workflow_template: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      yield* callerBot;
      const definitions = yield* WorkflowDefinitions.WorkflowDefinitions;
      return {
        source: yield* definitions.template(input.templateId).pipe(Effect.mapError(failure)),
      };
    }),
  ),
  workflow_save: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { author } = yield* callerBot;
      const definitions = yield* WorkflowDefinitions.WorkflowDefinitions;
      if (input.dryRun) {
        const { diagnostics } = yield* definitions
          .validate({ source: input.source })
          .pipe(Effect.mapError(failure));
        return { ok: diagnostics.length === 0, diagnostics };
      }
      const result = yield* definitions
        .save(
          {
            source: input.source,
            message: input.message,
            ...(input.workflowId !== undefined ? { workflowId: input.workflowId } : {}),
            ...(input.baseRevision !== undefined ? { baseRevision: input.baseRevision } : {}),
          },
          author,
        )
        .pipe(Effect.mapError(failure));
      switch (result._tag) {
        case "Saved":
          return {
            ok: true,
            workflowId: result.workflowId,
            revision: result.revision,
            commit: result.commit,
            enabled: result.enabled,
            diagnostics: [],
          };
        case "Invalid":
          return { ok: false, diagnostics: result.diagnostics };
        case "Conflict":
          return {
            ok: false,
            diagnostics: [],
            conflict: { revision: result.current.revision, source: result.current.source },
          };
      }
    }),
  ),
  workflow_set_enabled: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { author } = yield* callerBot;
      const definitions = yield* WorkflowDefinitions.WorkflowDefinitions;
      const nonce = (yield* Random.nextIntBetween(0, 0xffffffff)).toString(16);
      const at = yield* Clock.currentTimeMillis;
      const summary = yield* definitions
        .setEnabled({ ...input, clientRequestId: `mcp-${at}-${nonce}` }, author)
        .pipe(Effect.mapError(failure));
      return { enabled: summary.enabled };
    }),
  ),
  workflow_run: McpToolAccess.actsAsCaller(() => engineUnavailable),
  workflow_runs: McpToolAccess.readsAsCaller(() => engineUnavailable),
  workflow_run_status: McpToolAccess.readsAsCaller(() => engineUnavailable),
  workflow_run_cancel: McpToolAccess.actsAsCaller(() => engineUnavailable),
  workflow_ledger: McpToolAccess.readsAsCaller(() => engineUnavailable),
});
