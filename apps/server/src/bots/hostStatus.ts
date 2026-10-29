/**
 * What the bots host was started with, for Settings → Bots → This host. Reads the same env vars
 * and files the features read, and reports only whether each is on, plus non-secret values.
 */
import type { BotsHostStatus } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

import { DEFAULT_VOICE } from "./voice/VoiceSession.ts";
import { DEFAULT_VOICE_LANGUAGE } from "./voice/voiceLanguage.ts";

export type BotsHostStaticStatus = Omit<BotsHostStatus, "hostMcp">;

/** Read once at startup, like the features themselves read their env. Stub: n1 implements it. */
export const readBotsHostStaticStatus: Effect.Effect<
  BotsHostStaticStatus,
  never,
  FileSystem.FileSystem
> = Effect.succeed({
  defaultVoice: DEFAULT_VOICE,
  defaultVoiceLanguage: DEFAULT_VOICE_LANGUAGE,
  voiceSamplesUrl: null,
  openRouter: false,
  androidPush: false,
  androidPushIssue: null,
  webhookPublicBaseUrl: null,
  kanbanPollSeconds: 0,
});

/**
 * The host MCP servers each bot gets, by name only, read on every call because the file may change
 * while the server runs. Stub: n1 implements it.
 */
export const readHostMcpServers: Effect.Effect<
  BotsHostStatus["hostMcp"],
  never,
  FileSystem.FileSystem
> = Effect.succeed([]);
