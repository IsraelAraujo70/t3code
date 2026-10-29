import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  BotId,
  BotsError,
  ChatAttachmentId,
  GuestId,
  MessageId,
  ThreadId,
  botThreadId,
  type OrchestrationV2ConversationMessage,
} from "@t3tools/contracts";
import type { AppTools } from "@t3tools/provider-core/server/ProviderAdapter";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../config.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as BotsDb from "../BotsDb.ts";
import { CodexImages, type SourceImage } from "./CodexImages.ts";
import * as GuestArtifacts from "./GuestArtifacts.ts";
import * as GuestStore from "./GuestStore.ts";
import { GuestTools, layer as guestToolsLayer } from "./GuestTools.ts";
import { HostMcpForward } from "./HostMcpForward.ts";

const at = "2026-01-01T00:00:00.000Z";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const biaBot = BotId.make("b_bia");
const anaBot = BotId.make("b_ana");
const ownerBot = BotId.make("b_owner");
const financeBot = BotId.make("b_finance");
const biaThread = botThreadId(biaBot, 1);
const anaThread = botThreadId(anaBot, 1);

const message = (
  threadId: ThreadId,
  id: string,
  attachments: OrchestrationV2ConversationMessage["attachments"],
): OrchestrationV2ConversationMessage => ({
  id: MessageId.make(id),
  threadId,
  runId: null,
  nodeId: null,
  role: "user",
  text: "olha",
  attachments,
  streaming: false,
  createdBy: "user",
  creationSource: "server",
  createdAt: DateTime.makeUnsafe(at),
  updatedAt: DateTime.makeUnsafe(at),
});

const photo = (id: string) => ({
  type: "image" as const,
  id: ChatAttachmentId.make(id),
  name: `${id}.png`,
  mimeType: "image/png",
  sizeBytes: PNG.byteLength,
});

/** Bia's conversation has her photo; Ana's has another one. */
const messagesByThread: Record<string, OrchestrationV2ConversationMessage[]> = {
  [biaThread]: [message(biaThread, "guest:1", [photo("bia-photo")])],
  [anaThread]: [message(anaThread, "guest:2", [photo("ana-photo")])],
};

const setup = (env: Record<string, string> = {}) => {
  const generated: Array<{ prompt: string; images: ReadonlyArray<SourceImage> }> = [];
  const codex = Layer.succeed(
    CodexImages,
    CodexImages.of({
      generate: (input) =>
        Effect.sync(() => {
          generated.push({ prompt: input.prompt, images: input.images });
          return { mimeType: "image/png" as const, bytes: PNG, revisedPrompt: "a cat" };
        }),
    }),
  );
  const projections = Layer.mock(ProjectionStore.ProjectionStoreV2)({
    getThreadRecords: (threadId) =>
      Effect.succeed({ messages: messagesByThread[threadId] ?? [] } as never),
  });
  // Bia's bot and the owner's finance bot have a host MCP server configured; forwarding for
  // every other bot breaks outright.
  const hostMcp = Layer.succeed(
    HostMcpForward,
    HostMcpForward.of({
      forBot: (botId) =>
        botId === biaBot || botId === financeBot
          ? Effect.succeed([{ server: "pluggy", tools: [] }])
          : Effect.die(new Error("forwarding broke")),
    }),
  );
  const layer = guestToolsLayer.pipe(
    Layer.provide(hostMcp),
    Layer.provideMerge(GuestArtifacts.layerFromDb),
    Layer.provideMerge(GuestStore.layerFromDb),
    Layer.provideMerge(BotsDb.layerMemory),
    Layer.provide(codex),
    Layer.provide(projections),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-guest-tools-" })),
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
  );
  return { generated, layer };
};

/** Two guests, each with a bot, plus two bots only the owner uses; photos on disk. */
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const guests = yield* GuestStore.GuestStore;
  for (const id of [biaBot, anaBot, ownerBot, financeBot]) {
    yield* sql`
      INSERT INTO bots (id, name, role, model_json, home_generation, position, created_at, updated_at)
      VALUES (${id}, ${id}, 'Helps out.', '{}', 1, 0, ${at}, ${at})
    `;
  }
  for (const [guest, bot] of [
    ["bia", biaBot],
    ["ana", anaBot],
  ] as const) {
    yield* guests.insertGuest({
      id: GuestId.make(guest),
      name: guest,
      tokenHash: null,
      tokenCreatedAt: null,
      createdAt: at,
      updatedAt: at,
    });
    yield* guests.assignBot(GuestId.make(guest), bot, at);
  }
  const { attachmentsDir } = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(attachmentsDir, { recursive: true });
  for (const id of ["bia-photo", "ana-photo"]) {
    yield* fs.writeFile(path.join(attachmentsDir, `${id}.png`), PNG);
  }
});

const toolsOf = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const servers = yield* (yield* GuestTools).forThread(threadId);
    const tools = servers?.[0];
    if (tools === undefined) return yield* new BotsError({ message: "no tools" });
    return tools;
  });

const call = (tools: AppTools, name: string, args: unknown) =>
  Effect.promise(() => tools.tools.find((tool) => tool.name === name)!.run(args));

