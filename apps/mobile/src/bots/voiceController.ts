import { useSyncExternalStore } from "react";
import { Platform } from "react-native";
import type { EnvironmentId } from "@t3tools/contracts";
import { useServerConfigs } from "../state/entities";
import { createVoiceTransport } from "@t3tools/client-runtime/state/bots";
import { createVoiceController, sameVoiceTarget } from "@t3tools/client-runtime/voice";

import * as Dialog from "../components/ui/Dialog";
import { appAtomRegistry } from "../state/atom-registry";
import { botsEnvironment } from "./state";
import { openNativeVoicePeer } from "./voicePeer";

/** The app's single voice session, shared by conversations and reply playback. */
export const voiceController = createVoiceController({
  openPeer: openNativeVoicePeer,
  transport: createVoiceTransport(appAtomRegistry, botsEnvironment),
  sameTarget: sameVoiceTarget,
  onError: (description) => Dialog.alert("Falha na voz", description),
  // Android's libwebrtc gathers stats on the network thread that also receives the voice's audio,
  // so a live session never asks; it samples once as it ends.
  liveStats: false,
});

/** Observes the app's single voice session. */
export function useVoiceSnapshot() {
  return useSyncExternalStore(voiceController.subscribe, voiceController.getSnapshot);
}

/** Native voice is currently supported only by the Android WebRTC plugin. */
export function useVoiceAvailable(environmentId: EnvironmentId) {
  const configs = useServerConfigs();
  return (
    Platform.OS === "android" && configs.get(environmentId)?.environment.capabilities.voice === true
  );
}
