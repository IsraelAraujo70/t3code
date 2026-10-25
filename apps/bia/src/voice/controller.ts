import {
  createVoiceController,
  type VoicePhase,
  type VoiceSnapshot,
} from "@t3tools/client-runtime/voice";
import type { MessageId } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";
import { Alert, Platform } from "react-native";

import type { BotId } from "../api";
import { openNativeVoicePeer } from "./peer";
import { guestVoiceTransport, sameBiaVoiceTarget, type BiaVoiceTarget } from "./transport";

/** The app's single voice session, shared by conversations and listening to a reply. */
export const voiceController = createVoiceController<BiaVoiceTarget>({
  openPeer: openNativeVoicePeer,
  transport: guestVoiceTransport,
  sameTarget: sameBiaVoiceTarget,
  onError: (message) => Alert.alert("A voz parou", message),
  // Android's libwebrtc gathers stats on the network thread that also receives the voice's audio,
  // so a live session never asks; it samples once as it ends.
  liveStats: false,
});

/** Only Android's audio is set up for the voice (`withFriendVoiceReaderWebrtc`). */
export const voiceAvailable = Platform.OS === "android";

export function useVoiceSnapshot(): VoiceSnapshot<BiaVoiceTarget> | null {
  return useSyncExternalStore(voiceController.subscribe, voiceController.getSnapshot);
}

/** The conversation with `botId`, when it is the current session. */
export function conversationOf(
  snapshot: VoiceSnapshot<BiaVoiceTarget> | null,
  botId: BotId,
): VoiceSnapshot<BiaVoiceTarget> | null {
  return snapshot?.target.botId === botId && snapshot.target.mode.type === "conversation"
    ? snapshot
    : null;
}

/** The phase of listening to `messageId`, or null when that reply is not being read. */
export function readPhaseOf(
  snapshot: VoiceSnapshot<BiaVoiceTarget> | null,
  botId: BotId,
  messageId: MessageId,
): VoicePhase | null {
  const mode = snapshot?.target.mode;
  return snapshot?.target.botId === botId && mode?.type === "read" && mode.messageId === messageId
    ? snapshot.phase
    : null;
}

/** Ends whatever voice session talks to `botId`, e.g. when its chat closes. */
export function stopVoiceFor(botId: BotId): void {
  if (voiceController.getSnapshot()?.target.botId === botId) voiceController.stop();
}