describe("GuestTools", () => {
  it.effect("offers its tools only to guest bots and host MCP servers to any listed bot", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      yield* seed;
      const service = yield* GuestTools;
      assert.isUndefined(yield* service.forThread(botThreadId(ownerBot, 1)));
      assert.isUndefined(yield* service.forThread(ThreadId.make("thread-1")));
      const tools = yield* toolsOf(biaThread);
      assert.deepStrictEqual(
        tools.tools.map((tool) => tool.name),
        ["generate_image", "list_images", "html_render"],
      );
      // The bot's own server comes first, then its host MCP servers.
      const servers = (yield* service.forThread(biaThread)) ?? [];
      assert.deepStrictEqual(
        servers.map((server) => server.server),
        ["t3-guest", "pluggy"],
      );
      // A broken forward never costs the bot its own tools.
      const anaServers = (yield* service.forThread(anaThread)) ?? [];
      assert.deepStrictEqual(
        anaServers.map((server) => server.server),
        ["t3-guest"],
      );
      // The owner's listed bot gets its host MCP servers and none of the guest tools.
      const financeServers = (yield* service.forThread(botThreadId(financeBot, 1))) ?? [];
      assert.deepStrictEqual(
        financeServers.map((server) => server.server),
        ["pluggy"],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("generates an image into the conversation as an artifact with its file", () => {
    const { layer, generated } = setup();
    return Effect.gen(function* () {
      yield* seed;
      const tools = yield* toolsOf(biaThread);
      const result = yield* call(tools, "generate_image", {
        prompt: "um gato",
        edit_image_ids: ["bia-photo"],
      });
      assert.isUndefined(result.isError);
      assert.deepStrictEqual(generated[0]?.images, [{ mimeType: "image/png", bytes: PNG }]);
      const [artifact] = yield* (yield* GuestArtifacts.GuestArtifacts).listForThread(biaThread);
      assert.strictEqual(artifact?.kind, "image");
      assert.include(result.text, artifact!.id);
      const { attachmentsDir } = yield* ServerConfig.ServerConfig;
      const path = yield* Path.Path;
      const stored = yield* (yield* FileSystem.FileSystem).readFile(
        path.join(attachmentsDir, `${artifact!.id}.png`),
      );
      assert.deepStrictEqual(stored, PNG);
      // The image it made is itself editable and listed.
      assert.include((yield* call(tools, "list_images", {})).text, artifact!.id);
    }).pipe(Effect.provide(layer));
  });

  it.effect("edits only images of its own conversation", () => {
    const { layer, generated } = setup();
    return Effect.gen(function* () {
      yield* seed;
      const tools = yield* toolsOf(biaThread);
      // Another guest's photo, a path, and a traversal never reach Codex or the disk.
      for (const id of ["ana-photo", "/etc/passwd", "../bia-photo", "bia-photo/../ana-photo"]) {
        const result = yield* call(tools, "generate_image", { prompt: "x", edit_image_ids: [id] });
        assert.isTrue(result.isError, id);
      }
      assert.lengthOf(generated, 0);
      assert.notInclude((yield* call(tools, "list_images", {})).text, "ana-photo");
    }).pipe(Effect.provide(layer));
  });

  it.effect("rejects arguments it does not define, like a thread or a path", () => {
    const { layer, generated } = setup();
    return Effect.gen(function* () {
      yield* seed;
      const tools = yield* toolsOf(biaThread);
      const result = yield* call(tools, "generate_image", { prompt: "x", threadId: anaThread });
      assert.isTrue(result.isError);
      const page = yield* call(tools, "html_render", {
        html: "<p>oi</p>",
        title: "t",
        height: 100,
        path: "/tmp/x.html",
      });
      assert.isTrue(page.isError);
      assert.lengthOf(generated, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("stops at the daily image allowance", () => {
    const { layer, generated } = setup({ T3CODE_GUEST_IMAGES_PER_DAY: "1" });
    return Effect.gen(function* () {
      yield* seed;
      const tools = yield* toolsOf(biaThread);
      assert.isUndefined((yield* call(tools, "generate_image", { prompt: "1" })).isError);
      const second = yield* call(tools, "generate_image", { prompt: "2" });
      assert.isTrue(second.isError);
      assert.include(second.text, "allowance");
      assert.lengthOf(generated, 1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("stores a page as given plus the theme bootstrap, inlining no local file", () => {
    const { layer } = setup();
    return Effect.gen(function* () {
      yield* seed;
      const tools = yield* toolsOf(biaThread);
      const html = '<html><body><img src="/etc/hostname.png"><p>Oi</p></body></html>';
      const result = yield* call(tools, "html_render", { html, title: "Lista", height: 5000 });
      assert.isUndefined(result.isError);
      const [artifact] = yield* (yield* GuestArtifacts.GuestArtifacts).listForThread(biaThread);
      assert.strictEqual(artifact?.kind, "html");
      assert.strictEqual(artifact?.name, "Lista");
      assert.strictEqual(artifact?.height, 2000);
      const { attachmentsDir } = yield* ServerConfig.ServerConfig;
      const path = yield* Path.Path;
      const stored = yield* (yield* FileSystem.FileSystem).readFileString(
        path.join(attachmentsDir, `${artifact!.id}.html`),
      );
      assert.include(stored, 'id="t3-theme"');
      assert.include(stored, '<img src="/etc/hostname.png">');
      // Ana's conversation sees nothing of Bia's.
      assert.lengthOf(yield* (yield* GuestArtifacts.GuestArtifacts).listForThread(anaThread), 0);
    }).pipe(Effect.provide(layer));
  });
});
