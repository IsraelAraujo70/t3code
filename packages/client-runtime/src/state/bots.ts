import {
  BOTS_WS_METHODS,
  type VoiceSessionAnswer,
  type VoiceSessionEvent,
  type VoiceSessionInput,
  type DictationTranscribeInput,
  type DictationTranscribeResult,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Stream from "effect/Stream";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { runStreamGuarded } from "../rpc/client.ts";
import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type VoiceTranscriber,
} from "../voice-input/transcription.ts";
import type { VoiceTransport } from "../voice.ts";
import {
  deletePendingAttachmentUpload,
  runAttachmentUploadCycle,
  type AttachmentByteUpload,
} from "./attachments.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommand,
} from "./runtime.ts";

/**
 * Bots (friend fork) for one environment: the live directory and its mutations. Web and mobile
 * bind this once each; every reader of an environment shares the same subscription.
 */
export function createBotsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  // Writes to one environment's bots apply in order, so a rename never lands before its create.
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { environmentId: string }) => environmentId,
  };
  const command = <
    Tag extends (typeof BOTS_WS_METHODS)[Exclude<
      keyof typeof BOTS_WS_METHODS,
      | "directorySubscribe"
      | "kanbanSubscribe"
      | "dictationTranscribe"
      | "voiceSession"
      | "voiceReady"
      | "voiceReconnect"
      | "voiceReport"
    >],
  >(
    label: string,
    tag: Tag,
    commandScheduler = scheduler,
  ) =>
    createEnvironmentRpcCommand(runtime, {
      label: `environment-data:bots:${label}`,
      tag,
      scheduler: commandScheduler,
      concurrency,
    });
  // Kanban writes wait on Linear, so they queue apart from the bot mutations.
  const kanbanScheduler = createAtomCommandScheduler();
  const kanbanCommand = <Tag extends Parameters<typeof command>[1]>(label: string, tag: Tag) =>
    command(`kanban-${label}`, tag, kanbanScheduler);
  return {
    /** Sections and bots in sidebar order, memories, and the owner profile; refreshed on change. */
    directory: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:bots:directory",
      tag: BOTS_WS_METHODS.directorySubscribe,
    }),
    createBot: command("create-bot", BOTS_WS_METHODS.botCreate),
    updateBot: command("update-bot", BOTS_WS_METHODS.botUpdate),
    deleteBot: command("delete-bot", BOTS_WS_METHODS.botDelete),
    resetConversation: command("reset-conversation", BOTS_WS_METHODS.botResetConversation),
    // A read, so it does not wait behind the bot mutations.
    history: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:bots:history",
      tag: BOTS_WS_METHODS.botHistory,
    }),
    restartSession: command("restart-session", BOTS_WS_METHODS.botRestartSession),
    setLinkedEnvironments: command("linked-environments", BOTS_WS_METHODS.botLinkedEnvironments),
    makeRegular: command("make-regular", BOTS_WS_METHODS.botMakeRegular),
    createMemory: command("create-memory", BOTS_WS_METHODS.memoryCreate),
    updateMemory: command("update-memory", BOTS_WS_METHODS.memoryUpdate),
    deleteMemory: command("delete-memory", BOTS_WS_METHODS.memoryDelete),
    updateOwner: command("update-owner", BOTS_WS_METHODS.ownerUpdate),
    createSection: command("create-section", BOTS_WS_METHODS.sectionCreate),
    renameSection: command("rename-section", BOTS_WS_METHODS.sectionRename),
    deleteSection: command("delete-section", BOTS_WS_METHODS.sectionDelete),
    arrange: command("arrange", BOTS_WS_METHODS.arrange),
    registerPushDevice: command("register-push-device", BOTS_WS_METHODS.pushDeviceRegister),
    unregisterPushDevice: command("unregister-push-device", BOTS_WS_METHODS.pushDeviceUnregister),
    /** Kanban accounts, links, workflow states and tickets; refreshed on change. */
    kanban: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:bots:kanban",
      tag: BOTS_WS_METHODS.kanbanSubscribe,
    }),
    kanbanAddAccount: kanbanCommand("add-account", BOTS_WS_METHODS.kanbanAccountAdd),
    kanbanRenameAccount: kanbanCommand("rename-account", BOTS_WS_METHODS.kanbanAccountRename),
    kanbanDeleteAccount: kanbanCommand("delete-account", BOTS_WS_METHODS.kanbanAccountDelete),
    kanbanLinearTeams: kanbanCommand("linear-teams", BOTS_WS_METHODS.kanbanLinearTeams),
    kanbanLinkProject: kanbanCommand("link-project", BOTS_WS_METHODS.kanbanProjectLink),
    kanbanUnlinkProject: kanbanCommand("unlink-project", BOTS_WS_METHODS.kanbanProjectUnlink),
    kanbanWorkspaceBots: kanbanCommand("workspace-bots", BOTS_WS_METHODS.kanbanWorkspaceBots),
    kanbanBotAllWorkspaces: kanbanCommand(
      "bot-all-workspaces",
      BOTS_WS_METHODS.kanbanBotAllWorkspaces,
    ),
    kanbanCreateTicket: kanbanCommand("create-ticket", BOTS_WS_METHODS.kanbanTicketCreate),
    kanbanMoveTicket: kanbanCommand("move-ticket", BOTS_WS_METHODS.kanbanTicketMove),
    kanbanDeleteTicket: kanbanCommand("delete-ticket", BOTS_WS_METHODS.kanbanTicketDelete),
    kanbanLinkThread: kanbanCommand("link-thread", BOTS_WS_METHODS.kanbanTicketLinkThread),
    kanbanUnlinkThread: kanbanCommand("unlink-thread", BOTS_WS_METHODS.kanbanTicketUnlinkThread),
    kanbanSync: kanbanCommand("sync", BOTS_WS_METHODS.kanbanSync),
    kanbanUpdateTicket: kanbanCommand("update-ticket", BOTS_WS_METHODS.kanbanTicketUpdate),
    kanbanComment: kanbanCommand("comment", BOTS_WS_METHODS.kanbanTicketComment),
    kanbanDeleteComment: kanbanCommand("delete-comment", BOTS_WS_METHODS.kanbanTicketDeleteComment),
    kanbanStartThread: kanbanCommand("start-thread", BOTS_WS_METHODS.kanbanTicketStartThread),
    kanbanSaveView: kanbanCommand("save-view", BOTS_WS_METHODS.kanbanViewSave),
    kanbanDeleteView: kanbanCommand("delete-view", BOTS_WS_METHODS.kanbanViewDelete),
    kanbanReorderViews: kanbanCommand("reorder-views", BOTS_WS_METHODS.kanbanViewReorder),
    kanbanImportLinearViews: kanbanCommand(
      "import-linear-views",
      BOTS_WS_METHODS.kanbanViewImportLinear,
    ),
    kanbanCreateLabel: kanbanCommand("create-label", BOTS_WS_METHODS.kanbanLabelCreate),
    kanbanDeleteLabel: kanbanCommand("delete-label", BOTS_WS_METHODS.kanbanLabelDelete),
    // Reads are not queued behind Linear writes: opening an issue must not wait on a move.
    kanbanTicketDetail: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:bots:kanban-ticket-detail",
      tag: BOTS_WS_METHODS.kanbanTicketDetail,
    }),
    kanbanAiFilter: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:bots:kanban-ai-filter",
      tag: BOTS_WS_METHODS.kanbanAiFilter,
    }),
    // Not queued behind the bot mutations: a dictation is slow and independent of them.
    transcribeDictation: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:bots:transcribe-dictation",
      tag: BOTS_WS_METHODS.dictationTranscribe,
    }),
    /**
     * One voice session. Mounting it opens the session (the server starts Codex); unmounting ends
     * the stream at once and the server closes the session. Never replayed on reconnect. The atom
     * holds only the latest value, so the stream is folded into `VoiceSessionProgress`: an event
     * that arrives in the same batch as a later one still counts.
     */
    voiceSession: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:bots:voice-session",
      subscribe: (input: VoiceSessionInput) =>
        runStreamGuarded(BOTS_WS_METHODS.voiceSession, input).pipe(
          Stream.mapAccum((): VoiceSessionProgress | null => null, foldVoiceSession),
        ),
      idleTtlMs: 0,
      // The key carries the SDP offer.
      sensitiveInput: true,
    }),
    // Independent of the bot mutations.
    voiceReady: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:bots:voice-ready",
      tag: BOTS_WS_METHODS.voiceReady,
    }),
    voiceReconnect: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:bots:voice-reconnect",
      tag: BOTS_WS_METHODS.voiceReconnect,
    }),
    voiceReport: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:bots:voice-report",
      tag: BOTS_WS_METHODS.voiceReport,
    }),
  };
}

