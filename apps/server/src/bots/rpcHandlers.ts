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
import * as KanbanAiFilter from "./kanban/KanbanAiFilter.ts";
import { KanbanService } from "./kanban/KanbanService.ts";
import * as KanbanThreadStarter from "./kanban/KanbanThreadStarter.ts";
import * as BotSessionRestart from "./restart/BotSessionRestart.ts";
import { BotRotation } from "./rotation/BotRotation.ts";
import * as VoiceSession from "./voice/VoiceSession.ts";

/** Tags ws.ts omits from upstream's handler group; their handlers come from `layer`. */
export const BOTS_RPC_TAGS = Object.values(BOTS_WS_METHODS);

/** Same middleware order as ws.ts: instrumentation wraps authorization. */
export const ServerBotsRpcGroup = RpcGroup.make(...BOTS_RPCS)
  .middleware(RpcScopeAuthorization)
  .middleware(RpcInstrumentation);

/**
 * The handlers, with Dictation, VoiceSessions, BotSessionRestart, KanbanThreadStarter and
 * KanbanAiFilter left to the caller (tests mock them). BotRotation comes from layer.ts's
 * layerService, beside the reactor that shares it.
 */
export const layerHandlers = ServerBotsRpcGroup.toLayer(
  Effect.gen(function* () {
    const bots = yield* BotsService.BotsService;
    const dictation = yield* Dictation.Dictation;
    const voice = yield* VoiceSession.VoiceSessions;
    const restarts = yield* BotSessionRestart.BotSessionRestart;
    const rotation = yield* BotRotation;
    const kanban = yield* KanbanService;
    const threadStarter = yield* KanbanThreadStarter.KanbanThreadStarter;
    const aiFilter = yield* KanbanAiFilter.KanbanAiFilter;
    return ServerBotsRpcGroup.of({
      [BOTS_WS_METHODS.directorySubscribe]: () => bots.directory,
      [BOTS_WS_METHODS.botCreate]: (input) => bots.createBot(input),
      [BOTS_WS_METHODS.botUpdate]: (input) => bots.updateBot(input),
      [BOTS_WS_METHODS.botDelete]: (input) => bots.deleteBot(input),
      [BOTS_WS_METHODS.botResetConversation]: (input) => rotation.reset(input),
      [BOTS_WS_METHODS.botHistory]: (input) => bots.history(input),
      [BOTS_WS_METHODS.botRestartSession]: (input) => restarts.restart(input),
      [BOTS_WS_METHODS.botLinkedEnvironments]: (input) => bots.setBotLinkedEnvironments(input),
      [BOTS_WS_METHODS.botMakeRegular]: (input) => bots.makeRegular(input),
      [BOTS_WS_METHODS.memoryCreate]: (input) => bots.createMemory(input, "user"),
      [BOTS_WS_METHODS.memoryUpdate]: (input) => bots.updateMemory(input),
      [BOTS_WS_METHODS.memoryDelete]: (input) => bots.deleteMemory(input),
      [BOTS_WS_METHODS.ownerUpdate]: (input) => bots.updateOwner(input),
      [BOTS_WS_METHODS.sectionCreate]: (input) => bots.createSection(input),
      [BOTS_WS_METHODS.sectionRename]: (input) => bots.renameSection(input),
      [BOTS_WS_METHODS.sectionDelete]: (input) => bots.deleteSection(input),
      [BOTS_WS_METHODS.arrange]: (input) => bots.arrange(input),
      [BOTS_WS_METHODS.dictationTranscribe]: (input) => dictation.transcribe(input),
      [BOTS_WS_METHODS.pushDeviceRegister]: (input) => bots.registerPushDevice(input),
      [BOTS_WS_METHODS.pushDeviceUnregister]: (input) => bots.unregisterPushDevice(input),
      [BOTS_WS_METHODS.voiceSession]: (input) => voice.session(input),
      [BOTS_WS_METHODS.voiceReady]: (input) => voice.ready(input),
      [BOTS_WS_METHODS.voiceReconnect]: (input) => voice.reconnect(input),
      [BOTS_WS_METHODS.voiceReport]: (input) => voice.report(input),
      [BOTS_WS_METHODS.kanbanSubscribe]: () => kanban.snapshot,
      [BOTS_WS_METHODS.kanbanAccountAdd]: (input) => kanban.addAccount(input),
      [BOTS_WS_METHODS.kanbanAccountRename]: (input) => kanban.renameAccount(input),
      [BOTS_WS_METHODS.kanbanAccountDelete]: (input) => kanban.deleteAccount(input),
      [BOTS_WS_METHODS.kanbanLinearTeams]: (input) => kanban.linearTeams(input),
      [BOTS_WS_METHODS.kanbanProjectLink]: (input) => kanban.linkProject(input),
      [BOTS_WS_METHODS.kanbanProjectUnlink]: (input) => kanban.unlinkProject(input),
      [BOTS_WS_METHODS.kanbanWorkspaceBots]: (input) => kanban.setWorkspaceBots(input),
      [BOTS_WS_METHODS.kanbanBotAllWorkspaces]: (input) => kanban.setBotAllWorkspaces(input),
      [BOTS_WS_METHODS.kanbanTicketCreate]: (input) => kanban.createTicket(input),
      [BOTS_WS_METHODS.kanbanTicketMove]: (input) => kanban.moveTicket(input),
      [BOTS_WS_METHODS.kanbanTicketDelete]: (input) => kanban.deleteTicket(input),
      [BOTS_WS_METHODS.kanbanTicketLinkThread]: (input) => kanban.linkThread(input),
      [BOTS_WS_METHODS.kanbanTicketUnlinkThread]: (input) => kanban.unlinkThread(input),
      [BOTS_WS_METHODS.kanbanSync]: (input) => kanban.sync(input),
      [BOTS_WS_METHODS.kanbanTicketDetail]: (input) => kanban.ticketDetail(input),
      [BOTS_WS_METHODS.kanbanTicketUpdate]: (input) => kanban.updateTicket(input),
      [BOTS_WS_METHODS.kanbanTicketComment]: (input) => kanban.comment(input),
      [BOTS_WS_METHODS.kanbanTicketDeleteComment]: (input) => kanban.deleteComment(input),
      [BOTS_WS_METHODS.kanbanTicketStartThread]: (input) => threadStarter.startThread(input),
      [BOTS_WS_METHODS.kanbanViewSave]: (input) => kanban.saveView(input),
      [BOTS_WS_METHODS.kanbanViewDelete]: (input) => kanban.deleteView(input),
      [BOTS_WS_METHODS.kanbanViewReorder]: (input) => kanban.reorderViews(input),
      [BOTS_WS_METHODS.kanbanViewImportLinear]: (input) => kanban.importLinearViews(input),
      [BOTS_WS_METHODS.kanbanLabelCreate]: (input) => kanban.createLabel(input),
      [BOTS_WS_METHODS.kanbanLabelDelete]: (input) => kanban.deleteLabel(input),
      [BOTS_WS_METHODS.kanbanAiFilter]: (input) => aiFilter.filter(input),
    });
  }),
);

export const layer = layerHandlers.pipe(
  Layer.provide(Dictation.layer),
  Layer.provide(VoiceSession.layerLive),
  Layer.provide(BotSessionRestart.layerLive),
  Layer.provide(KanbanThreadStarter.layerLive),
  Layer.provide(KanbanAiFilter.layerLive),
);
