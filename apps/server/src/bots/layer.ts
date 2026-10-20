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

const notHost = () => Effect.fail(new BotsError({ message: NOT_BOTS_HOST_MESSAGE }));

const layerStoreOff = Layer.succeed(
  BotsStore.BotsStore,
  BotsStore.BotsStore.of({
    listBots: notHost(),
    getBot: notHost,
    insertBot: notHost,
    updateBot: notHost,
    deleteBot: notHost,
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
    // Not a bots host: no thread belongs to a bot here.
    botForThread: () => Effect.succeed(Option.none()),
  }),
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

/** BotsService, above the orchestration runtime. */
export const layerService = Layer.unwrap(
  isBotsHost.pipe(Effect.map((host) => (host ? BotsService.layer : layerServiceOff))),
);