/** A voice session's stream so far. */
export interface VoiceSessionProgress {
  readonly answer: VoiceSessionAnswer;
  /** The agent's work as last reported; null before the first report. */
  readonly working: boolean | null;
  /** How many `voice-changed` events arrived. */
  readonly voiceChanges: number;
}

/** Folds one event in; nothing is emitted before the answer, which the server sends first. */
function foldVoiceSession(
  progress: VoiceSessionProgress | null,
  event: VoiceSessionEvent,
): readonly [VoiceSessionProgress | null, ReadonlyArray<VoiceSessionProgress>] {
  const next =
    event.type === "answer"
      ? { answer: event, working: null, voiceChanges: 0 }
      : progress === null
        ? null
        : event.type === "bot"
          ? { ...progress, working: event.working }
          : { ...progress, voiceChanges: progress.voiceChanges + 1 };
  return [next, next === null ? [] : [next]];
}

/** Voice signaling over one client's bots atoms. */
export function createVoiceTransport(
  registry: AtomRegistry.AtomRegistry,
  bots: Pick<
    ReturnType<typeof createBotsEnvironmentAtoms>,
    "voiceSession" | "voiceReady" | "voiceReconnect" | "voiceReport"
  >,
): VoiceTransport {
  return {
    session: (target, sdp, { onAnswer, onBot, onVoiceChange, onEnd }) => {
      const atom = bots.voiceSession({
        environmentId: target.environmentId,
        input: { threadId: target.threadId, mode: target.mode, sdp, liveVoiceChange: true },
      });
      let ended = false;
      let seen: VoiceSessionProgress | null = null;
      const unsubscribe = registry.subscribe(
        atom,
        (result) => {
          if (ended) return;
          if (AsyncResult.isSuccess(result)) {
            const progress = result.value;
            const previous = seen;
            seen = progress;
            if (previous === null) onAnswer(progress.answer);
            if (progress.working !== null && progress.working !== previous?.working)
              onBot(progress.working);
            if (progress.voiceChanges > (previous?.voiceChanges ?? 0)) onVoiceChange();
            if (result.waiting) return;
            ended = true;
            onEnd(null);
          } else if (AsyncResult.isFailure(result)) {
            ended = true;
            onEnd(failureMessage(Cause.squash(result.cause)) ?? "The voice session failed.");
          }
        },
        { immediate: true },
      );
      return () => {
        ended = true;
        unsubscribe();
      };
    },
    ready: async ({ environmentId }, sessionId) => {
      const result = await runAtomCommand(registry, bots.voiceReady, {
        environmentId,
        input: { sessionId },
      });
      if (result._tag === "Failure")
        throw new Error(
          failureMessage(squashAtomCommandFailure(result)) ?? "The voice session failed.",
        );
    },
    reconnect: async ({ environmentId }, sessionId, sdp) => {
      const result = await runAtomCommand(registry, bots.voiceReconnect, {
        environmentId,
        input: { sessionId, sdp },
      });
      if (result._tag === "Failure")
        throw new Error(
          failureMessage(squashAtomCommandFailure(result)) ?? "The voice could not change.",
        );
      return result.value.sdp;
    },
    report: async ({ environmentId }, sessionId, entries) => {
      const result = await runAtomCommand(registry, bots.voiceReport, {
        environmentId,
        input: { sessionId, entries },
      });
      if (result._tag === "Failure") throw new Error("The voice report failed.");
    },
  };
}

