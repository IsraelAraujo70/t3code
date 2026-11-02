/**
 * The only place server.ts takes bots layers from. On the bots host the real store, instructions
 * and service run; on every other server the off variants run instead, so `bots.sqlite` is never
 * opened there and every bots operation explains where bots live.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { BotsError, KanbanError, WorkflowsError } from "@t3tools/contracts";

import * as BotsDb from "./BotsDb.ts";
import { isBotsHost, NOT_BOTS_HOST_MESSAGE } from "./BotsHost.ts";
import * as BotsInstructions from "./BotsInstructions.ts";
import * as BotsService from "./BotsService.ts";
import * as BotsStore from "./BotsStore.ts";
import * as BotCompactionReactor from "./compaction/BotCompactionReactor.ts";
import * as HostMcpForward from "./hostMcp/HostMcpForward.ts";
import * as KanbanPoller from "./kanban/KanbanPoller.ts";
import * as KanbanService from "./kanban/KanbanService.ts";
import * as BotPushReactor from "./push/BotPushReactor.ts";
import * as BotQueueReactor from "./queue/BotQueueReactor.ts";
import * as BotRotation from "./rotation/BotRotation.ts";
import * as ThreadWatchReactor from "./threadWatch/ThreadWatchReactor.ts";
import * as ThreadWatchStore from "./threadWatch/ThreadWatchStore.ts";
import * as Workflows from "./workflows/layer.ts";
import * as WorkflowNotices from "./workflows/notices/WorkflowNotices.ts";

import * as WorkflowDefinitions from "./workflows/definitions/WorkflowDefinitions.ts";
import { layer as WatcherLayer } from "./workflows/definitions/watcher.ts";
import { layer as WorkflowTriggersLayer } from "./workflows/triggers/WorkflowTriggers.ts";
import * as WorkflowWebhooks from "./workflows/triggers/webhook.ts";

/**
 * Workflows on the bots host: the engine block (engine, catalog, definitions, journal) with the
 * hand-edit watcher, the trigger sources and the webhook side on top of it, so they see the
 * engine. BotsDb, the same layer the engine block keeps private, backs their cursors.
 */
export const layerWorkflows = Layer.mergeAll(
  WatcherLayer,
  WorkflowTriggersLayer,
  WorkflowWebhooks.layerBindHook,
  WorkflowWebhooks.layerReconcileOnHost,
).pipe(Layer.provideMerge(Workflows.layer), Layer.provide(BotsDb.layer));
const workflowsNotHost = () =>
  Effect.fail(new WorkflowsError({ code: "unavailable", message: NOT_BOTS_HOST_MESSAGE }));
const layerWorkflowsOff = Layer.succeed(
  WorkflowDefinitions.WorkflowDefinitions,
  WorkflowDefinitions.WorkflowDefinitions.of({
    repoPath: "",
    changes: Stream.empty,
    snapshot: Stream.fail(
      new WorkflowsError({ code: "unavailable", message: NOT_BOTS_HOST_MESSAGE }),
    ),
    documentChanges: () =>
      Stream.fail(new WorkflowsError({ code: "unavailable", message: NOT_BOTS_HOST_MESSAGE })),
    list: workflowsNotHost(),
    document: workflowsNotHost,
    validate: workflowsNotHost,
    save: workflowsNotHost,
    fromTemplate: workflowsNotHost,
    setEnabled: workflowsNotHost,
    delete: workflowsNotHost,
    restore: workflowsNotHost,
    history: workflowsNotHost,
    template: workflowsNotHost,
    ingest: workflowsNotHost,
  }),
);

const notHost = () => Effect.fail(new BotsError({ message: NOT_BOTS_HOST_MESSAGE }));

const layerStoreOff = Layer.succeed(
  BotsStore.BotsStore,
  BotsStore.BotsStore.of({
    advanceGeneration: notHost,
    listHandoffs: notHost,
    listBots: notHost(),
    getBot: notHost,
    insertBot: notHost,
    updateBot: notHost,
    deleteBot: notHost,
    listSections: notHost(),
    getSection: notHost,
    insertSection: notHost,
    updateSection: notHost,
    deleteSection: notHost,
    arrange: notHost,
    listMemories: notHost,
    getMemory: notHost,
    insertMemory: notHost,
    updateMemory: notHost,
    deleteMemory: notHost,
    getAboutMe: notHost(),
    setAboutMe: notHost,
    upsertPushDevice: notHost,
    deletePushDevice: notHost,
    listPushDevices: notHost(),
    // Off the bots host no bot is allowed links: BotLinkAccess refuses when this fails.
    listLinkedEnvironmentBots: notHost(),
    setBotLinkedEnvironments: notHost,
  }),
);

const layerInstructionsOff = Layer.succeed(
  BotsInstructions.BotsInstructions,
  BotsInstructions.BotsInstructions.of({
    forThread: Effect.fn("BotsInstructions.BotsInstructions.forThread")(() =>
      Effect.as(Effect.void, undefined),
    ),
  }),
);

