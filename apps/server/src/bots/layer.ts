/**
 * The only place server.ts takes bots layers from. On the bots host the real store, instructions
 * and service run; on every other server the off variants run instead, so `bots.sqlite` is never
 * opened there and every bots operation explains where bots live.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { BotsError } from "@t3tools/contracts";

import { isBotsHost, NOT_BOTS_HOST_MESSAGE } from "./BotsHost.ts";
import * as BotsInstructions from "./BotsInstructions.ts";
import * as BotsService from "./BotsService.ts";
import * as BotsStore from "./BotsStore.ts";
import * as BotCompactionReactor from "./compaction/BotCompactionReactor.ts";
import * as GuestHttp from "./guest/GuestHttp.ts";
import * as GuestIdle from "./guest/GuestIdle.ts";
import * as GuestService from "./guest/GuestService.ts";
import * as GuestStore from "./guest/GuestStore.ts";
import * as BotPushReactor from "./push/BotPushReactor.ts";
import * as BotQueueReactor from "./queue/BotQueueReactor.ts";
import * as BotSessionRestart from "./restart/BotSessionRestart.ts";
import * as ThreadWatchReactor from "./threadWatch/ThreadWatchReactor.ts";
import * as ThreadWatchStore from "./threadWatch/ThreadWatchStore.ts";
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
  BotsInstructions.BotsInstructions.of({ forThread: () => Effect.succeed(undefined) }),
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
    botForThread: () => Effect.succeed(Option.none()),
    registerPushDevice: notHost,
    unregisterPushDevice: notHost,
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

/** Everything a server that is not the bots host provides instead of bots. */
export const layerOff = Layer.mergeAll(
  layerStoreOff,
  layerInstructionsOff,
  layerServiceOff,
  layerThreadWatchOff,
  layerGuestStoreOff,
);

/**
 * BotsStore, GuestStore and BotsInstructions, for the orchestration runtime
 * (RunExecutionService) and the bots layers above it.
 */
export const layerCore = Layer.unwrap(
  isBotsHost.pipe(
    Effect.map((host) =>
      host
        ? BotsInstructions.layer.pipe(
            Layer.provideMerge(BotsStore.layer),
            Layer.provideMerge(GuestStore.layer),
          )
        : Layer.mergeAll(layerStoreOff, layerInstructionsOff, layerGuestStoreOff),
    ),
  ),
);

/** The guest listener and the idle stop of guest sandboxes. */
const layerGuests = Layer.merge(
  GuestHttp.layerListener.pipe(Layer.provide(GuestService.layer)),
  GuestIdle.layerStart.pipe(Layer.provide(BotSessionRestart.layerLive)),
).pipe(Layer.provide(ProjectionStore.layer));

/**
 * BotsService, thread watches (store and waking reactor), bot compaction, held-queue resume and
 * bot push, above the orchestration runtime.
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
          ).pipe(Layer.provideMerge(BotsService.layer), Layer.provideMerge(ThreadWatchStore.layer))
        : Layer.merge(layerServiceOff, layerThreadWatchOff),
    ),
  ),
);
