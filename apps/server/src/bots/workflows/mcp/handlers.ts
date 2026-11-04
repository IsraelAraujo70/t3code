import { decodeRunParams } from "@t3tools/shared/workflows";
import {
  isWorkflowStepThreadId,
  OrchestratorMcpFailure,
  WORKFLOW_POST_MESSAGE_PREFIX,
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
import { keyHash } from "../ids.ts";
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

/**
 * Whether a message is the engine's own post of a gate's ask (`ask:<gateKey>`, see BotPosts): the
 * server wrote it, not another agent relaying it.
 */
export const isGateAsk = (
  message: Pick<
    OrchestrationV2ConversationMessage,
    "id" | "createdBy" | "creationSource" | "scheduledTaskId" | "senderThreadId"
  >,
  runId: string,
  gateKey: string,
): boolean =>
  message.id === `${WORKFLOW_POST_MESSAGE_PREFIX}${keyHash(runId, `ask:${gateKey}`)}` &&
  message.createdBy === "agent" &&
  message.creationSource === "server" &&
  message.scheduledTaskId === undefined &&
  message.senderThreadId === undefined;

/**
 * The caller's running turn: the message that opened it and whether another agent's message
 * (`t3_thread_send` from another thread, or an agent's MCP send) was delivered into it since,
 * as a steer. Any doubt is undefined.
 */
interface TurnOrigin {
  readonly opener: OrchestrationV2ConversationMessage;
  readonly relayed: ReadonlyArray<OrchestrationV2ConversationMessage>;
}

const turnOriginFrom = Effect.fn("WorkflowHandlers.turnOrigin")(
  function* (projections: Projections) {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    if (!scope.thread) return undefined;
    const threadId = scope.thread.threadId;
    const { run } = yield* projections.getRunningTurnContext(threadId);
    if (!run) return undefined;
    const opener = yield* projections.getRunMessage(threadId, run.id);
    if (opener === undefined) return undefined;
    // A steer joins the running turn under the same run: every message the run holds counts.
    const { messages } = yield* projections.getThreadRecords(threadId, ["messages"], {
      messageRunIds: [run.id],
      messageRoles: ["user"],
    });
    const relayed = messages.filter(
      (message) =>
        (message.senderThreadId !== undefined && message.senderThreadId !== threadId) ||
        (message.createdBy === "agent" && message.creationSource === "mcp"),
    );
    return { opener, relayed } satisfies TurnOrigin;
  },
  Effect.orElseSucceed((): TurnOrigin | undefined => undefined),
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
    author: {
      kind: "bot" as const,
      id: bot.value.id,
      name: bot.value.name,
      canManageBots: bot.value.canManageBots,
    },
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
  turnOrigin: ReturnType<typeof turnOriginFrom>,
): McpToolAccess.Handlers<WorkflowTools> => {
  /** Whether the owner's own message opened the caller's turn and no other agent steered it. */
  const ownerTurn = turnOrigin.pipe(
    Effect.map(
      (origin) =>
        origin !== undefined && isOwnerMessage(origin.opener) && origin.relayed.length === 0,
    ),
  );
  return {
    workflow_list: McpToolAccess.readsAsCaller((input) =>
      Effect.gen(function* () {
        const { bot } = yield* callerBot;
        const definitions = yield* WorkflowDefinitions.WorkflowDefinitions;
        const entries = yield* definitions.botEntries(bot.id).pipe(Effect.mapError(failure));
        const workflows = (yield* definitions.list.pipe(Effect.mapError(failure))).map((w) => ({
          id: w.workflowId,
          title: w.title,
          valid: w.valid,
          enabled: w.enabled,
          triggers: w.triggers.map((t) => t.label),
          bot: (() => {
            const entry = entries.find((entry) => entry.workflowId === w.workflowId);
            return entry
              ? {
                  trigger: entry.triggerId,
                  description: entry.description,
                  on: entry.on,
                  params: Object.fromEntries(
                    Object.entries(entry.params).map(([name, spec]) => [
                      name,
                      { ...spec, required: spec.default === undefined },
                    ]),
                  ),
                }
              : null;
          })(),
          lastRun: w.lastRun ? { runId: w.lastRun.runId, status: w.lastRun.status } : null,
        }));
        if (!input.includeTemplates) return { you: bot.id, workflows };
        const snapshot = yield* Stream.runHead(definitions.snapshot).pipe(Effect.mapError(failure));
        return {
          you: bot.id,
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
            .validate({ source: input.source }, author)
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
        const definitions = yield* WorkflowDefinitions.WorkflowDefinitions;
        const entries = yield* definitions.botEntries(bot.id).pipe(Effect.mapError(failure));
        const entry = entries.find((entry) => entry.workflowId === input.workflowId);
        if (!entry) {
          const document = yield* definitions
            .document(input.workflowId)
            .pipe(Effect.mapError(failure));
          const hasBotTrigger = Object.values(document.definition?.triggers ?? {}).some(
            (trigger) => trigger.kind === "bot",
          );
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message: hasBotTrigger
              ? "This workflow's bot trigger does not allow this bot."
              : "This workflow has no bot trigger, so no bot can run it. The owner can add one in the workflow editor.",
          });
        }
        yield* manage(bot.canManageBots || (yield* ownerTurn));
        const decoded = decodeRunParams(entry.params, input.params ?? {});
        if (!decoded.ok)
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: decoded.errors.map((error) => error.message).join("; "),
          });
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const engine = yield* engineAvailable;
        const id = input.clientRequestId ?? (yield* requestId);
        const { runId } = yield* engine
          .start({
            workflowId: input.workflowId,
            triggerId: entry.triggerId,
            kind: "bot",
            occurrence: `bot:${bot.id}:${id}`,
            label: `Run by ${bot.name} (bot)`,
            params: decoded.params,
            payload: {
              bot: { id: bot.id, name: bot.name },
              threadId: scope.thread?.threadId ?? null,
            },
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
        const { bot } = yield* callerBot;
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
            routedToYou: g.bot === bot.id,
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
    workflow_gate_decide: McpToolAccess.actsAsCaller((input) =>
      Effect.gen(function* () {
        const { bot } = yield* callerBot;
        // Only the turn the gate's own ask started, or one the owner started, and no other
        // agent's message in it: a relay or steer (`t3_thread_send`) cannot make the bot decide.
        const origin = yield* turnOrigin;
        if (
          origin === undefined ||
          origin.relayed.length > 0 ||
          !(isOwnerMessage(origin.opener) || isGateAsk(origin.opener, input.runId, input.gateKey))
        )
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message:
              "A bot decides a gate only in the turn that gate's ask started, or in one the owner started.",
          });
        const engine = yield* engineAvailable;
        // The engine refuses a gate the run did not route to this bot: protected and ambiguous
        // gates, Israel's own and another workflow's bot's alike.
        const decision = yield* engine
          .decideGate({
            runId: input.runId,
            gateKey: input.gateKey,
            option: input.option,
            note: input.answer ?? null,
            bot: bot.id,
          })
          .pipe(
            Effect.mapError(
              (error) =>
                new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
            ),
          );
        return {
          gateKey: decision.gateKey,
          option: decision.option,
          by: decision.by,
          decidedByYou: decision.by === `bot:${bot.id}`,
        };
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
  };
};

/** The handlers over a given projection store; tests pass their own. */
export const layerOver = (projections: Projections) =>
  McpToolAccess.toLayer(WorkflowToolkit, handlers(turnOriginFrom(projections)));

export const layer = McpToolAccess.toLayer(
  WorkflowToolkit,
  Effect.gen(function* () {
    return handlers(turnOriginFrom(yield* ProjectionStore.ProjectionStoreV2));
  }).pipe(Effect.provide(ProjectionStore.layer)),
);
