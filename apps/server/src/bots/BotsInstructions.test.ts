import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  BotId,
  BotMemoryId,
  botThreadId,
  GuestId,
  ProviderInstanceId,
  ThreadId,
  type Bot,
  type BotMemory,
} from "@t3tools/contracts";

import * as BotsDb from "./BotsDb.ts";
import {
  BOT_INSTRUCTION_SECTION_LIMIT,
  BotsInstructions,
  buildBotInstructions,
  buildGuestBotInstructions,
  layer as instructionsLayer,
} from "./BotsInstructions.ts";
import { BotsStore, layerFromDb as storeLayerFromDb } from "./BotsStore.ts";
import { GuestStore, layerFromDb as guestLayerFromDb } from "./guest/GuestStore.ts";

const bot: Bot = {
  id: BotId.make(`b_${"a".repeat(32)}`),
  name: "Al",
  role: "Reviews pull requests.",
  model: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
  homeGeneration: 1,
  sectionId: null,
  position: 0,
  canManageBots: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const memory = (id: string, text: string, overrides: Partial<BotMemory> = {}): BotMemory => ({
  id: BotMemoryId.make(id),
  botId: bot.id,
  text,
  source: "user",
  enabled: true,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("buildBotInstructions", () => {
  it("orders sections and omits an empty profile and memory list", () => {
    const full = buildBotInstructions({
      bot,
      memories: [memory("mem_1", "Likes tea"), memory("mem_2", "Uses vim")],
      aboutMe: "I build T3.",
      peers: [],
    });
    assert.deepStrictEqual(
      full.sections.map((section) => section.key),
      ["bot", "owner", "memories", "memory-tools", "work-tools"],
    );
    assert.strictEqual(
      full.sections[0]!.text,
      "You are Al, one of the user's bots in T3 Code. This thread is your ongoing conversation with the user.\n\nReviews pull requests.",
    );
    assert.strictEqual(full.sections[1]!.text, "I build T3.");
    assert.strictEqual(full.sections[2]!.text, "- [mem_1] Likes tea\n- [mem_2] Uses vim");
    assert.include(full.sections[3]!.text, "memory_save");
    assert.include(full.sections[3]!.text, "memory_forget");
    // The bot sees how much of its memory budget it uses, here 9 + 8 characters.
    assert.include(full.sections[3]!.text, "now use 17.");
    // Code goes to its own T3 thread, and the old friend app's tools are named as gone.
    assert.include(full.sections[4]!.text, "t3_thread_launch");
    assert.include(full.sections[4]!.text, "watch_thread");
    assert.include(full.sections[4]!.text, "mcp__friend__");

    const bare = buildBotInstructions({ bot, memories: [], aboutMe: "  ", peers: [] });
    assert.deepStrictEqual(
      bare.sections.map((section) => section.key),
      ["bot", "memory-tools", "work-tools"],
    );
  });

  it("tells only a bot the user allowed to manage bots about the management tools", () => {
    const manager = buildBotInstructions({
      bot: { ...bot, canManageBots: true },
      memories: [],
      aboutMe: "",
      peers: [],
    });
    assert.deepStrictEqual(
      manager.sections.map((section) => section.key),
      ["bot", "memory-tools", "work-tools", "manage-bots"],
    );
    assert.include(manager.sections[3]!.text, "bot_create");
  });

  it("splits a long section on line boundaries and hard-splits a single long line", () => {
    const memories = Array.from({ length: 40 }, (_, index) =>
      memory(`mem_${index}`, `Fact ${index} ${"x".repeat(100)}`),
    );
    const longRole = "y".repeat(BOT_INSTRUCTION_SECTION_LIMIT * 2 + 10);
    const { sections } = buildBotInstructions({
      bot: { ...bot, role: longRole },
      memories,
      aboutMe: "",
      peers: [],
    });

    for (const section of sections) {
      assert.isAtMost(section.text.length, BOT_INSTRUCTION_SECTION_LIMIT);
    }
    const memorySections = sections.filter((section) => section.key.startsWith("memories-"));
    assert.strictEqual(memorySections.length, 2);
    assert.deepStrictEqual(
      memorySections.map((section) => [section.key, section.title]),
      [
        ["memories-1", "Your memories (1/2)"],
        ["memories-2", "Your memories (2/2)"],
      ],
    );
    // No memory line is cut in half.
    assert.strictEqual(
      memorySections.map((section) => section.text).join("\n"),
      memories.map((entry) => `- [${entry.id}] ${entry.text}`).join("\n"),
    );

    const botSections = sections.filter((section) => section.key.startsWith("bot-"));
    assert.deepStrictEqual(
      botSections.map((section) => section.key),
      ["bot-1", "bot-2", "bot-3", "bot-4"],
    );
    assert.match(botSections[0]!.text, /^You are Al/);
    assert.strictEqual(
      botSections
        .slice(1)
        .map((section) => section.text)
        .join(""),
      longRole,
    );
  });

  it("changes the fingerprint when a memory changes and keeps it otherwise", () => {
    const input = {
      bot,
      memories: [memory("mem_1", "Likes tea")],
      aboutMe: "I build T3.",
      peers: [],
    };
    const first = buildBotInstructions(input);
    assert.match(first.fingerprint, /^[0-9a-f]{64}$/);
    assert.strictEqual(buildBotInstructions({ ...input }).fingerprint, first.fingerprint);
    assert.notStrictEqual(
      buildBotInstructions({ ...input, memories: [memory("mem_1", "Likes coffee")] }).fingerprint,
      first.fingerprint,
    );
    assert.notStrictEqual(
      buildBotInstructions({ ...input, aboutMe: "I build T4." }).fingerprint,
      first.fingerprint,
    );
  });

  it("lists the other bots with their current thread", () => {
    const peer: Bot = {
      ...bot,
      id: BotId.make(`b_${"b".repeat(32)}`),
      name: "Fin",
      role: "\nTracks spending and bills.\nNever pays anything.",
      homeGeneration: 3,
    };
    const { sections } = buildBotInstructions({ bot, memories: [], aboutMe: "", peers: [peer] });
    const others = sections.find((section) => section.key === "other-bots");
    assert.isDefined(others);
    assert.include(others!.text, `- Fin, thread bot:${peer.id}:3: Tracks spending and bills.\n`);
    assert.notInclude(others!.text, "Never pays anything.");
  });
});

describe("buildGuestBotInstructions", () => {
  it("names the guest and the sandbox, and carries none of the owner's tools or profile", () => {
    const { sections } = buildGuestBotInstructions({
      bot,
      memories: [memory("mem_1", "Pays rent on the 5th")],
      guestName: "Bia",
    });
    assert.deepStrictEqual(
      sections.map((section) => section.key),
      ["bot", "memories", "people", "workspace"],
    );
    const shared = buildGuestBotInstructions({
      bot,
      memories: [],
      guestName: "Bia",
      ownerName: "Israel",
    });
    assert.include(
      shared.sections.find((section) => section.key === "people")!.text,
      "Any other message from the user comes from Israel.",
    );
    assert.include(sections[0]!.text, "You are Al, Bia's assistant.");
    assert.include(sections[0]!.text, "Reviews pull requests.");
    // Guests have no memory tools, so the ids that memory_forget takes are not shown.
    assert.strictEqual(sections[1]!.text, "- Pays rent on the 5th");
    assert.include(sections[2]!.text, 'starts with "Bia:" comes from Bia');
    assert.include(sections[3]!.text, "/home/guest");
    const all = sections.map((section) => section.text).join("\n");
    for (const ownerOnly of ["memory_save", "t3_thread_launch", "delegate_task", "bot_create"]) {
      assert.notInclude(all, ownerOnly);
    }
  });
});

const layerTest = instructionsLayer.pipe(
  Layer.provideMerge(Layer.merge(storeLayerFromDb, guestLayerFromDb)),
  Layer.provide(BotsDb.layerMemory),
);

describe("BotsInstructions.forThread", () => {
  it.effect("reads the bot, its enabled memories and the profile for any generation", () =>
    Effect.gen(function* () {
      const store = yield* BotsStore;
      const instructions = yield* BotsInstructions;
      yield* store.insertBot({ ...bot, homeGeneration: 2 });
      yield* store.insertMemory(memory("mem_on", "Likes tea"));
      yield* store.insertMemory(memory("mem_off", "Used to like coffee", { enabled: false }));
      yield* store.setAboutMe("I build T3.");

      const result = yield* instructions.forThread(botThreadId(bot.id, 1));
      assert.isDefined(result);
      const memories = result!.sections.find((section) => section.key === "memories");
      assert.strictEqual(memories!.text, "- [mem_on] Likes tea");
      // The only bot is this one, so there is nobody else to list.
      assert.isUndefined(result!.sections.find((section) => section.key === "other-bots"));
      assert.strictEqual(
        result!.sections.find((section) => section.key === "owner")!.text,
        "I build T3.",
      );
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("gives a guest's bot guest instructions and hides it from the owner's bots", () =>
    Effect.gen(function* () {
      const store = yield* BotsStore;
      const guests = yield* GuestStore;
      const instructions = yield* BotsInstructions;
      const guestBot: Bot = { ...bot, id: BotId.make(`b_${"c".repeat(32)}`), name: "Fin" };
      yield* store.insertBot(bot);
      yield* store.insertBot({ ...guestBot, position: 1 });
      yield* store.setAboutMe("I build T3.");
      yield* guests.insertGuest({
        id: GuestId.make("bia"),
        name: "Bia",
        tokenHash: null,
        tokenCreatedAt: null,
        createdAt: bot.createdAt,
        updatedAt: bot.createdAt,
      });
      yield* guests.assignBot(GuestId.make("bia"), guestBot.id, bot.createdAt);
      // Memories the bot saved before it became a guest's carry over, read-only.
      yield* store.insertMemory(
        memory("mem_kept", "Rent is due on the 5th", { botId: guestBot.id }),
      );
      yield* store.insertMemory(
        memory("mem_off", "An old account", { botId: guestBot.id, enabled: false }),
      );

      const forGuestBot = yield* instructions.forThread(botThreadId(guestBot.id, 1));
      assert.strictEqual(
        forGuestBot!.sections.find((section) => section.key === "memories")?.text,
        "- Rent is due on the 5th",
      );
      assert.include(forGuestBot!.sections[0]!.text, "You are Fin, Bia's assistant.");
      assert.isUndefined(forGuestBot!.sections.find((section) => section.key === "owner"));

      const forOwnerBot = yield* instructions.forThread(botThreadId(bot.id, 1));
      assert.isUndefined(forOwnerBot!.sections.find((section) => section.key === "other-bots"));
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("is undefined for ordinary threads and for bots that no longer exist", () =>
    Effect.gen(function* () {
      const instructions = yield* BotsInstructions;
      assert.isUndefined(yield* instructions.forThread(ThreadId.make("thread-1")));
      assert.isUndefined(yield* instructions.forThread(botThreadId(bot.id, 1)));
    }).pipe(Effect.provide(layerTest)),
  );
});
