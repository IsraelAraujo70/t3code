import {
  isWorkflowStepThreadId,
  OrchestratorMcpFailure,
  type WorkflowsError,
  type OrchestrationV2ConversationMessage,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import type { Toolkit } from "effect/ai";
import { ServerEnvironment } from "../../../environment/ServerEnvironment.ts";
import * as McpInvocationContext from "../../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../../mcp/McpToolAccess.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as BotsService from "../../BotsService.ts";
import * as WorkflowDefinitions from "../definitions/WorkflowDefinitions.ts";
import { workflowRunWebPath } from "../notices/notices.ts";
import { WorkflowEngine } from "../WorkflowEngine.ts";
import { WorkflowToolkit } from "./tools.ts";

/** Whether the opening message was typed by the owner in a client. */
export const isOwnerMessage = (
  message: Pick<
    OrchestrationV2ConversationMessage,
    "createdBy" | "creationSource" | "scheduledTaskId" | "senderThreadId"
  >,
): boolean =>
  message.createdBy === "user" &&
  (message.creationSource === "web" || message.creationSource === "mobile") &&
  message.scheduledTaskId === undefined &&
  message.senderThreadId === undefined;

type Projections = Context.Service.Shape<typeof ProjectionStore.ProjectionStoreV2>;

/** Whether the caller's running turn opened with the owner's own message. Any doubt is false. */
const ownerTurnFrom = Effect.fn("WorkflowHandlers.ownerTurn")(
  function* (projections: Projections) {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    if (!scope.thread) return false;
    const { run } = yield* projections.getRunningTurnContext(scope.thread.threadId);
    if (!run) return false;
    const message = yield* projections.getRunMessage(scope.thread.threadId, run.id);
    return message !== undefined && isOwnerMessage(message);
  },
  Effect.orElseSucceed(() => false),
);

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
const callerBot = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const denied = new OrchestratorMcpFailure({
    code: "capability_denied",
    message: "Workflow tools are only available in a bot's conversation.",
  });
  if (!scope.thread) return yield* denied;
  if (isWorkflowStepThreadId(scope.thread.threadId))
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
const engineAvailable = Effect.gen(function* () {
  const engine = yield* Effect.serviceOption(WorkflowEngine);
  if (Option.isSome(engine)) return engine.value;
  return yield* new OrchestratorMcpFailure({
    code: "provider_unavailable",
    message: "The workflow engine is not available on this server yet.",
  });
});
const runFailure = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "Workflow run operation failed.",
  });
const requestId = Effect.gen(function* () {
  const at = yield* Clock.currentTimeMillis;
  const nonce = (yield* Random.nextIntBetween(0, 0xffffffff)).toString(16);
  return `mcp-${at}-${nonce}`;
});
const manage = (allowed: boolean) =>
  allowed
    ? Effect.void
    : Effect.fail(
        new OrchestratorMcpFailure({
          code: "capability_denied",
          message: "This bot does not have permission to manage bots.",
        }),
      );
type WorkflowTools = typeof WorkflowToolkit extends Toolkit.Toolkit<infer Tools> ? Tools : never;

const handlers = (
  ownerTurn: ReturnType<typeof ownerTurnFrom>,
): McpToolAccess.Handlers<WorkflowTools> => ({
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
          { ...author, canManageBots: author.canManageBots || (yield* ownerTurn) },
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
      const mayManage = author.canManageBots || (yield* ownerTurn);
      const definitions = yield* WorkflowDefinitions.WorkflowDefinitions;
      const nonce = (yield* Random.nextIntBetween(0, 0xffffffff)).toString(16);
      const at = yield* Clock.currentTimeMillis;
      const summary = yield* definitions
        .setEnabled(
          { ...input, clientRequestId: `mcp-${at}-${nonce}` },
          { ...author, canManageBots: mayManage },
        )
        .pipe(Effect.mapError(failure));
      return { enabled: summary.enabled };
    }),
  ),
  workflow_run: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { bot } = yield* callerBot;
      yield* manage(bot.canManageBots || (yield* ownerTurn));
      const engine = yield* engineAvailable;
      const id = input.clientRequestId ?? (yield* requestId);
      const { runId } = yield* engine
        .start({
          workflowId: input.workflowId,
          triggerId: "bot",
          kind: "bot",
          occurrence: `bot:${bot.id}:${id}`,
          label: `Run by ${bot.name} (bot)`,
          params: input.params ?? {},
          payload: null,
          causalDepth: 0,
          parent: null,
        })
        .pipe(Effect.mapError(runFailure));
      const { summary } = yield* engine.runView({ runId }).pipe(Effect.mapError(runFailure));
      return {
        runId,
        status: summary.status,
        link: workflowRunWebPath(yield* (yield* ServerEnvironment).getEnvironmentId, runId),
      };
    }),
  ),
  workflow_runs: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      yield* callerBot;
      const engine = yield* engineAvailable;
      const { runs } = yield* engine.listRuns(input).pipe(Effect.mapError(runFailure));
      return { runs };
    }),
  ),
  workflow_run_status: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      yield* callerBot;
      const engine = yield* engineAvailable;
      const { summary, steps, gates } = yield* engine
        .runView(input)
        .pipe(Effect.mapError(runFailure));
      return {
        summary,
        steps: steps.map(({ key, status, summary }) => ({ key, status, summary })),
        gates: gates.map((g) => ({
          key: g.key,
          ask: g.ask,
          options: g.options,
          decided: g.decision?.option ?? null,
        })),
      };
    }),
  ),
  workflow_run_cancel: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { bot } = yield* callerBot;
      yield* manage(bot.canManageBots || (yield* ownerTurn));
      const engine = yield* engineAvailable;
      const summary = yield* engine
        .controlRun(
          { runId: input.runId, control: { _tag: "cancel" }, clientRequestId: yield* requestId },
          `${bot.name} (bot)`,
        )
        .pipe(Effect.mapError(runFailure));
      return { status: summary.status };
    }),
  ),
  workflow_ledger: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      yield* callerBot;
      const engine = yield* engineAvailable;
      const { entries } = yield* engine.ledger(input).pipe(Effect.mapError(runFailure));
      return { entries };
    }),
  ),
});

/** The handlers over a given projection store; tests pass their own. */
export const layerOver = (projections: Projections) =>
  McpToolAccess.toLayer(WorkflowToolkit, handlers(ownerTurnFrom(projections)));

export const layer = McpToolAccess.toLayer(
  WorkflowToolkit,
  Effect.gen(function* () {
    return handlers(ownerTurnFrom(yield* ProjectionStore.ProjectionStoreV2));
  }).pipe(Effect.provide(ProjectionStore.layer)),
);
