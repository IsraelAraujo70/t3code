import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  BOT_LIMITS,
  BotId,
  botThreadId,
  GuestId,
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
import * as BotsDb from "./BotsDb.ts";
import {
  BotsStore,
  layerFromDb as storeLayerFromDb,
  layerMemory as storeLayerMemory,
} from "./BotsStore.ts";
import * as GuestStore from "./guest/GuestStore.ts";

const SCRATCH = ProjectId.make("scratch-project");
const CODEX = ProviderInstanceId.make("codex");
const CLAUDE = ProviderInstanceId.make("claude");

const input: BotCreateInput = {
  name: "Al",
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
  const retitled = yield* Queue.unbounded<ThreadId>();

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
              title: thread.title,
              archivedAt: thread.archived ? DateTime.nowUnsafe() : null,
              deletedAt: null,
            } as unknown as OrchestrationV2ThreadShell);
      }),
    dispatch: (command: OrchestrationV2ServerCommand) =>
      Effect.gen(function* () {
        commands.push(command);
        if (command.type === "thread.archive") threads.get(command.threadId)!.archived = true;
        if (command.type === "thread.metadata.update" && command.title !== undefined) {
          threads.get(command.threadId)!.title = command.title;
          yield* Queue.offer(retitled, command.threadId);
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
      getInstance: (id: ProviderInstanceId) =>
        Effect.succeed(instances.find((instance) => instance.instanceId === id)),
    } as unknown as ProviderInstanceRegistry.ProviderInstanceRegistry["Service"]),
    NodeServices.layer,
  );

  return { threads, launches, commands, launched, retitled, layer };
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
      assert.strictEqual(launch.title, "Al");
      assert.strictEqual(launch.projectId, SCRATCH);
      assert.deepStrictEqual(launch.modelSelection, input.model);
      assert.strictEqual(launch.generateTitle, false);
      assert.strictEqual(launch.reuseExistingThread, undefined);
      assert.deepStrictEqual(launch.workspaceStrategy, { type: "root" });

      const second = yield* service.createBot({ ...input, name: "Bea" });
      assert.strictEqual(second.position, bot.position + 1);
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a bot only gets an enabled provider instance, and only the user's input grants management",
    () =>
      Effect.gen(function* () {
        const { orchestration, startService } = yield* setup();
        const service = yield* startService;
        const missing = { instanceId: ProviderInstanceId.make("gone"), model: "gpt-6.1-sol" };

        const refused = yield* Effect.flip(service.createBot({ ...input, model: missing }));
        assert.strictEqual(refused.message, "No enabled provider instance gone.");
        assert.deepStrictEqual(orchestration.launches, []);

        const bot = yield* service.createBot(input);
        assert.isFalse(bot.canManageBots);
        const stale = yield* Effect.flip(service.updateBot({ botId: bot.id, model: missing }));
        assert.strictEqual(stale.message, "No enabled provider instance gone.");

        const granted = yield* service.updateBot({ botId: bot.id, canManageBots: true });
        assert.isTrue(granted.canManageBots);
        assert.deepStrictEqual(granted.model, input.model);
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
        sectionId: null,
        position: 0,
        canManageBots: false,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      yield* store.insertBot(orphan);

      yield* startService;
      assert.strictEqual(yield* Queue.take(orchestration.launched), botThreadId(orphan.id, 1));
      assert.strictEqual(lastLaunch(orchestration).commandId, `bots:launch:${orphan.id}:1`);
      assert.isFalse(lastLaunch(orchestration).resumed);
      assert.strictEqual(lastLaunch(orchestration).title, "Al");

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

      yield* service.updateBot({ botId: bot.id, name: "Alfred" });
      assert.strictEqual(orchestration.threads.get(threadId)!.title, "Alfred");

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

  it.effect("a bot's save past the memory budget fails until it frees room; the user's never", () =>
    Effect.gen(function* () {
      const { startService } = yield* setup();
      const service = yield* startService;
      const bot = yield* service.createBot(input);
      const text = (letter: string) => letter.repeat(BOT_LIMITS.memory);
      const fill = Math.floor(BOT_LIMITS.memoryBudget / BOT_LIMITS.memory);
      const saved = [];
      for (let index = 0; index < fill; index += 1) {
        saved.push(yield* service.createMemory({ botId: bot.id, text: text(`${index}`) }, "bot"));
      }

      const full = yield* service
        .createMemory({ botId: bot.id, text: "One more fact" }, "bot")
        .pipe(Effect.flip);
      assert.include(full.message, "Your memory is full");
      assert.include(full.message, "memory_forget");

      // Disabled memories leave the prompt, so they free room as forgetting does.
      yield* service.updateMemory({ memoryId: saved[0]!.id, enabled: false });
      yield* service.createMemory({ botId: bot.id, text: "One more fact" }, "bot");

      // The user and imports are never refused, even past the budget.
      yield* service.updateMemory({ memoryId: saved[0]!.id, enabled: true });
      yield* service.createMemory({ botId: bot.id, text: "Set by the user" }, "user");
      yield* service.createMemory({ botId: bot.id, text: "From friend" }, "import");
      assert.strictEqual((yield* service.memoriesOf(bot.id)).length, fill + 3);
    }).pipe(Effect.scoped),
  );

  it.effect("startup drops the emoji an older build put in a bot's thread title", () =>
    Effect.gen(function* () {
      const { orchestration, startService } = yield* setup();
      const service = yield* startService;
      const bot = yield* service.createBot(input);
      const threadId = botThreadId(bot.id, 1);
      orchestration.threads.get(threadId)!.title = "🤖 Al";
      const commandsBefore = orchestration.commands.length;

      yield* startService;
      assert.strictEqual(yield* Queue.take(orchestration.retitled), threadId);
      assert.strictEqual(orchestration.threads.get(threadId)!.title, "Al");
      assert.strictEqual(orchestration.commands.length, commandsBefore + 1);
    }).pipe(Effect.scoped),
  );

  it.effect("sections: create, arrange, rename, and delete sends their bots home", () =>
    Effect.gen(function* () {
      const { startService } = yield* setup();
      const service = yield* startService;
      const al = yield* service.createBot(input);
      const bea = yield* service.createBot({ ...input, name: "Bea" });
      const work = yield* service.createSection({ name: "Work" });
      const home = yield* service.createSection({ name: "Home" });
      assert.match(work.id, /^s_[0-9a-f]{32}$/);
      assert.strictEqual(home.position, work.position + 1);

      yield* service.arrange({
        sectionIds: [home.id, work.id],
        bots: [
          { botId: bea.id, sectionId: work.id },
          { botId: al.id, sectionId: null },
        ],
      });
      const arranged = yield* Stream.runHead(service.directory).pipe(Effect.map(Option.getOrThrow));
      assert.deepStrictEqual(
        arranged.sections.map((section) => section.name),
        ["Home", "Work"],
      );
      assert.deepStrictEqual(
        arranged.bots.map((bot) => [bot.name, bot.sectionId]),
        [
          ["Bea", work.id],
          ["Al", null],
        ],
      );

      const renamed = yield* service.renameSection({ sectionId: work.id, name: "Job" });
      assert.strictEqual(renamed.name, "Job");

      yield* service.deleteSection({ sectionId: work.id });
      const after = yield* Stream.runHead(service.directory).pipe(Effect.map(Option.getOrThrow));
      assert.deepStrictEqual(
        after.sections.map((section) => section.id),
        [home.id],
      );
      assert.isTrue(after.bots.every((bot) => bot.sectionId === null));
    }).pipe(Effect.scoped),
  );

  it.effect("arrange refuses a stale view that misses a bot or names a gone section", () =>
    Effect.gen(function* () {
      const { startService } = yield* setup();
      const service = yield* startService;
      const al = yield* service.createBot(input);
      const bea = yield* service.createBot({ ...input, name: "Bea" });
      const work = yield* service.createSection({ name: "Work" });

      const missingBot = yield* service
        .arrange({ sectionIds: [work.id], bots: [{ botId: al.id, sectionId: work.id }] })
        .pipe(Effect.flip);
      assert.match(missingBot.message, /changed while you were arranging/);

      yield* service.deleteSection({ sectionId: work.id });
      const goneSection = yield* service
        .arrange({
          sectionIds: [],
          bots: [
            { botId: al.id, sectionId: work.id },
            { botId: bea.id, sectionId: null },
          ],
        })
        .pipe(Effect.flip);
      assert.match(goneSection.message, /changed while you were arranging/);
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
      assert.deepStrictEqual(yield* Queue.take(snapshots), {
        sections: [],
        bots: [],
        aboutMe: "",
        linkedEnvironmentBotIds: [],
        guestBotIds: [],
      });

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

describe("BotsService linked environments", () => {
  it.effect("only the user's switch lets a bot use linked environments, never a guest's bot", () =>
    Effect.gen(function* () {
      const orchestration = yield* makeOrchestration;
      const stores = yield* Layer.build(
        Layer.mergeAll(storeLayerFromDb, GuestStore.layerFromDb).pipe(
          Layer.provide(BotsDb.layerMemory),
        ),
      );
      const store = Context.get(stores, BotsStore);
      const guests = Context.get(stores, GuestStore.GuestStore);
      const service = yield* Layer.build(
        botsServiceLayer.pipe(
          Layer.provide(orchestration.layer),
          Layer.provide(Layer.succeedContext(stores)),
        ),
      ).pipe(Effect.map((context) => Context.get(context, BotsService)));
      const latest = Stream.runHead(service.directory).pipe(Effect.map(Option.getOrThrow));

      // Fields a bot management tool could smuggle in are not the switch.
      const smuggled = { linkedEnvironments: true, linkedEnvironmentBotIds: ["x"] };
      const bot = yield* service.createBot({ ...input, ...smuggled } as BotCreateInput);
      yield* service.updateBot({ botId: bot.id, role: "Still", ...smuggled } as never);
      assert.deepStrictEqual(yield* store.listLinkedEnvironmentBots, []);
      assert.deepStrictEqual((yield* latest).linkedEnvironmentBotIds, []);

      yield* service.setBotLinkedEnvironments({ botId: bot.id, linkedEnvironments: true });
      assert.deepStrictEqual((yield* latest).linkedEnvironmentBotIds, [bot.id]);
      yield* service.setBotLinkedEnvironments({ botId: bot.id, linkedEnvironments: false });
      assert.deepStrictEqual(yield* store.listLinkedEnvironmentBots, []);

      const guestBot = yield* service.createBot({ ...input, name: "Bia's" });
      yield* guests.insertGuest({
        id: GuestId.make("bia"),
        name: "Bia",
        tokenHash: null,
        tokenCreatedAt: null,
        createdAt: "2026-10-28T00:00:00.000Z",
        updatedAt: "2026-10-28T00:00:00.000Z",
      });
      yield* guests.assignBot(GuestId.make("bia"), guestBot.id, "2026-10-28T00:00:00.000Z");
      const refused = yield* Effect.flip(
        service.setBotLinkedEnvironments({ botId: guestBot.id, linkedEnvironments: true }),
      );
      assert.match(refused.message, /belongs to a guest/);
      assert.deepStrictEqual(yield* store.listLinkedEnvironmentBots, []);
      assert.deepStrictEqual((yield* latest).guestBotIds, [guestBot.id]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