/** A finished recording, as the client describes it before uploading its bytes. */
export interface DictationRecording {
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}

type UploadCycleInput<E, RE> = Parameters<typeof runAttachmentUploadCycle<E, RE>>[0];

function cancelled(): VoiceTranscriptionError {
  return new VoiceTranscriptionError("cancelled", "Voice transcription was cancelled.");
}

function failed(message: string, cause?: unknown): VoiceTranscriptionError {
  return new VoiceTranscriptionError("transcription-failed", message, { cause });
}

function failureMessage(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("message" in error)) return null;
  return typeof error.message === "string" ? error.message : null;
}

/**
 * Recordings use signed attachment uploads across connection modes.
 * Transcription deletes the uploaded recording.
 */
export function createServerVoiceTranscriber<E, RE, TE>(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly createUploadUrl: UploadCycleInput<E, RE>["createUploadUrl"];
  readonly remove: UploadCycleInput<E, RE>["remove"];
  readonly transcribe: AtomCommand<
    { readonly environmentId: EnvironmentId; readonly input: DictationTranscribeInput },
    DictationTranscribeResult,
    TE
  >;
  readonly environmentId: () => EnvironmentId | null;
  /** Only decides spacing around the inserted text. */
  readonly locale: () => string;
  readonly describeRecording: (uri: string) => Promise<DictationRecording>;
  readonly resolveUploadUrl: (environmentId: EnvironmentId, relativeUrl: string) => string | null;
  readonly transport: (
    url: string,
    uri: string,
    recording: DictationRecording,
  ) => AttachmentByteUpload;
}): VoiceTranscriber {
  const releaseUpload = (environmentId: EnvironmentId, attachmentId: string | null) => {
    if (attachmentId === null) return;
    deletePendingAttachmentUpload({
      registry: input.registry,
      remove: input.remove,
      environmentId,
      attachmentId,
    });
  };

  const transcribe = async (uri: string, { signal }: { readonly signal: AbortSignal }) => {
    throwIfVoiceTranscriptionAborted(signal);
    const environmentId = input.environmentId();
    if (environmentId === null) {
      throw new VoiceTranscriptionError(
        "unavailable",
        "No connected server transcribes dictation.",
      );
    }
    const recording = await input.describeRecording(uri);
    let abortTransfer: (() => void) | null = null;
    const onAbort = () => abortTransfer?.();
    signal.addEventListener("abort", onAbort, { once: true });
    let uploaded;
    try {
      uploaded = await runAttachmentUploadCycle({
        registry: input.registry,
        createUploadUrl: input.createUploadUrl,
        remove: input.remove,
        environmentId,
        upload: { type: "file", ...recording },
        resolveUploadUrl: (relativeUrl) => input.resolveUploadUrl(environmentId, relativeUrl),
        transport: (url) => input.transport(url, uri, recording),
        onMinted: () => (signal.aborted ? "cancel" : "continue"),
        onTransferStart: (abort) => {
          abortTransfer = abort;
        },
      });
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
    if (uploaded.status !== "uploaded") {
      if (uploaded.status === "failed") releaseUpload(environmentId, uploaded.attachmentId);
      if (signal.aborted || uploaded.status === "cancelled") throw cancelled();
      throw failed("Could not upload the recording.", uploaded.error);
    }
    if (signal.aborted) {
      releaseUpload(environmentId, uploaded.attachmentId);
      throw cancelled();
    }

    // The server deletes the upload whatever the outcome, so nothing is released from here on.
    const result = await runAtomCommand(
      input.registry,
      input.transcribe,
      { environmentId, input: { attachmentId: uploaded.attachmentId } },
      { reportFailure: false },
    );
    throwIfVoiceTranscriptionAborted(signal);
    if (result._tag !== "Success") {
      const error = squashAtomCommandFailure(result);
      throw failed(failureMessage(error) ?? "Could not transcribe this recording.", error);
    }
    return result.value.text;
  };

  return {
    prepare: async ({ signal }) => {
      throwIfVoiceTranscriptionAborted(signal);
      if (input.environmentId() === null) {
        throw new VoiceTranscriptionError(
          "unavailable",
          "No connected server transcribes dictation.",
        );
      }
      return { locale: input.locale(), transcribe };
    },
  };
}
