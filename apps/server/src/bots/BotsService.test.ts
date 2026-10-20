import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  BotId,
  botThreadId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type Bot,
  type BotCreateInput,
  type BotDirectory,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { BotsService, layer as botsServiceLayer } from "./BotsService.ts";
import { BotsStore, layerMemory as storeLayerMemory } from "./BotsStore.ts";

const SCRATCH = ProjectId.make("scratch-project");
const CODEX = ProviderInstanceId.make("codex");
const CLAUDE = ProviderInstanceId.make("claude");
const FRIEND_BOT_A = `b_${"a".repeat(32)}`;
const FRIEND_BOT_B = `b_${"b".repeat(32)}`;

const input: BotCreateInput = {
  name: "Al",
  emoji: "🤖",
  role: "Codes.",
  model: { instanceId: CODEX, model: "gpt-6.1-sol" },
};

interface FakeThread {
  title: string;
  archived: boolean;
  readonly model: string;
}

/**
 * A stand-in for the orchestration runtime: launches converge on their command id like the real
 * receipt, archive and retitle change the recorded thread, and every launch is offered to
 * `launched` so tests wait on it instead of sleeping.
 */
const makeOrchestration = Effect.gen(function* () {
  const threads = new Map<ThreadId, FakeThread>();
  const receipts = new Map<string, ThreadId>();
  const launches: Array<ThreadLaunchService.ThreadLaunchInput & { resumed: boolean }> = [];
  const commands: Array<OrchestrationV2ServerCommand> = [];
  const launched = yield* Queue.unbounded<ThreadId>();

  const launch = ThreadLaunchService.ThreadLaunchService.of({
    launch: (launchInput) =>
      Effect.gen(function* () {
        const threadId = launchInput.threadId!;
        const resumed = receipts.has(launchInput.commandId);
        if (!resumed) {
          receipts.set(launchInput.commandId, threadId);
          threads.set(threadId, {
            title: launchInput.title,
            archived: false,
            model: launchInput.modelSelection.model,
          });
        }
        launches.push({ ...launchInput, resumed });
        yield* Queue.offer(launched, threadId);
        return {
          threadId,
          resumed,
        } as unknown as ThreadLaunchService.ThreadLaunchResult;
      }),
    checkWorktreeBase: () => Effect.die("unused"),
    retryPreparation: () => Effect.die("unused"),
    prepareRun: () => Effect.die("unused"),
  });

  const management = {
    getThreadShell: (threadId: ThreadId) =>
      Effect.sync(() => {
        const thread = threads.get(threadId);
        return thread === undefined
          ? null
          : ({
              archivedAt: thread.archived ? DateTime.nowUnsafe() : null,
              deletedAt: null,
            } as unknown as OrchestrationV2ThreadShell);
      }),
    dispatch: (command: OrchestrationV2ServerCommand) =>
      Effect.sync(() => {
        commands.push(command);
        if (command.type === "thread.archive") threads.get(command.threadId)!.archived = true;
        if (command.type === "thread.metadata.update" && command.title !== undefined) {
          threads.get(command.threadId)!.title = command.title;
        }
        return {} as never;
      }),
  } as unknown as ThreadManagementService.ThreadManagementService["Service"];

  const instances = [
    { instanceId: CODEX, driverKind: "codex", enabled: true },
    { instanceId: CLAUDE, driverKind: "claudeAgent", enabled: true },
  ] as unknown as ReadonlyArray<ProviderInstance>;

  const layer = Layer.mergeAll(
    Layer.succeed(ThreadLaunchService.ThreadLaunchService, launch),
    Layer.succeed(ThreadManagementService.ThreadManagementService, management),
    Layer.succeed(ManagedProjectFolders.ManagedProjectFolders, {
      ensureScratchProject: Effect.succeed({ projectId: SCRATCH }),
    } as unknown as ManagedProjectFolders.ManagedProjectFolders["Service"]),
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      listInstances: Effect.succeed(instances),
    } as unknown as ProviderInstanceRegistry.ProviderInstanceRegistry["Service"]),
    NodeServices.layer,
  );

  return { threads, launches, commands, launched, layer };
});

type Orchestration = Effect.Success<typeof makeOrchestration>;

