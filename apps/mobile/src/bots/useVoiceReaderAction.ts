import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  createVoiceReaderDriver,
  type VoiceReaderDriver,
} from "@t3tools/client-runtime/voice-reader";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { Platform } from "react-native";
import type { MediaStream } from "react-native-webrtc";
import * as Dialog from "../components/ui/Dialog";
import type { AppBarAction } from "../components/ui/AppBar.types";
import { appAtomRegistry } from "../state/atom-registry";
import { useServerConfigs } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { botsEnvironment } from "./state";
import {
  acquireVoiceReaderMicrophone,
  openNativeVoiceReaderPeer,
  releaseVoiceReaderMicrophone,
} from "./voiceReaderPeer";
import {
  getVoiceReaderEnabled,
  setVoiceReaderEnabled,
  subscribeVoiceReaderEnabled,
} from "./voiceReaderStore";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function reportError(description: string) {
  Dialog.alert("Falha ao ler respostas", description);
}

/** Offers Android reader controls on the thread's capable environment. */
export function useVoiceReaderAction({
  environmentId,
  threadId,
}: {
  readonly environmentId?: EnvironmentId;
  readonly threadId?: ThreadId;
}): ReadonlyArray<AppBarAction> {
  const configs = useServerConfigs();
  const supported =
    Platform.OS === "android" &&
    environmentId !== undefined &&
    threadId !== undefined &&
    configs.get(environmentId)?.environment.capabilities.voiceReader === true;
  const preference = useSyncExternalStore(
    subscribeVoiceReaderEnabled,
    () =>
      environmentId !== undefined && threadId !== undefined
        ? getVoiceReaderEnabled(environmentId, threadId)
        : false,
    () => false,
  );
  const enabled = supported && preference;
  const microphone = useRef<MediaStream | null>(null);
  const driver = useRef<VoiceReaderDriver | null>(null);
  const pending = useRef(false);
  // A permission prompt can outlive navigation to another thread.
  const lifecycle = useRef<symbol | null>(null);
  const { data, error } = useEnvironmentQuery(
    enabled && environmentId !== undefined && threadId !== undefined
      ? botsEnvironment.voiceReader({ environmentId, input: { threadId } })
      : null,
  );
  const latestData = useRef(data);
  useEffect(() => {
    latestData.current = data;
    if (data) driver.current?.update(data);
  }, [data]);
  useEffect(() => {
    lifecycle.current = Symbol(`${environmentId}:${threadId}:${supported}`);
    return () => {
      lifecycle.current = null;
    };
  }, [environmentId, threadId, supported]);
  useEffect(() => {
    if (!enabled || environmentId === undefined || threadId === undefined) return;
    let cancelled = false;
    const start = async () => {
      const stream = microphone.current ?? (await acquireVoiceReaderMicrophone());
      if (cancelled) {
        releaseVoiceReaderMicrophone(stream);
        return;
      }
      microphone.current = stream;
      driver.current = createVoiceReaderDriver({
        openPeer: async () => openNativeVoiceReaderPeer({ microphone: stream }),
        transport: {
          offer: async (input) => {
            const result = await runAtomCommand(appAtomRegistry, botsEnvironment.voiceReaderOffer, {
              environmentId,
              input,
            });
            if (result._tag === "Failure")
              throw new Error(message(squashAtomCommandFailure(result)));
            return result.value;
          },
          speak: async (input) => {
            const result = await runAtomCommand(appAtomRegistry, botsEnvironment.voiceReaderSpeak, {
              environmentId,
              input,
            });
            if (result._tag === "Failure")
              throw new Error(message(squashAtomCommandFailure(result)));
          },
          stop: async (input) => {
            const result = await runAtomCommand(appAtomRegistry, botsEnvironment.voiceReaderStop, {
              environmentId,
              input,
            });
            if (result._tag === "Failure")
              throw new Error(message(squashAtomCommandFailure(result)));
          },
        },
        onError: reportError,
      });
      if (latestData.current) driver.current.update(latestData.current);
    };
    void start().catch((failure: unknown) => {
      if (cancelled) return;
      reportError(message(failure));
      setVoiceReaderEnabled(environmentId, threadId, false);
    });
    return () => {
      cancelled = true;
      driver.current?.dispose();
      driver.current = null;
      if (microphone.current) releaseVoiceReaderMicrophone(microphone.current);
      microphone.current = null;
    };
  }, [enabled, environmentId, threadId]);
  useEffect(() => {
    if (!enabled || !error || environmentId === undefined || threadId === undefined) return;
    reportError(error);
    setVoiceReaderEnabled(environmentId, threadId, false);
  }, [enabled, error, environmentId, threadId]);

  const enable = async () => {
    if (pending.current || environmentId === undefined || threadId === undefined) return;
    pending.current = true;
    const session = lifecycle.current;
    try {
      const stream = await acquireVoiceReaderMicrophone();
      if (session === null || lifecycle.current !== session) {
        releaseVoiceReaderMicrophone(stream);
        return;
      }
      microphone.current = stream;
      setVoiceReaderEnabled(environmentId, threadId, true);
    } catch (failure) {
      if (session !== null && lifecycle.current === session)
        Dialog.alert("Não foi possível usar o microfone", message(failure));
    } finally {
      pending.current = false;
    }
  };
  if (!supported || environmentId === undefined || threadId === undefined) return [];
  const speaking = enabled && data !== null && data.current !== null;
  const actions: AppBarAction[] = [
    {
      icon: speaking ? "waveform" : "speaker.wave.2",
      accessibilityLabel: !enabled
        ? "Ler respostas"
        : data === null
          ? "Conectando ao Codex…"
          : "Lendo respostas — toque para desligar",
      selected: enabled,
      loading: enabled && data === null,
      onPress: () => {
        if (enabled) setVoiceReaderEnabled(environmentId, threadId, false);
        else void enable();
      },
    },
  ];
  return speaking
    ? [
        ...actions,
        {
          icon: "stop.fill",
          accessibilityLabel: "Parar a fala",
          onPress: () => driver.current?.stopCurrent(),
        },
      ]
    : actions;
}
