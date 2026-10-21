import {
  BotId,
  BotMemoryId,
  ProviderInstanceId,
  type Bot,
  type BotMemory,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { BotsStore, layerMemory } from "./BotsStore.ts";

const makeBot = (id: string, overrides: Partial<Bot> = {}): Bot => ({
  id: BotId.make(id),
  name: `Bot ${id}`,
  role: "Helps out.",
  model: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  homeGeneration: 1,
  sectionId: null,
  position: 0,
  canManageBots: false,
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

it.effect("imports new rows, leaves existing ids untouched, and fills only an empty profile", () =>
  withStore((store) =>
    Effect.gen(function* () {
      const existingBot = makeBot("b1", { name: "Local" });
      const existingMemory = makeMemory("m1", "b1", { text: "Local memory" });
      yield* store.insertBot(existingBot);
      yield* store.insertMemory(existingMemory);

      const newBot = makeBot("b2", { position: 1 });
      const newMemory = makeMemory("m2", "b2", { source: "import" });
      yield* store.importBatch({
        bots: [makeBot("b1", { name: "Imported" }), newBot],
        memories: [makeMemory("m1", "b1", { text: "Imported memory" }), newMemory],
        aboutMe: "Imported profile",
      });

      assert.deepStrictEqual(yield* store.listBots, [existingBot, newBot]);
      assert.deepStrictEqual(yield* store.listMemories(), [existingMemory, newMemory]);
      assert.strictEqual(yield* store.getAboutMe, "Imported profile");

      yield* store.importBatch({ bots: [], memories: [], aboutMe: "Second import" });
      assert.strictEqual(yield* store.getAboutMe, "Imported profile");

      yield* store.importBatch({ bots: [], memories: [], aboutMe: null });
      assert.strictEqual(yield* store.getAboutMe, "Imported profile");
    }),
  ),
);

it.effect("writes nothing when any row of an import fails", () =>
  withStore((store) =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(
        store.importBatch({
          bots: [makeBot("b1")],
          memories: [makeMemory("m1", "b1"), makeMemory("m2", "unknown")],
          aboutMe: "Imported profile",
        }),
      );
      assert.strictEqual(error._tag, "BotsError");

      assert.deepStrictEqual(yield* store.listBots, []);
      assert.deepStrictEqual(yield* store.listMemories(), []);
      assert.strictEqual(yield* store.getAboutMe, "");
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