const layerServiceOff = Layer.succeed(
  BotsService.BotsService,
  BotsService.BotsService.of({
    directory: Stream.fail(new BotsError({ message: NOT_BOTS_HOST_MESSAGE })),
    createBot: notHost,
    updateBot: notHost,
    deleteBot: notHost,
    advanceGeneration: notHost,
    archiveGeneration: notHost,
    history: notHost,
    createMemory: notHost,
    updateMemory: notHost,
    deleteMemory: notHost,
    memoriesOf: notHost,
    updateOwner: notHost,
    createSection: notHost,
    renameSection: notHost,
    deleteSection: notHost,
    arrange: notHost,
    setBotLinkedEnvironments: notHost,
    openThread: notHost,
    listThreads: notHost,
    // Not a bots host: no thread belongs to a bot here.
    botForThread: Effect.fn("BotsService.BotsService.botForThread")(() => Effect.succeedNone),
    registerPushDevice: notHost,
    unregisterPushDevice: notHost,
  }),
);

const layerRotationOff = Layer.succeed(
  BotRotation.BotRotation,
  BotRotation.BotRotation.of({
    reset: notHost,
    consider: Effect.fn("BotRotation.BotRotation.consider")(() => Effect.void),
    start: Effect.fn("BotRotation.BotRotation.start")(() => Effect.void),
  }),
);

const kanbanNotHost = () => Effect.fail(new KanbanError({ message: NOT_BOTS_HOST_MESSAGE }));

// The kanban lives in bots.sqlite beside the bots it assigns.
const layerKanbanOff = Layer.succeed(
  KanbanService.KanbanService,
  KanbanService.KanbanService.of({
    snapshot: Stream.fail(new KanbanError({ message: NOT_BOTS_HOST_MESSAGE })),
    readSnapshot: kanbanNotHost(),
    refresh: Effect.void,
    addAccount: kanbanNotHost,
    renameAccount: kanbanNotHost,
    deleteAccount: kanbanNotHost,
    linearTeams: kanbanNotHost,
    linkProject: kanbanNotHost,
    unlinkProject: kanbanNotHost,
    setWorkspaceBots: kanbanNotHost,
    setBotAllWorkspaces: kanbanNotHost,
    createTicket: kanbanNotHost,
    moveTicket: kanbanNotHost,
    deleteTicket: kanbanNotHost,
    linkThread: kanbanNotHost,
    unlinkThread: kanbanNotHost,
    sync: kanbanNotHost,
    poll: kanbanNotHost(),
    ticketDetail: kanbanNotHost,
    updateTicket: kanbanNotHost,
    comment: kanbanNotHost,
    deleteComment: kanbanNotHost,
    saveView: kanbanNotHost,
    deleteView: kanbanNotHost,
    reorderViews: kanbanNotHost,
    importLinearViews: kanbanNotHost,
    createLabel: kanbanNotHost,
    deleteLabel: kanbanNotHost,
  }),
);

// Thread watches live in bots.sqlite, so only the bots host keeps them.
const layerThreadWatchOff = Layer.succeed(
  ThreadWatchStore.ThreadWatchStore,
  ThreadWatchStore.ThreadWatchStore.of({
    watch: notHost,
    unwatch: notHost,
    watchersOf: notHost,
    list: notHost(),
  }),
);

/** Everything a server that is not the bots host provides instead of bots. */
export const layerOff = Layer.mergeAll(
  layerStoreOff,
  layerInstructionsOff,
  layerServiceOff,
  layerThreadWatchOff,
  layerKanbanOff,
  layerWorkflowsOff,
);

/** The bots store, instructions and host MCP tools for the orchestration runtime. */
export const layerCore = Layer.unwrap(
  isBotsHost.pipe(
    Effect.map((host) =>
      host
        ? Layer.mergeAll(
            BotsInstructions.layer,
            HostMcpForward.layer,
            // The scheduled-task service, below the runtime, reads the workflow webhook hook here.
            WorkflowWebhooks.layerHook,
          ).pipe(Layer.provideMerge(BotsStore.layer))
        : Layer.mergeAll(layerStoreOff, layerInstructionsOff),
    ),
  ),
);

/**
 * BotsService, thread watches (store and waking reactor), bot compaction, conversation rotation,
 * held-queue resume, bot push, and the kanban with its Linear poller, above the orchestration
 * runtime.
 */
export const layerService = Layer.unwrap(
  isBotsHost.pipe(
    Effect.map((host) =>
      host
        ? Layer.mergeAll(
            ThreadWatchReactor.layerStart,
            BotCompactionReactor.layerStart,
            BotRotation.layerStart,
            BotQueueReactor.layerStart,
            BotPushReactor.layerStart,
            KanbanPoller.layerStart,
          ).pipe(
            Layer.provideMerge(BotRotation.layer),
            Layer.provideMerge(BotsService.layer),
            Layer.provideMerge(ThreadWatchStore.layer),
            // wf-engine slice 8: the host interpreter reads notices, run cards (over the kanban
            // service, so it comes after) and pull requests from this context.
            Layer.provideMerge(layerWorkflows.pipe(Layer.provide(WorkflowNotices.deliveryLayer))),
            Layer.provideMerge(KanbanService.layer),
          )
        : Layer.mergeAll(
            layerServiceOff,
            layerThreadWatchOff,
            layerKanbanOff,
            layerRotationOff,
            layerWorkflowsOff,
          ),
    ),
  ),
);
