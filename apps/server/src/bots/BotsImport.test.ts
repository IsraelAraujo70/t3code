import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { BotId, ProviderInstanceId } from "@t3tools/contracts";

import {
  planFriendImport,
  readFriendDatabase,
  type FriendImportPlanInput,
  type FriendSnapshot,
} from "./BotsImport.ts";

const SECRET = "sk-test-mcp-credential-0000";
const BOT_A = `b_${"a".repeat(32)}`;
const BOT_B = `b_${"b".repeat(32)}`;
const MEM_1 = `mem_${"1".repeat(32)}`;
const MEM_2 = `mem_${"2".repeat(32)}`;

/** A temp directory removed when the test's scope closes. */
const tempDirectory = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dir = yield* fs.makeTempDirectoryScoped({ prefix: "bots-import-" });
  return (name: string) => path.join(dir, name);
});

/** A friend.db with friend's schema, including credentials in `mcp_servers`. */
function writeFixture(path: string, { withSettings = true } = {}): string {
  const db = new NodeSqlite.DatabaseSync(path);
  db.exec(`
    CREATE TABLE bots (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL, emoji TEXT NOT NULL, role TEXT NOT NULL, model TEXT NOT NULL,
      desktop INTEGER NOT NULL, shell INTEGER NOT NULL, mcp_servers TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, effort TEXT
    );
    CREATE TABLE memories (
      seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
      bot_id TEXT NOT NULL REFERENCES bots(id) ON DELETE CASCADE,
      text TEXT NOT NULL, source TEXT NOT NULL, enabled INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  if (withSettings) db.exec("CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const insertBot = db.prepare(
    `INSERT INTO bots (id, name, emoji, role, model, desktop, shell, mcp_servers, created_at, updated_at, effort)
     VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?)`,
  );
  const servers = JSON.stringify([{ name: "x", env: { TOKEN: SECRET } }]);
  // Inserted out of id order: reading follows seq.
  insertBot.run(
    BOT_B,
    "Bea",
    "🐝",
    "Writes",
    "gpt-6.1-sol",
    servers,
    "2026-01-02T00:00:00.000Z",
    "2026-01-03T00:00:00.000Z",
    null,
  );
  insertBot.run(
    BOT_A,
    "Al",
    "🤖",
    "Codes",
    "claude-opus-5-5",
    servers,
    "2026-01-01T00:00:00.000Z",
    "2026-01-01T00:00:00.000Z",
    "high",
  );
  const insertMemory = db.prepare(
    `INSERT INTO memories (id, bot_id, text, source, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, '2026-02-01T00:00:00.000Z', '2026-02-02T00:00:00.000Z')`,
  );
  insertMemory.run(MEM_1, BOT_A, "Likes tea", "user", 1);
  insertMemory.run(MEM_2, BOT_B, "Prefers short", "bot", 0);
  if (withSettings)
    db.prepare("INSERT INTO settings (key, value) VALUES ('aboutMe', ?)").run("I am Israel");
  db.close();
  return path;
}

it.layer(NodeServices.layer)("readFriendDatabase", (it) => {
  it.effect("reads bots, memories, and about me without mcp_servers", () =>
    Effect.gen(function* () {
      const inTemp = yield* tempDirectory;
      const snapshot = yield* readFriendDatabase(writeFixture(inTemp("friend.db")));
      assert.deepStrictEqual(snapshot, {
        bots: [
          {
            id: BOT_B,
            name: "Bea",
            role: "Writes",
            model: "gpt-6.1-sol",
            effort: null,
            createdAt: "2026-01-02T00:00:00.000Z",
            updatedAt: "2026-01-03T00:00:00.000Z",
          },
          {
            id: BOT_A,
            name: "Al",
            role: "Codes",
            model: "claude-opus-5-5",
            effort: "high",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        memories: [
          {
            id: MEM_1,
            botId: BOT_A,
            text: "Likes tea",
            source: "user",
            enabled: true,
            createdAt: "2026-02-01T00:00:00.000Z",
            updatedAt: "2026-02-02T00:00:00.000Z",
          },
          {
            id: MEM_2,
            botId: BOT_B,
            text: "Prefers short",
            source: "bot",
            enabled: false,
            createdAt: "2026-02-01T00:00:00.000Z",
            updatedAt: "2026-02-02T00:00:00.000Z",
          },
        ],
        aboutMe: "I am Israel",
      });
      assert.notInclude(JSON.stringify(snapshot), SECRET);
    }),
  );

  it.effect("fails naming the path when the file is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = (yield* tempDirectory)("missing.db");
      const error = yield* Effect.flip(readFriendDatabase(path));
      assert.strictEqual(error._tag, "BotsError");
      assert.include(error.message, path);
      assert.isFalse(yield* fs.exists(path));
    }),
  );

  it.effect("fails naming the path when a table is missing", () =>
    Effect.gen(function* () {
      const path = writeFixture((yield* tempDirectory)("no-settings.db"), { withSettings: false });
      const error = yield* Effect.flip(readFriendDatabase(path));
      assert.strictEqual(error._tag, "BotsError");
      assert.include(error.message, path);
    }),
  );
});

const CLAUDE = ProviderInstanceId.make("claude-main");
const CODEX = ProviderInstanceId.make("codex-main");
const NOW = "2026-10-19T00:00:00.000Z";

const friendBot = (
  id: string,
  model: string,
  overrides: Partial<FriendSnapshot["bots"][number]> = {},
): FriendSnapshot["bots"][number] => ({
  id,
  name: `Bot ${id.slice(0, 6)}`,
  role: "",
  model,
  effort: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
  ...overrides,
});

const friendMemory = (
  id: string,
  botId: string,
  overrides: Partial<FriendSnapshot["memories"][number]> = {},
): FriendSnapshot["memories"][number] => ({
  id,
  botId,
  text: `memory ${id}`,
  source: "user",
  enabled: true,
  createdAt: "2026-02-01T00:00:00.000Z",
  updatedAt: "2026-02-02T00:00:00.000Z",
  ...overrides,
});

const plan = (overrides: Partial<FriendImportPlanInput> & { snapshot: FriendSnapshot }) =>
  planFriendImport({
    path: "/tmp/friend.db",
    existingBotIds: new Set(),
    existingAboutMe: "",
    instances: [
      { instanceId: ProviderInstanceId.make("claude-off"), driver: "claudeAgent", enabled: false },
      { instanceId: CLAUDE, driver: "claudeAgent", enabled: true },
      { instanceId: CODEX, driver: "codex", enabled: true },
    ],
    now: NOW,
    ...overrides,
  });

describe("planFriendImport", () => {
  it("maps claude and gpt models to enabled instances with their effort option", () => {
    const { result, batch } = plan({
      snapshot: {
        bots: [
          friendBot(BOT_A, "claude-opus-5-5", { effort: "high" }),
          friendBot(BOT_B, "gpt-6.1-sol", { effort: "medium" }),
          friendBot("b_plain", "claude-sonnet-5-5"),
        ],
        memories: [],
        aboutMe: "",
      },
    });
    assert.deepStrictEqual(
      batch.bots.map(({ id, model, position, homeGeneration }) => ({
        id,
        model,
        position,
        homeGeneration,
      })),
      [
        {
          id: BotId.make(BOT_A),
          model: {
            instanceId: CLAUDE,
            model: "claude-opus-5-5",
            options: [{ id: "effort", value: "high" }],
          },
          position: 0,
          homeGeneration: 1,
        },
        {
          id: BotId.make(BOT_B),
          model: {
            instanceId: CODEX,
            model: "gpt-6.1-sol",
            options: [{ id: "reasoningEffort", value: "medium" }],
          },
          position: 1,
          homeGeneration: 1,
        },
        {
          id: BotId.make("b_plain"),
          model: { instanceId: CLAUDE, model: "claude-sonnet-5-5" },
          position: 2,
          homeGeneration: 1,
        },
      ],
    );
    assert.deepStrictEqual(result.warnings, []);
    assert.isFalse(result.applied);
    assert.strictEqual(result.path, "/tmp/friend.db");
  });

  it("plans a bot without a matching instance with a null model and leaves it out", () => {
    const { result, batch } = plan({
      instances: [{ instanceId: CODEX, driver: "codex", enabled: true }],
      snapshot: {
        bots: [friendBot(BOT_A, "claude-opus-5-5")],
        memories: [friendMemory(MEM_1, BOT_A)],
        aboutMe: "",
      },
    });
    assert.deepStrictEqual(result.bots, [
      {
        sourceId: BotId.make(BOT_A),
        name: "Bot b_aaaa",
        status: "new",
        model: null,
        memories: 1,
      },
    ]);
    assert.strictEqual(result.warnings.length, 1);
    assert.include(result.warnings[0], "claude-opus-5-5");
    assert.deepStrictEqual(batch.bots, []);
    assert.deepStrictEqual(batch.memories, []);
  });

  it("leaves existing bots and their memories out of the batch", () => {
    const { result, batch } = plan({
      existingBotIds: new Set([BotId.make(BOT_A)]),
      snapshot: {
        bots: [friendBot(BOT_A, "claude-opus-5-5"), friendBot(BOT_B, "gpt-6.1-sol")],
        memories: [friendMemory(MEM_1, BOT_A), friendMemory(MEM_2, BOT_B)],
        aboutMe: "",
      },
    });
    assert.deepStrictEqual(
      result.bots.map((bot) => [bot.sourceId, bot.status, bot.memories]),
      [
        [BOT_A, "exists", 1],
        [BOT_B, "new", 1],
      ],
    );
    assert.deepStrictEqual(
      batch.bots.map((bot) => bot.id),
      [BOT_B],
    );
    assert.deepStrictEqual(
      batch.memories.map((memory) => memory.id),
      [MEM_2],
    );
  });

  it("skips invalid rows and the memories of skipped bots, with warnings", () => {
    const { result, batch } = plan({
      snapshot: {
        bots: [
          friendBot("bad id!", "claude-opus-5-5"),
          friendBot(BOT_A, "claude-opus-5-5", { name: "x".repeat(61) }),
          friendBot("b_role", "claude-opus-5-5", { role: "r".repeat(20_001) }),
          friendBot(BOT_B, "gpt-6.1-sol", { createdAt: "", updatedAt: "" }),
        ],
        memories: [
          friendMemory(MEM_1, BOT_A),
          friendMemory("mem bad", BOT_B),
          friendMemory("mem_long", BOT_B, { text: "y".repeat(4001) }),
          friendMemory("mem_orphan", "b_unknown"),
          friendMemory(MEM_2, BOT_B),
        ],
        aboutMe: "",
      },
    });
    assert.strictEqual(result.warnings.length, 7);
    assert.deepStrictEqual(
      result.bots.map((bot) => bot.sourceId),
      [BOT_B],
    );
    assert.deepStrictEqual(
      batch.bots.map((bot) => [bot.id, bot.position, bot.createdAt, bot.updatedAt]),
      [[BOT_B, 3, NOW, NOW]],
    );
    assert.deepStrictEqual(
      batch.memories.map((memory) => memory.id),
      [MEM_2],
    );
  });

  it("maps memory sources and keeps enabled and timestamps", () => {
    const { batch } = plan({
      snapshot: {
        bots: [friendBot(BOT_A, "claude-opus-5-5")],
        memories: [
          friendMemory("mem_u", BOT_A, { source: "user" }),
          friendMemory("mem_b", BOT_A, { source: "bot", enabled: false }),
          friendMemory("mem_x", BOT_A, { source: "routine" }),
        ],
        aboutMe: "",
      },
    });
    assert.deepStrictEqual(
      batch.memories.map((memory) => [memory.id, memory.source, memory.enabled, memory.createdAt]),
      [
        ["mem_u", "user", true, "2026-02-01T00:00:00.000Z"],
        ["mem_b", "bot", false, "2026-02-01T00:00:00.000Z"],
        ["mem_x", "import", true, "2026-02-01T00:00:00.000Z"],
      ],
    );
  });

  it("decides about me: none, same, replace, keep-local", () => {
    const decide = (friend: string, local: string) => {
      const { result, batch } = plan({
        existingAboutMe: local,
        snapshot: { bots: [], memories: [], aboutMe: friend },
      });
      return [result.aboutMe, batch.aboutMe];
    };
    assert.deepStrictEqual(decide("", "local"), ["none", null]);
    assert.deepStrictEqual(decide("same", "same"), ["same", null]);
    assert.deepStrictEqual(decide("from friend", ""), ["replace", "from friend"]);
    assert.deepStrictEqual(decide("from friend", "local"), ["keep-local", null]);
  });
});
