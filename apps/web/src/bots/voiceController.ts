import { useSyncExternalStore } from "react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useServerConfigs } from "../state/entities";
import { createVoiceTransport } from "@t3tools/client-runtime/state/bots";
import { createVoiceController, sameVoiceTarget } from "@t3tools/client-runtime/voice";

import { toastManager } from "../components/ui/toast";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { botsEnvironment } from "../state/bots";
import { openBrowserVoicePeer } from "./voicePeer";

/** The page's single voice session, shared by conversations and message reads. */
export const voiceController = createVoiceController({
  openPeer: openBrowserVoicePeer,
  transport: createVoiceTransport(appAtomRegistry, botsEnvironment),
  sameTarget: sameVoiceTarget,
  onError: (description) => toastManager.add({ type: "error", title: "Voice failed", description }),
});

/** Subscribes to session changes, independently of audio levels. */
export function useVoiceSnapshot() {
  return useSyncExternalStore(voiceController.subscribe, voiceController.getSnapshot);
}

/** Whether this thread's environment advertises voice support. */
export function useVoiceAvailable(environmentId: EnvironmentId) {
  return useServerConfigs().get(environmentId)?.environment.capabilities.voice === true;
}
