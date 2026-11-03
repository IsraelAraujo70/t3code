/**
 * Starts work on a ticket: a new thread in its T3 project, or a message to a bot's conversation,
 * carrying the issue as context, then links that thread to the ticket. Kept apart from
 * KanbanService because it needs the orchestration runtime, which the kanban's store and sync do not.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import {
  botThreadId,
  CommandId,
  KanbanError,
  MessageId,
  ThreadId,
  type KanbanTicket,
  type KanbanTicketStartThreadInput,
  type KanbanTicketStartThreadResult,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  type ThreadEnvMode,
  type VcsListRefsResult,
} from "@t3tools/contracts";
import { randomUuidV4 } from "@t3tools/provider-core/server/randomUuid";
import { resolveProjectSettings, resolveSendEnvMode } from "@t3tools/shared/projectSettings";

import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunch from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadMessageIntake from "../../orchestration-v2/ThreadMessageIntake.ts";
import * as DocumentText from "../../provider/DocumentText.ts";
import * as Project from "../../project/ProjectService.ts";
import * as T3ProjectFileLoader from "../../project/T3ProjectFileLoader.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ServerConfig from "../../config.ts";
import { BotsStore } from "../BotsStore.ts";
import { KanbanService } from "./KanbanService.ts";

/**
 * The first message of a ticket's thread: where it comes from, the issue (identifier, title, Linear
 * link), its description and the user's note, in plain markdown.
 */
export function buildTicketThreadMessage(
  ticket: Pick<KanbanTicket, "identifier" | "title" | "linear">,
  description: string | null,
  note: string | undefined,
): string {
  const head = [
    `Kanban ticket ${ticket.identifier} (${ticket.linear === null ? "local ticket" : "Linear issue"})`,
    `${ticket.identifier}: ${ticket.title}`,
    ...(ticket.linear === null ? [] : [ticket.linear.url]),
  ].join("\n");
  return [head, description?.trim(), note?.trim()].filter(Boolean).join("\n\n");
}

/**
 * The base a new worktree starts from: the repository's default branch, as the web's base branch
 * picker preselects it, else a local `main` or `master`. Never the checkout's current branch, which
 * may carry another ticket's work.
 */
export function defaultWorktreeBase(refs: VcsListRefsResult["refs"]): string | null {
  return (
    refs.find((ref) => ref.isDefault)?.name ??
    ["main", "master"].find((name) => refs.some((ref) => !ref.isRemote && ref.name === name)) ??
    null
  );
}

export class KanbanThreadStarter extends Context.Service<
  KanbanThreadStarter,
  {
    readonly startThread: (
      input: KanbanTicketStartThreadInput,
    ) => Effect.Effect<KanbanTicketStartThreadResult, KanbanError>;
  }
>()("t3/bots/kanban/KanbanThreadStarter") {}

