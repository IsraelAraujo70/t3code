import { assert, it } from "@effect/vitest";
import { BotId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { hostMcpConfigFile } from "./guest/HostMcpForward.ts";
import { readBotsHostStaticStatus, readHostMcpServers } from "./hostStatus.ts";

const run = (env: Record<string, string>) =>
  Effect.gen(function* () {
    const file = yield* hostMcpConfigFile;
    return { ...(yield* readBotsHostStaticStatus), hostMcp: yield* readHostMcpServers(file) };
  }).pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))));

it.effect("reports startup defaults", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    assert.deepStrictEqual(yield* run({ T3CODE_BOT_HOST_MCP_FILE: `${dir}/missing` }), {
      defaultVoice: "cove",
      defaultVoiceLanguage: "en",
      voiceSamplesUrl: null,
      openRouter: false,
      androidPush: false,
      androidPushIssue: null,
      webhookPublicBaseUrl: null,
      kanbanPollSeconds: 60,
      hostMcp: [],
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("reports enabled configuration without MCP secrets", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    const file = `${dir}/mcp.json`;
    const url = "http://127.0.0.1:8765";
    const tokenFile = `${dir}/secret`;
    yield* fs.writeFileString(
      file,
      JSON.stringify({
        zebra: [
          { name: "one", url, tokenFile },
          { name: "two", url, tokenFile },
        ],
        alpha: [{ name: "three", url, tokenFile }],
      }),
    );
    const fcmFile = `${dir}/fcm.json`;
    yield* fs.writeFileString(fcmFile, "{}");
    const result = yield* run({
      T3CODE_BOT_HOST_MCP_FILE: file,
      T3CODE_VOICE_LANGUAGE: "pt-BR",
      T3CODE_WEBHOOK_PUBLIC_BASE_URL: "https://example.com",
      // A regular file that is no service account key: delivery would stay off.
      T3CODE_FCM_SERVICE_ACCOUNT_FILE: fcmFile,
    });
    assert.strictEqual(result.androidPush, true);
    assert.strictEqual(
      result.androidPushIssue,
      "The service account key file cannot be read as a key.",
    );
    assert.strictEqual(result.defaultVoiceLanguage, "pt-BR");
    assert.strictEqual(result.webhookPublicBaseUrl, "https://example.com");
    assert.deepStrictEqual(result.hostMcp, [
      { botId: BotId.make("alpha"), servers: ["three"] },
      { botId: BotId.make("zebra"), servers: ["one", "two"] },
    ]);
    for (const secret of [url, tokenFile, "tokenFile"])
      assert.ok(!JSON.stringify(result).includes(secret));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("ignores invalid MCP JSON", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    const file = `${dir}/mcp.json`;
    yield* fs.writeFileString(file, "{");
    assert.deepStrictEqual((yield* run({ T3CODE_BOT_HOST_MCP_FILE: file })).hostMcp, []);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
