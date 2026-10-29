import {
  BotId,
  BotMemoryId,
  botThreadId,
  KanbanTicketId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type Bot,
  type BotMemory,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as BotsDb from "./BotsDb.ts";
import { BotsStore, layerFromDb, layerMemory } from "./BotsStore.ts";
import * as KanbanStore from "./kanban/KanbanStore.ts";
import * as ThreadWatchStore from "./threadWatch/ThreadWatchStore.ts";

const makeBot = (id: string, overrides: Partial<Bot> = {}): Bot => ({
  id: BotId.make(id),
  name: `Bot ${id}`,
  role: "Helps out.",
  model: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  homeGeneration: 1,
  sectionId: null,
  position: 0,
  canManageBots: false,
  rotation: "daily",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

const makeMemory = (id: string, botId: string, overrides: Partial<BotMemory> = {}): BotMemory => ({
  id: BotMemoryId.make(id),
  botId: BotId.make(botId),
  text: `Memory ${id}`,
  source: "user",
  enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

/** Every test gets its own migrated in-memory database. */
const withStore = <A, E>(f: (store: typeof BotsStore.Service) => Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    return yield* f(yield* BotsStore);
  }).pipe(Effect.provide(layerMemory));

it.effect("lists bots by position, then createdAt", () =>
  withStore((store) =>
    Effect.gen(function* () {
      yield* store.insertBot(makeBot("late", { position: 1, createdAt: "2026-01-01T00:00:00Z" }));
      yield* store.insertBot(makeBot("second", { position: 0, createdAt: "2026-02-01T00:00:00Z" }));
      yield* store.insertBot(makeBot("first", { position: 0, createdAt: "2026-01-01T00:00:00Z" }));

      const bots = yield* store.listBots;
      assert.deepStrictEqual(
        bots.map((bot) => bot.id),
        ["first", "second", "late"],
      );
      assert.deepStrictEqual(bots[0], makeBot("first", { createdAt: "2026-01-01T00:00:00Z" }));
    }),
  ),
);

it.effect("rejects inserting a bot whose id exists", () =>
  withStore((store) =>
    Effect.gen(function* () {
      yield* store.insertBot(makeBot("b1"));
      const error = yield* Effect.flip(store.insertBot(makeBot("b1", { name: "Other" })));
      assert.strictEqual(error._tag, "BotsError");
      const stored = yield* store.getBot(BotId.make("b1"));
      assert.strictEqual(Option.getOrThrow(stored).name, "Bot b1");
    }),
  ),
);

it.effect("updates an existing bot and fails for a missing one", () =>
  withStore((store) =>
    Effect.gen(function* () {
      yield* store.insertBot(makeBot("b1"));
      const updated = makeBot("b1", {
        name: "Renamed",
        homeGeneration: 2,
        position: 5,
        canManageBots: true,
      });
      yield* store.updateBot(updated);
      assert.deepStrictEqual(yield* store.getBot(BotId.make("b1")), Option.some(updated));

      const error = yield* Effect.flip(store.updateBot(makeBot("missing")));
      assert.strictEqual(error._tag, "BotsError");
      assert.isTrue(Option.isNone(yield* store.getBot(BotId.make("missing"))));
    }),
  ),
);

it.effect("deletes a bot with its memories and ignores a missing bot", () =>
  withStore((store) =>
    Effect.gen(function* () {
      yield* store.insertBot(makeBot("b1"));
      yield* store.insertBot(makeBot("b2"));
      yield* store.insertMemory(makeMemory("m1", "b1"));
      yield* store.insertMemory(makeMemory("m2", "b2"));

      yield* store.deleteBot(BotId.make("b1"));
      yield* store.deleteBot(BotId.make("missing"));

      assert.deepStrictEqual(
        (yield* store.listBots).map((bot) => bot.id),
        ["b2"],
      );
      assert.deepStrictEqual(
        (yield* store.listMemories()).map((memory) => memory.id),
        ["m2"],
      );
    }),
  ),
);

it.effect("rejects duplicate memory text for the same bot but not for another bot", () =>
  withStore((store) =>
    Effect.gen(function* () {
      yield* store.insertBot(makeBot("b1"));
      yield* store.insertBot(makeBot("b2"));
      yield* store.insertMemory(makeMemory("m1", "b1", { text: "Likes tea" }));

      const error = yield* Effect.flip(
        store.insertMemory(makeMemory("m2", "b1", { text: "Likes tea" })),
      );
      assert.strictEqual(error._tag, "BotsError");

      const other = makeMemory("m3", "b2", { text: "Likes tea", enabled: false });
      yield* store.insertMemory(other);
      assert.deepStrictEqual(yield* store.listMemories(BotId.make("b2")), [other]);
      assert.strictEqual((yield* store.listMemories(BotId.make("b1"))).length, 1);
    }),
  ),
);

it.effect("returns an empty profile until one is set", () =>
  withStore((store) =>
    Effect.gen(function* () {
      assert.strictEqual(yield* store.getAboutMe, "");
      yield* store.setAboutMe("I write code.");
      assert.strictEqual(yield* store.getAboutMe, "I write code.");
    }),
  ),
);

it.effect("registers a push device once, refreshing its label and keeping createdAt", () =>
  withStore((store) =>
    Effect.gen(function* () {
      const first = {
        token: "fcm-1",
        label: "Pixel",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      yield* store.upsertPushDevice(first);
      yield* store.upsertPushDevice(first);
      yield* store.upsertPushDevice({
        token: "fcm-1",
        label: null,
        createdAt: "2026-02-01T00:00:00.000Z",
        updatedAt: "2026-02-01T00:00:00.000Z",
      });

      assert.deepStrictEqual(yield* store.listPushDevices, [
        {
          token: "fcm-1",
          label: null,
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-02-01T00:00:00.000Z",
        },
      ]);
    }),
  ),
);

it.effect("deletes a push device, and deleting it again succeeds", () =>
  withStore((store) =>
    Effect.gen(function* () {
      const device = (token: string) => ({
        token,
        label: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      yield* store.upsertPushDevice(device("fcm-1"));
      yield* store.upsertPushDevice(device("fcm-2"));

      yield* store.deletePushDevice("fcm-1");
      yield* store.deletePushDevice("fcm-1");

      assert.deepStrictEqual(
        (yield* store.listPushDevices).map((row) => row.token),
        ["fcm-2"],
      );
    }),
  ),
);

it.effect(
  "advancing a generation moves the bot's watches and ticket links and keeps its handoff; a stale one writes nothing",
  () =>
    Effect.gen(function* () {
      const store = yield* BotsStore;
      const watches = yield* ThreadWatchStore.ThreadWatchStore;
      const kanban = yield* KanbanStore.KanbanStore;
      const at = "2026-01-01T00:00:00.000Z";
      const old = botThreadId(BotId.make("b1"), 1);
      const next = botThreadId(BotId.make("b1"), 2);
      const peer = ThreadId.make("bot:peer:1");
      const work = ThreadId.make("thread-work");
      yield* store.insertBot(makeBot("b1"));
      // The bot watches a work thread, and another bot watches the bot.
      yield* watches.watch({ watcherThreadId: old, targetThreadId: work, createdAt: at });
      yield* watches.watch({ watcherThreadId: peer, targetThreadId: old, createdAt: at });
      // Already present on the new thread: the old duplicate is dropped, not doubled.
      yield* watches.watch({ watcherThreadId: next, targetThreadId: peer, createdAt: at });
      yield* watches.watch({ watcherThreadId: old, targetThreadId: peer, createdAt: at });
      const ticket = KanbanTicketId.make("ticket-1");
      yield* kanban.insertLocalTicket({
        id: ticket,
        projectId: ProjectId.make("project-1"),
        localNumber: 1,
        title: "Ticket",
        state: "todo",
        priority: 0,
        assigneeId: null,
        creatorId: "owner",
        labelIds: [],
        description: "",
        sortOrder: 0,
        createdAt: at,
      });
      yield* kanban.linkThread(ticket, old, at);
      yield* kanban.linkThread(ticket, work, at);

      const advance = {
        bot: makeBot("b1", { homeGeneration: 2, updatedAt: "2026-01-02T00:00:00.000Z" }),
        fromGeneration: 1,
        fromThreadId: old,
        toThreadId: next,
        handoff: { generation: 1, text: "Follow thread-work.", createdAt: at },
      };
      assert.isTrue(yield* store.advanceGeneration(advance));

      assert.strictEqual(
        Option.getOrThrow(yield* store.getBot(BotId.make("b1"))).homeGeneration,
        2,
      );
      assert.deepStrictEqual(yield* store.listHandoffs(BotId.make("b1")), [advance.handoff]);
      assert.deepStrictEqual(
        (yield* watches.list)
          .map((watch) => [watch.watcherThreadId, watch.targetThreadId])
          .toSorted(),
        [
          [next, peer],
          [next, work],
          [peer, next],
        ].toSorted(),
      );
      const linked = Option.getOrThrow(yield* kanban.getTicket(ticket)).threadIds;
      assert.deepStrictEqual([...linked].toSorted(), [next, work].toSorted());

      // Decided from generation 1 again, after the bot moved on: nothing changes.
      assert.isFalse(
        yield* store.advanceGeneration({
          ...advance,
          bot: makeBot("b1", { homeGeneration: 3 }),
          handoff: { generation: 1, text: "late", createdAt: at },
        }),
      );
      assert.strictEqual(
        Option.getOrThrow(yield* store.getBot(BotId.make("b1"))).homeGeneration,
        2,
      );
      assert.deepStrictEqual(yield* store.listHandoffs(BotId.make("b1")), [advance.handoff]);
    }).pipe(
      Effect.provide(
        Layer.mergeAll(layerFromDb, ThreadWatchStore.layerFromDb, KanbanStore.layerFromDb).pipe(
          Layer.provideMerge(BotsDb.layerMemory),
        ),
      ),
    ),
);