/** Builds the store, then a BotsService over it, in the test's scope. */
/** `storeOverrides` replaces store methods for the service only; tests read the real store. */
const setup = (
  options: {
    readonly storeOverrides?: (store: BotsStore["Service"]) => Partial<BotsStore["Service"]>;
  } = {},
) =>
  Effect.gen(function* () {
    const orchestration = yield* makeOrchestration;
    const storeContext = yield* Layer.build(storeLayerMemory);
    const baseStore = Context.get(storeContext, BotsStore);
    const store = BotsStore.of({ ...baseStore, ...options.storeOverrides?.(baseStore) });
    const startService = Layer.build(
      botsServiceLayer.pipe(
        Layer.provide(orchestration.layer),
        Layer.provide(Layer.succeed(BotsStore, store)),
      ),
    ).pipe(Effect.map((context) => Context.get(context, BotsService)));
    return { orchestration, store: baseStore, startService };
  });

const lastLaunch = (orchestration: Orchestration) =>
  orchestration.launches[orchestration.launches.length - 1]!;

describe("BotsService", () => {
  it.effect("creating a bot launches its main thread in Scratch", () =>
    Effect.gen(function* () {
      const { orchestration, startService } = yield* setup();
      const service = yield* startService;
      const bot = yield* service.createBot(input);

      assert.match(bot.id, /^b_[0-9a-f]{32}$/);
      assert.strictEqual(bot.homeGeneration, 1);
      const launch = lastLaunch(orchestration);
      assert.strictEqual(launch.threadId, `bot:${bot.id}:1`);
      assert.strictEqual(launch.commandId, `bots:launch:${bot.id}:1`);
      assert.strictEqual(launch.title, "🤖 Al");
      assert.strictEqual(launch.projectId, SCRATCH);
      assert.deepStrictEqual(launch.modelSelection, input.model);
      assert.strictEqual(launch.generateTitle, false);
      assert.strictEqual(launch.reuseExistingThread, undefined);
      assert.deepStrictEqual(launch.workspaceStrategy, { type: "root" });

      const second = yield* service.createBot({ ...input, name: "Bea" });
      assert.strictEqual(second.position, bot.position + 1);
    }).pipe(Effect.scoped),
  );

  it.effect("startup launches a bot whose row has no thread, and a restart converges", () =>
    Effect.gen(function* () {
      const { orchestration, store, startService } = yield* setup();
      // A row written without its thread, as after a crash between the two writes.
      const orphan: Bot = {
        ...input,
        id: BotId.make(`b_${"c".repeat(32)}`),
        homeGeneration: 1,
        position: 0,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      yield* store.insertBot(orphan);

      yield* startService;
      assert.strictEqual(yield* Queue.take(orchestration.launched), botThreadId(orphan.id, 1));
      assert.strictEqual(lastLaunch(orchestration).commandId, `bots:launch:${orphan.id}:1`);
      assert.isFalse(lastLaunch(orchestration).resumed);
      assert.strictEqual(lastLaunch(orchestration).title, "🤖 Al");

      // A second service over the same store and runtime, as after a restart.
      yield* startService;
      assert.strictEqual(yield* Queue.take(orchestration.launched), botThreadId(orphan.id, 1));
      assert.strictEqual(lastLaunch(orchestration).commandId, `bots:launch:${orphan.id}:1`);
      assert.isTrue(lastLaunch(orchestration).resumed);
      assert.strictEqual(orchestration.threads.size, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("renaming retitles the main thread; a model change waits for the next one", () =>
    Effect.gen(function* () {
      const { orchestration, startService } = yield* setup();
      const service = yield* startService;
      const bot = yield* service.createBot(input);
      const threadId = botThreadId(bot.id, 1);

      yield* service.updateBot({ botId: bot.id, name: "Alfred", emoji: "🎩" });
      assert.strictEqual(orchestration.threads.get(threadId)!.title, "🎩 Alfred");

      const commandsBefore = orchestration.commands.length;
      const updated = yield* service.updateBot({
        botId: bot.id,
        model: { instanceId: CLAUDE, model: "claude-opus-5-5" },
        role: "Writes.",
      });
      assert.strictEqual(orchestration.commands.length, commandsBefore);
      assert.strictEqual(orchestration.threads.get(threadId)!.model, "gpt-6.1-sol");

      const reset = yield* service.resetConversation({ botId: updated.id });
      assert.strictEqual(
        orchestration.threads.get(botThreadId(reset.id, 2))!.model,
        "claude-opus-5-5",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("reset archives the current generation and launches the next", () =>
    Effect.gen(function* () {
      const { orchestration, store, startService } = yield* setup();
      const service = yield* startService;
      const bot = yield* service.createBot(input);

      const reset = yield* service.resetConversation({ botId: bot.id });
      assert.strictEqual(reset.homeGeneration, 2);
      assert.strictEqual(Option.getOrThrow(yield* store.getBot(bot.id)).homeGeneration, 2);
      assert.isTrue(orchestration.threads.get(botThreadId(bot.id, 1))!.archived);
      assert.isFalse(orchestration.threads.get(botThreadId(bot.id, 2))!.archived);
      assert.isTrue(
        orchestration.launches.some(
          (launch) => launch.commandId === `bots:launch:${bot.id}:2` && !launch.resumed,
        ),
      );
      assert.deepStrictEqual(
        Option.map(yield* service.botForThread(botThreadId(bot.id, 1)), (found) => found.id),
        Option.some(bot.id),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("delete archives the main thread and removes the row and its memories", () =>
    Effect.gen(function* () {
      const { orchestration, store, startService } = yield* setup();
      const service = yield* startService;
      const bot = yield* service.createBot(input);
      yield* service.createMemory({ botId: bot.id, text: "Likes tea" }, "user");

      yield* service.deleteBot({ botId: bot.id });
      assert.isTrue(orchestration.threads.get(botThreadId(bot.id, 1))!.archived);
      assert.isTrue(Option.isNone(yield* store.getBot(bot.id)));
      assert.deepStrictEqual(yield* store.listMemories(bot.id), []);
      assert.isTrue(Option.isNone(yield* service.botForThread(botThreadId(bot.id, 1))));

      // Deleting again, with the thread already archived, still succeeds.
      yield* service.deleteBot({ botId: bot.id });
    }).pipe(Effect.scoped),
  );

  it.effect("memories: duplicates fail, updates and deletes apply by id", () =>
    Effect.gen(function* () {
      const { startService } = yield* setup();
      const service = yield* startService;
      const bot = yield* service.createBot(input);

      const memory = yield* service.createMemory({ botId: bot.id, text: "Likes tea" }, "bot");
      assert.match(memory.id, /^mem_[0-9a-f]{32}$/);
      assert.strictEqual(memory.source, "bot");
      assert.isTrue(memory.enabled);

      const duplicate = yield* service
        .createMemory({ botId: bot.id, text: "Likes tea" }, "user")
        .pipe(Effect.flip);
      assert.strictEqual(duplicate.message, "This bot already remembers that.");

      const missingBot = yield* service
        .createMemory({ botId: BotId.make("b_missing"), text: "x" }, "user")
        .pipe(Effect.flip);
      assert.include(missingBot.message, "does not exist");

      yield* service.updateMemory({ memoryId: memory.id, enabled: false, text: "Likes coffee" });
      const [updated] = yield* service.memoriesOf(bot.id);
      assert.strictEqual(updated!.text, "Likes coffee");
      assert.isFalse(updated!.enabled);

      yield* service.deleteMemory({ memoryId: memory.id });
      assert.deepStrictEqual(yield* service.memoriesOf(bot.id), []);
    }).pipe(Effect.scoped),
  );

  it.effect("botForThread is none for threads that are not bot conversations", () =>
    Effect.gen(function* () {
      const { startService } = yield* setup();
      const service = yield* startService;
      assert.isTrue(Option.isNone(yield* service.botForThread(ThreadId.make("thread-1"))));
      assert.isTrue(Option.isNone(yield* service.botForThread(ThreadId.make("bot:b_gone:1"))));
    }).pipe(Effect.scoped),
  );

  it.effect("directory publishes a new snapshot only once a write commits", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const gate = yield* Deferred.make<void>();
      const { startService } = yield* setup({
        storeOverrides: (store) => ({
          setAboutMe: (text) =>
            Deferred.succeed(entered, undefined).pipe(
              Effect.andThen(Deferred.await(gate)),
              Effect.andThen(store.setAboutMe(text)),
            ),
        }),
      });
      const service = yield* startService;
      const snapshots = yield* Queue.unbounded<BotDirectory>();
      yield* service.directory.pipe(
        Stream.runForEach((snapshot) => Queue.offer(snapshots, snapshot)),
        Effect.forkScoped,
      );
      assert.deepStrictEqual(yield* Queue.take(snapshots), { bots: [], aboutMe: "" });

      const write = yield* service.updateOwner({ aboutMe: "I build T3" }).pipe(Effect.forkScoped);
      yield* Deferred.await(entered);
      const early = yield* Queue.take(snapshots).pipe(
        Effect.timeoutOption("1 second"),
        Effect.forkScoped,
      );
      yield* TestClock.adjust("1 second");
      assert.isTrue(Option.isNone(yield* Fiber.join(early)));

      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(write);
      assert.strictEqual((yield* Queue.take(snapshots)).aboutMe, "I build T3");

      const bot = yield* service.createBot(input);
      const withBot = yield* Queue.take(snapshots);
      assert.deepStrictEqual(
        withBot.bots.map((entry) => [entry.id, entry.homeThreadId]),
        [[bot.id, botThreadId(bot.id, 1)]],
      );
    }).pipe(Effect.scoped),
  );
});

/** A friend.db with the columns the import reads. */
function writeFriendFixture(path: string): void {
  const db = new NodeSqlite.DatabaseSync(path);
  db.exec(`
    CREATE TABLE bots (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL, emoji TEXT NOT NULL, role TEXT NOT NULL, model TEXT NOT NULL,
      mcp_servers TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, effort TEXT
    );
    CREATE TABLE memories (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, bot_id TEXT NOT NULL,
      text TEXT NOT NULL, source TEXT NOT NULL, enabled INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  const insertBot = db.prepare(
    `INSERT INTO bots (id, name, emoji, role, model, mcp_servers, created_at, updated_at, effort)
     VALUES (?, ?, ?, ?, ?, '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ?)`,
  );
  insertBot.run(FRIEND_BOT_A, "Al", "🤖", "Codes", "claude-opus-5-5", "high");
  insertBot.run(FRIEND_BOT_B, "Bea", "🐝", "Writes", "gpt-6.1-sol", null);
  db.prepare(
    `INSERT INTO memories (id, bot_id, text, source, enabled, created_at, updated_at)
     VALUES (?, ?, 'Likes tea', 'user', 1, '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z')`,
  ).run(`mem_${"1".repeat(32)}`, FRIEND_BOT_A);
  db.prepare("INSERT INTO settings (key, value) VALUES ('aboutMe', 'I am Israel')").run();
  db.close();
}

describe("BotsService.importFriend", () => {
  it.effect("a dry run writes nothing; apply writes and launches once", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const friendPath = path.join(
        yield* fs.makeTempDirectoryScoped({ prefix: "bots-svc-" }),
        "friend.db",
      );
      writeFriendFixture(friendPath);

      const { orchestration, store, startService } = yield* setup();
      const service = yield* startService;
      const existing = yield* service.createBot(input);

      const plan = yield* service.importFriend({ path: friendPath, apply: false });
      assert.isFalse(plan.applied);
      assert.deepStrictEqual(
        plan.bots.map((bot) => [bot.sourceId, bot.status]),
        [
          [FRIEND_BOT_A, "new"],
          [FRIEND_BOT_B, "new"],
        ],
      );
      assert.strictEqual((yield* store.listBots).length, 1);
      assert.strictEqual(yield* store.getAboutMe, "");
      assert.strictEqual(orchestration.threads.size, 1);

      const applied = yield* service.importFriend({ path: friendPath, apply: true });
      assert.isTrue(applied.applied);
      const bots = yield* store.listBots;
      assert.deepStrictEqual(
        bots.map((bot) => bot.id),
        [existing.id, FRIEND_BOT_A, FRIEND_BOT_B],
      );
      assert.deepStrictEqual(
        bots.map((bot) => bot.position),
        [0, 1, 2],
      );
      assert.strictEqual((yield* store.listMemories(BotId.make(FRIEND_BOT_A))).length, 1);
      assert.strictEqual(yield* store.getAboutMe, "I am Israel");
      assert.strictEqual(
        orchestration.threads.get(botThreadId(BotId.make(FRIEND_BOT_A), 1))!.model,
        "claude-opus-5-5",
      );
      assert.isTrue(orchestration.threads.has(botThreadId(BotId.make(FRIEND_BOT_B), 1)));

      const launchesBefore = orchestration.launches.length;
      const again = yield* service.importFriend({ path: friendPath, apply: true });
      assert.deepStrictEqual(
        again.bots.map((bot) => bot.status),
        ["exists", "exists"],
      );
      assert.strictEqual((yield* store.listBots).length, 3);
      assert.strictEqual((yield* store.listMemories()).length, 1);
      // Startup reconciliation may also run meanwhile; every later launch only replays.
      assert.isTrue(orchestration.launches.slice(launchesBefore).every((launch) => launch.resumed));
      assert.strictEqual(orchestration.threads.size, 3);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
