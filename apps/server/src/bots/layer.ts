/**
 * The only place server.ts takes bots layers from. On the bots host the real store, instructions
 * and service run; on every other server the off variants run instead, so `bots.sqlite` is never
 * opened there and every bots operation explains where bots live.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { BotsError, KanbanError } from "@t3tools/contracts";

import { isBotsHost, NOT_BOTS_HOST_MESSAGE } from "./BotsHost.ts";
import * as BotsInstructions from "./BotsInstructions.ts";
import * as BotsService from "./BotsService.ts";
import * as BotsStore from "./BotsStore.ts";
import * as BotCompactionReactor from "./compaction/BotCompactionReactor.ts";
import * as CodexImages from "./guest/CodexImages.ts";
import * as GuestArtifacts from "./guest/GuestArtifacts.ts";
import * as GuestHttp from "./guest/GuestHttp.ts";
import * as GuestIdle from "./guest/GuestIdle.ts";
import * as GuestModelPin from "./guest/GuestModelPin.ts";
import * as GuestService from "./guest/GuestService.ts";
import * as GuestStore from "./guest/GuestStore.ts";
import * as GuestVoice from "./guest/GuestVoice.ts";
import * as GuestTools from "./guest/GuestTools.ts";
import * as HostMcpForward from "./guest/HostMcpForward.ts";
import * as KanbanPoller from "./kanban/KanbanPoller.ts";
import * as KanbanService from "./kanban/KanbanService.ts";
import * as BotPushReactor from "./push/BotPushReactor.ts";
import * as BotQueueReactor from "./queue/BotQueueReactor.ts";
import * as BotSessionRestart from "./restart/BotSessionRestart.ts";
import * as ThreadWatchReactor from "./threadWatch/ThreadWatchReactor.ts";
import * as ThreadWatchStore from "./threadWatch/ThreadWatchStore.ts";
import * as VoiceSession from "./voice/VoiceSession.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

const notHost = () => Effect.fail(new BotsError({ message: NOT_BOTS_HOST_MESSAGE }));

const layerStoreOff = Layer.succeed(
  BotsStore.BotsStore,
  BotsStore.BotsStore.of({
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
    importBatch: notHost,
    upsertPushDevice: notHost,
    deletePushDevice: notHost,
    listPushDevices: notHost(),
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
    resetConversation: notHost,
    createMemory: notHost,
    updateMemory: notHost,
    deleteMemory: notHost,
    memoriesOf: notHost,
    updateOwner: notHost,
    importFriend: notHost,
    createSection: notHost,
    renameSection: notHost,
    deleteSection: notHost,
    arrange: notHost,
    ensureConversation: notHost,
    // Not a bots host: no thread belongs to a bot here.
    botForThread: Effect.fn("BotsService.BotsService.botForThread")(() => Effect.succeedNone),
    registerPushDevice: notHost,
    unregisterPushDevice: notHost,
  }),
);

const kanbanNotHost = () => Effect.fail(new KanbanError({ message: NOT_BOTS_HOST_MESSAGE }));

// The kanban lives in bots.sqlite beside the bots it assigns.
const layerKanbanOff = Layer.succeed(
  KanbanService.KanbanService,
  KanbanService.KanbanService.of({
    snapshot: Stream.fail(new KanbanError({ message: NOT_BOTS_HOST_MESSAGE })),
    readSnapshot: kanbanNotHost(),
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

// Guests live in bots.sqlite too; only the bots host has them.
const layerGuestStoreOff = Layer.succeed(
  GuestStore.GuestStore,
  GuestStore.GuestStore.of({
    listGuests: notHost(),
    getGuest: notHost,
    getGuestByTokenHash: notHost,
    insertGuest: notHost,
    setTokenHash: notHost,
    deleteGuest: notHost,
    listGuestBotIds: notHost,
    listAssignments: notHost(),
    guestOfBot: notHost,
    assignBot: notHost,
    unassignBot: notHost,
    upsertPushDevice: notHost,
    deletePushDevice: notHost,
    listPushDevices: notHost,
  }),
);

const layerGuestArtifactsOff = Layer.succeed(
  GuestArtifacts.GuestArtifacts,
  GuestArtifacts.GuestArtifacts.of({
    record: notHost,
    listForThread: notHost,
    get: notHost,
    countImagesSince: notHost,
    recorded: Stream.empty,
  }),
);

/** Everything a server that is not the bots host provides instead of bots. */
export const layerOff = Layer.mergeAll(
  layerStoreOff,
  layerInstructionsOff,
  layerServiceOff,
  layerThreadWatchOff,
  layerGuestStoreOff,
  layerGuestArtifactsOff,
  layerKanbanOff,
);

/**
 * BotsStore, GuestStore, BotsInstructions, GuestModelPin, GuestTools and GuestArtifacts, for the
 * orchestration runtime (RunExecutionService, Orchestrator) and the bots layers above it. Other
 * servers provide no GuestTools, so their turns carry no app tools.
 */
export const layerCore = Layer.unwrap(
  isBotsHost.pipe(
    Effect.map((host) =>
      host
        ? Layer.mergeAll(BotsInstructions.layer, GuestModelPin.layer, GuestTools.layer).pipe(
            Layer.provide(HostMcpForward.layer),
            Layer.provideMerge(GuestArtifacts.layer),
            Layer.provide(CodexImages.layer),
            Layer.provide(ProjectionStore.layer),
            Layer.provideMerge(BotsStore.layer),
            Layer.provideMerge(GuestStore.layer),
          )
        : Layer.mergeAll(
            layerStoreOff,
            layerInstructionsOff,
            layerGuestStoreOff,
            layerGuestArtifactsOff,
          ),
    ),
  ),
);

/** The guest listener (voice included) and the idle stop of guest sandboxes. */
const layerGuests = Layer.merge(
  GuestHttp.layerListener.pipe(
    Layer.provide(GuestVoice.layer.pipe(Layer.provide(VoiceSession.layerLive))),
    Layer.provide(GuestService.layer),
  ),
  GuestIdle.layerStart.pipe(Layer.provide(BotSessionRestart.layerLive)),
).pipe(Layer.provide(ProjectionStore.layer));

/**
 * BotsService, thread watches (store and waking reactor), bot compaction, held-queue resume, bot
 * push, and the kanban with its Linear poller, above the orchestration runtime.
 */
export const layerService = Layer.unwrap(
  isBotsHost.pipe(
    Effect.map((host) =>
      host
        ? Layer.mergeAll(
            layerGuests,
            ThreadWatchReactor.layerStart,
            BotCompactionReactor.layerStart,
            BotQueueReactor.layerStart,
            BotPushReactor.layerStart,
            KanbanPoller.layerStart,
          ).pipe(
            Layer.provideMerge(BotsService.layer),
            Layer.provideMerge(ThreadWatchStore.layer),
            Layer.provideMerge(KanbanService.layer),
          )
        : Layer.mergeAll(layerServiceOff, layerThreadWatchOff, layerKanbanOff),
    ),
  ),
);
