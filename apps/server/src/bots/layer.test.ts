import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { botThreadId, BotId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import { isBotsHost, NOT_BOTS_HOST_MESSAGE } from "./BotsHost.ts";
import * as BotsInstructions from "./BotsInstructions.ts";
import * as BotsService from "./BotsService.ts";
import * as BotsStore from "./BotsStore.ts";
import { ServerConfig } from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as BotsLayer from "./layer.ts";
import * as WorkflowDefinitions from "./workflows/definitions/WorkflowDefinitions.ts";

const withEnv = (env: Record<string, string>) =>
  ConfigProvider.layer(ConfigProvider.fromEnv({ env }));

describe("bots host gate", () => {
  it.effect("only T3CODE_BOTS_HOST=1 makes a server the bots host", () =>
    Effect.gen(function* () {
      assert.isFalse(yield* isBotsHost.pipe(Effect.provide(withEnv({}))));
      assert.isFalse(yield* isBotsHost.pipe(Effect.provide(withEnv({ T3CODE_BOTS_HOST: "nope" }))));
      assert.isTrue(yield* isBotsHost.pipe(Effect.provide(withEnv({ T3CODE_BOTS_HOST: "1" }))));
    }),
  );

  it.effect("a server that is not the host serves no bots and injects no instructions", () =>
    Effect.gen(function* () {
      const service = yield* BotsService.BotsService;
      const store = yield* BotsStore.BotsStore;
      const instructions = yield* BotsInstructions.BotsInstructions;
      const botThread = botThreadId(BotId.make("b_0123"), 1);

      const directory = yield* Effect.exit(Stream.runCollect(service.directory));
      assert.isTrue(Exit.isFailure(directory));
      const created = yield* Effect.flip(
        service.createBot({
          name: "Ada",
          role: "",
          model: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
        }),
      );
      assert.strictEqual(created.message, NOT_BOTS_HOST_MESSAGE);
      assert.isTrue(Exit.isFailure(yield* Effect.exit(store.listBots)));
      assert.isTrue(Option.isNone(yield* service.botForThread(botThread)));
      assert.isUndefined(yield* instructions.forThread(botThread));
      assert.isUndefined(yield* instructions.forThread(ThreadId.make("ordinary-thread")));
    }).pipe(Effect.provide(BotsLayer.layerOff)),
  );
});

describe("workflows on the bots host", () => {
  it.live("keep their tables in bots.sqlite, never in the server's database", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped();
        const source = yield* fs.readFileString(
          `${import.meta.dirname}/workflows/library/mcp-token-cut.workflow.yaml`,
        );
        yield* Effect.gen(function* () {
          const definitions = yield* WorkflowDefinitions.WorkflowDefinitions;
          const saved = yield* definitions.save({ source, message: "First" }, { kind: "user" });
          assert.strictEqual(saved._tag, "Saved");
          const serverDb = yield* SqlClient.SqlClient;
          const tables = yield* serverDb<{
            readonly name: string;
          }>`SELECT name FROM sqlite_master WHERE name LIKE 'workflow_%'`;
          assert.deepStrictEqual(tables, []);
        }).pipe(
          Effect.provide(
            BotsLayer.layerWorkflows.pipe(
              Layer.provideMerge(SqlitePersistence.layerMemory),
              Layer.provide(ServerConfig.layerTest(root, root)),
            ),
          ),
        );
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
});
