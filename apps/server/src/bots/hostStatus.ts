/**
 * What the bots host was started with, for Settings → Bots → This host. Reads the same env vars
 * and files the features read, and reports only whether each is on, plus non-secret values.
 */
import type { BotsHostStatus } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { DEFAULT_VOICE } from "./voice/VoiceSession.ts";
import { DEFAULT_VOICE_LANGUAGE } from "./voice/voiceLanguage.ts";

// Stub: n1-host-status implements it.
export const readBotsHostStatus: Effect.Effect<BotsHostStatus> = Effect.succeed({
  defaultVoice: DEFAULT_VOICE,
  defaultVoiceLanguage: DEFAULT_VOICE_LANGUAGE,
  voiceSamplesUrl: null,
  openRouter: false,
  androidPush: false,
  androidPushIssue: null,
  webhookPublicBaseUrl: null,
  kanbanPollSeconds: 0,
  hostMcp: [],
});
