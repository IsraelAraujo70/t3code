/**
 * The bots RPCs' server group and handler layer. ws.ts serves them beside upstream's handlers
 * instead of inside upstream's handler map: that map (~200 handlers) sits at TypeScript's
 * instantiation budget, and ten more entries pushed `ServerWsRpcGroup.toLayer` past it.
 */
import { BOTS_RPCS, BOTS_WS_METHODS, RpcScopeAuthorization } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RpcGroup } from "effect/rpc";

import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import * as BotsService from "./BotsService.ts";
import * as Dictation from "./dictation/Dictation.ts";
import * as VoiceReader from "./voiceReader/VoiceReader.ts";

/** Tags ws.ts omits from upstream's handler group; their handlers come from `layer`. */
export const BOTS_RPC_TAGS = Object.values(BOTS_WS_METHODS);

/** Same middleware order as ws.ts: instrumentation wraps authorization. */
export const ServerBotsRpcGroup = RpcGroup.make(...BOTS_RPCS)
  .middleware(RpcScopeAuthorization)
  .middleware(RpcInstrumentation);

/** The handlers, with Dictation and VoiceReader left to the caller (tests mock them). */
export const layerHandlers = ServerBotsRpcGroup.toLayer(
  Effect.gen(function* () {
    const bots = yield* BotsService.BotsService;
    const dictation = yield* Dictation.Dictation;
    const voiceReader = yield* VoiceReader.VoiceReader;
    return ServerBotsRpcGroup.of({
      [BOTS_WS_METHODS.directorySubscribe]: () => bots.directory,
      [BOTS_WS_METHODS.botCreate]: (input) => bots.createBot(input),
      [BOTS_WS_METHODS.botUpdate]: (input) => bots.updateBot(input),
      [BOTS_WS_METHODS.botDelete]: (input) => bots.deleteBot(input),
      [BOTS_WS_METHODS.botResetConversation]: (input) => bots.resetConversation(input),
      [BOTS_WS_METHODS.memoryCreate]: (input) => bots.createMemory(input, "user"),
      [BOTS_WS_METHODS.memoryUpdate]: (input) => bots.updateMemory(input),
      [BOTS_WS_METHODS.memoryDelete]: (input) => bots.deleteMemory(input),
      [BOTS_WS_METHODS.ownerUpdate]: (input) => bots.updateOwner(input),
      [BOTS_WS_METHODS.import]: (input) => bots.importFriend(input),
      [BOTS_WS_METHODS.sectionCreate]: (input) => bots.createSection(input),
      [BOTS_WS_METHODS.sectionRename]: (input) => bots.renameSection(input),
      [BOTS_WS_METHODS.sectionDelete]: (input) => bots.deleteSection(input),
      [BOTS_WS_METHODS.arrange]: (input) => bots.arrange(input),
      [BOTS_WS_METHODS.dictationTranscribe]: (input) => dictation.transcribe(input),
      [BOTS_WS_METHODS.pushDeviceRegister]: (input) => bots.registerPushDevice(input),
      [BOTS_WS_METHODS.pushDeviceUnregister]: (input) => bots.unregisterPushDevice(input),
      [BOTS_WS_METHODS.voiceReaderSubscribe]: (input) => voiceReader.subscribe(input),
      [BOTS_WS_METHODS.voiceReaderOffer]: (input) => voiceReader.offer(input),
      [BOTS_WS_METHODS.voiceReaderSpeak]: (input) => voiceReader.speak(input),
      [BOTS_WS_METHODS.voiceReaderStop]: (input) => voiceReader.stop(input),
    });
  }),
);

export const layer = layerHandlers.pipe(
  Layer.provide(Dictation.layer),
  Layer.provide(VoiceReader.layerLive),
);
