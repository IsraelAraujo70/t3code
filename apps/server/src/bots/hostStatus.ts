/**
 * What the bots host was started with, for Settings → Bots → This host. Reads the same env vars
 * and files the features read, and reports only whether each is on, plus non-secret values.
 */
import * as NodeOS from "node:os";
import { BotId, type BotsHostStatus } from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { readVoice } from "./voice/VoiceSession.ts";
import { readVoiceLanguage, readVoiceSamplesUrl } from "./voice/voiceLanguage.ts";
import { isDictationConfigured } from "./dictation/Dictation.ts";
import { FCM_SERVICE_ACCOUNT_ENV, readServiceAccount } from "./push/BotPushDelivery.ts";
import { readWebhookPublicBaseUrl } from "./webhookPublicBase.ts";
import { readKanbanPollSeconds } from "./kanban/KanbanPoller.ts";
import { HOST_MCP_FILE_ENV, HostMcpConfig } from "./guest/HostMcpForward.ts";

export type BotsHostStaticStatus = Omit<BotsHostStatus, "hostMcp">;

/** Read host configuration once at startup without exposing credential paths. */
export const readBotsHostStaticStatus: Effect.Effect<
  BotsHostStaticStatus,
  never,
  FileSystem.FileSystem
> = Effect.gen(function* () {
  const file = yield* Config.String(FCM_SERVICE_ACCOUNT_ENV).pipe(
    Config.withDefault(""),
    Effect.orElseSucceed(() => ""),
  );
  const androidPush = file.trim() !== "";
  // The loader delivery itself uses, so On means delivery could start.
  const usable =
    !androidPush ||
    (yield* readServiceAccount(file).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    ));
  return {
    defaultVoice: yield* readVoice,
    defaultVoiceLanguage: yield* readVoiceLanguage,
    voiceSamplesUrl: yield* readVoiceSamplesUrl,
    openRouter: yield* isDictationConfigured,
    androidPush,
    androidPushIssue: usable ? null : "The service account key file cannot be read as a key.",
    webhookPublicBaseUrl: yield* readWebhookPublicBaseUrl,
    kanbanPollSeconds: Math.max(0, yield* readKanbanPollSeconds),
  };
});

/** The host MCP file HostMcpForward reads, resolved once at startup like the rest of the status. */
export const hostMcpConfigFile: Effect.Effect<string, never, Path.Path> = Effect.gen(function* () {
  const path = yield* Path.Path;
  const home = NodeOS.homedir();
  // This default must match HostMcpForward's default.
  const defaultFile = path.join(home, ".t3-friend", "bot-host-mcp.json");
  const file = yield* Config.String(HOST_MCP_FILE_ENV).pipe(
    Config.withDefault(defaultFile),
    Effect.orElseSucceed(() => defaultFile),
  );
  return file.startsWith("~/") ? path.join(home, file.slice(2)) : file;
});

/**
 * Server names per bot in `file`, re-read for every directory because the file may change while
 * the server runs. Names only, so a snapshot never carries a URL, token or token path.
 */
export const readHostMcpServers = Effect.fn("BotsHostStatus.readHostMcpServers")(
  function* (file: string) {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* fs
      .readFileString(file)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(HostMcpConfig))));
    const isBotId = Schema.is(BotId);
    return Object.entries(config)
      .filter(([botId, servers]) => isBotId(botId) && servers.length > 0)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([botId, servers]) => ({
        botId: BotId.make(botId),
        servers: servers.map((server) => server.name),
      }));
  },
  Effect.orElseSucceed((): BotsHostStatus["hostMcp"] => []),
);
