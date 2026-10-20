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
import * as ThreadWatchReactor from "./threadWatch/ThreadWatchReactor.ts";
import * as ThreadWatchStore from "./threadWatch/ThreadWatchStore.ts";

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
    // Not a bots host: no thread belongs to a bot here.
    botForThread: () => Effect.succeed(Option.none()),
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
);

/** BotsStore and BotsInstructions, for the orchestration runtime (RunExecutionService). */
export const layerCore = Layer.unwrap(
  isBotsHost.pipe(
    Effect.map((host) =>
      host
        ? BotsInstructions.layer.pipe(Layer.provideMerge(BotsStore.layer))
        : Layer.merge(layerStoreOff, layerInstructionsOff),
    ),
  ),
);

/** BotsService and thread watches (store and waking reactor), above the orchestration runtime. */
export const layerService = Layer.unwrap(
  isBotsHost.pipe(
    Effect.map((host) =>
      host
        ? Layer.mergeAll(BotsService.layer, ThreadWatchReactor.layerStart).pipe(
            Layer.provideMerge(ThreadWatchStore.layer),
          )
        : Layer.merge(layerServiceOff, layerThreadWatchOff),
    ),
  ),
);