const make = Effect.gen(function* () {
  const kanban = yield* KanbanService;
  const store = yield* BotsStore;
  const projects = yield* Project.ProjectService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const engine = yield* Orchestrator.OrchestratorV2;
  const git = yield* GitWorkflow.GitWorkflowService;
  const projectFiles = yield* T3ProjectFileLoader.T3ProjectFileLoader;
  const launchServices = yield* Effect.context<
    | ThreadLaunch.ThreadLaunchService
    | ServerConfig.ServerConfig
    | DocumentText.DocumentText
    | FileSystem.FileSystem
  >();

  const failure = (message: string) => (cause: unknown) => new KanbanError({ message, cause });

  /**
   * Where a new thread of the project works, by its Workspace setting (the project's, then
   * t3.json's, then local), as a new thread from the app: a fresh worktree off the default branch,
   * or the project root. A folder that is not a Git repository always uses its root.
   */
  const workspaceFor = Effect.fn("KanbanThreadStarter.workspaceFor")(function* (
    workspaceRoot: string,
    envMode: ThreadEnvMode,
    startFromOrigin: boolean,
  ) {
    if (envMode === "local") return { type: "root" } as const;
    const refs = yield* git
      .listRefs({ cwd: workspaceRoot, limit: 100 })
      .pipe(Effect.mapError(failure("Could not read the project's branches.")));
    if (resolveSendEnvMode({ requestedEnvMode: envMode, isGitRepo: refs.isRepo }) === "local") {
      return { type: "root" } as const;
    }
    const baseRef = defaultWorktreeBase(refs.refs);
    if (baseRef === null) {
      return yield* new KanbanError({
        message: "This project starts threads in a new worktree, but it has no default branch.",
      });
    }
    return {
      type: "worktree",
      baseRef,
      ...(startFromOrigin ? { startFromOrigin: true } : {}),
    } satisfies OrchestrationV2ThreadLaunchWorkspaceStrategy;
  });

  /** Launches the thread where the project's settings put a new thread, as the app would. */
  const launchInProject = Effect.fn("KanbanThreadStarter.launchInProject")(function* (
    ticket: KanbanTicket,
    target: Extract<KanbanTicketStartThreadInput["target"], { readonly kind: "project" }>,
    text: string,
    id: string,
  ) {
    const project = yield* projects
      .getById(ticket.projectId)
      .pipe(Effect.mapError(failure("Could not read the ticket's project.")));
    if (Option.isNone(project)) {
      return yield* new KanbanError({ message: "The ticket's project no longer exists." });
    }
    const serverSettings = yield* settings.getSettings.pipe(
      Effect.mapError(failure("Could not read the project's settings.")),
    );
    const projectFile = yield* projectFiles.load(project.value.workspaceRoot);
    const defaults = resolveProjectSettings(
      serverSettings,
      ticket.projectId,
      project.value,
      Option.getOrNull(projectFile),
    ).settings;
    // Clients send a model only as a fallback for a project without a default, and they read the
    // project's legacy column, which misses defaults saved in Settings → Projects.
    const modelSelection = defaults.defaultModelSelection ?? target.modelSelection;
    if (modelSelection === undefined) {
      return yield* new KanbanError({ message: "This project has no default model. Pick one." });
    }
    const workspaceStrategy = yield* workspaceFor(
      project.value.workspaceRoot,
      defaults.defaultThreadEnvMode,
      defaults.newWorktreesStartFromOrigin,
    );
    const commandId = CommandId.make(`kanban:${id}`);
    const result = yield* ThreadMessageIntake.launchThread({
      commandId,
      threadId: ThreadId.make(commandId),
      projectId: ticket.projectId,
      title: `${ticket.identifier} ${ticket.title}`,
      modelSelection,
      runtimeMode: defaults.defaultRuntimeMode,
      interactionMode: "default",
      workspaceStrategy,
      initialMessage: { messageId: MessageId.make(commandId), text, attachments: [] },
      createdBy: "user",
      creationSource: "web",
    }).pipe(
      Effect.provideContext(launchServices),
      Effect.mapError((error) =>
        error._tag === "ThreadManagementProviderInstanceDisabledError"
          ? new KanbanError({ message: error.message, cause: error })
          : new KanbanError({ message: "Could not start the thread.", cause: error }),
      ),
    );
    return result.threadId;
  });

  /** Queues the message behind the bot's running turn, if any, like a message the owner types. */
  const sendToBot = Effect.fn("KanbanThreadStarter.sendToBot")(function* (
    target: Extract<KanbanTicketStartThreadInput["target"], { readonly kind: "bot" }>,
    text: string,
    id: string,
  ) {
    const bot = yield* store
      .getBot(target.botId)
      .pipe(Effect.mapError(failure("Could not read the bot.")));
    if (Option.isNone(bot)) {
      return yield* new KanbanError({ message: `Bot ${target.botId} does not exist.` });
    }
    const threadId = botThreadId(bot.value.id, bot.value.homeGeneration);
    yield* engine
      .dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`kanban:${id}`),
        threadId,
        messageId: MessageId.make(`kanban:${id}`),
        text,
        attachments: [],
        modelSelection: bot.value.model,
        dispatchMode: { type: "queue_after_active" },
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(Effect.mapError(failure(`Could not send the ticket to ${bot.value.name}.`)));
    return threadId;
  });

  const startThread = Effect.fn("KanbanThreadStarter.startThread")(function* (
    input: KanbanTicketStartThreadInput,
  ) {
    const snapshot = yield* kanban.readSnapshot;
    const ticket = snapshot.tickets.find((candidate) => candidate.id === input.ticketId);
    if (ticket === undefined) {
      return yield* new KanbanError({ message: `Ticket ${input.ticketId} does not exist.` });
    }
    // The thread still starts without the description when it cannot be read.
    const detail = yield* kanban.ticketDetail({ ticketId: ticket.id }).pipe(Effect.option);
    const text = buildTicketThreadMessage(
      ticket,
      Option.match(detail, { onNone: () => null, onSome: (value) => value.description }),
      input.note,
    );
    const id = yield* randomUuidV4;
    const threadId =
      input.target.kind === "bot"
        ? yield* sendToBot(input.target, text, id)
        : yield* launchInProject(ticket, input.target, text, id);
    return { threadId, ticket: yield* kanban.linkThread({ ticketId: ticket.id, threadId }) };
  });

  return KanbanThreadStarter.of({ startThread });
});

export const layerLive = Layer.effect(KanbanThreadStarter, make).pipe(
  Layer.provide(T3ProjectFileLoader.layer),
);
