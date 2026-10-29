import { describe, expect, it } from "@effect/vitest";
import {
  type Bot,
  type BotCreateInput,
  BotId,
  type BotMemory,
  BotMemoryId,
  type BotMemoryCreateInput,
  type BotMemorySource,
  type BotUpdateInput,
  botThreadId,
  EnvironmentId,
  parseBotThreadId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../mcp/McpToolAccess.testkit.ts";
import * as BotsService from "../BotsService.ts";
import * as BotMemoryHandlers from "./handlers.ts";
import { BotManagementToolkit, BotMemoryToolkit } from "./tools.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const alice = BotId.make("b_alice");
const bob = BotId.make("b_bob");

const bot = (id: BotId): Bot => ({
  id,
  name: id,
  role: "",
  model: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  homeGeneration: 1,
  sectionId: null,
  position: 0,
  canManageBots: false,
  createdAt: NOW,
  updatedAt: NOW,
});

const memory = (id: string, botId: BotId, text: string): BotMemory => ({
  id: BotMemoryId.make(id),
  botId,
  text,
  source: "user",
  enabled: true,
  createdAt: NOW,
  updatedAt: NOW,
});

/**
 * A BotsService over two bots and their memories that records every write. Alice may manage bots;
 * Bob may not.
 */
const makeBots = () => {
  let bots = [{ ...bot(alice), canManageBots: true }, bot(bob)];
  let memories = [
    memory("mem_alice", alice, "Prefers short answers."),
    memory("mem_bob", bob, "Works on the billing service."),
  ];
  const created: Array<{ input: BotMemoryCreateInput; source: BotMemorySource }> = [];
  const deleted: Array<BotMemoryId> = [];
  const createdBots: Array<BotCreateInput> = [];
  const updatedBots: Array<BotUpdateInput> = [];
  const deletedBots: Array<BotId> = [];
  const linkedEnvironmentSwitches: Array<unknown> = [];
  const madeRegular: Array<unknown> = [];
  const layer = Layer.mock(BotsService.BotsService)({
    setBotLinkedEnvironments: (input) =>
      Effect.sync(() => {
        linkedEnvironmentSwitches.push(input);
        return input;
      }),
    makeRegular: (input) =>
      Effect.sync(() => {
        madeRegular.push(input);
        return bot(input.botId);
      }),
    directory: Stream.suspend(() =>
      Stream.succeed({
        sections: [],
        bots: bots.map((b) => ({
          ...b,
          homeThreadId: botThreadId(b.id, b.homeGeneration),
          memories: memories.filter((m) => m.botId === b.id),
        })),
        aboutMe: "",
        linkedEnvironmentBotIds: [],
        guestBotIds: [],
      }),
    ),
    createBot: (input) =>
      Effect.sync(() => {
        createdBots.push(input);
        const created = { ...bot(BotId.make("b_new")), ...input, canManageBots: false };
        bots = [...bots, created];
        return created;
      }),
    updateBot: (input) =>
      Effect.sync(() => {
        updatedBots.push(input);
        const { botId, ...fields } = input;
        const updated = { ...bots.find((b) => b.id === botId)!, ...fields };
        bots = bots.map((b) => (b.id === botId ? updated : b));
        return updated;
      }),
    deleteBot: (input) =>
      Effect.sync(() => {
        deletedBots.push(input.botId);
        bots = bots.filter((b) => b.id !== input.botId);
        return input;
      }),
    botForThread: (threadId) => {
      const parsed = parseBotThreadId(threadId);
      return Effect.succeed(
        Option.fromNullishOr(
          bots.find((b) => b.id === parsed?.botId && b.homeGeneration === parsed.generation),
        ),
      );
    },
    memoriesOf: (botId) => Effect.succeed(memories.filter((m) => m.botId === botId)),
    createMemory: (input, source) =>
      Effect.sync(() => {
        created.push({ input, source });
        const saved = { ...memory(`mem_${created.length}`, input.botId, input.text), source };
        memories = [...memories, saved];
        return saved;
      }),
    deleteMemory: (input) =>
      Effect.sync(() => {
        deleted.push(input.memoryId);
        memories = memories.filter((m) => m.id !== input.memoryId);
        return input;
      }),
  });
  return {
    layer,
    created,
    deleted,
    createdBots,
    updatedBots,
    deletedBots,
    linkedEnvironmentSwitches,
    madeRegular,
    memoriesOf: (botId: BotId) => memories.filter((m) => m.botId === botId),
  };
};

const threadScope = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("bots-mcp-environment"),
  requestNamespace: "bots-mcp-provider-session",
  thread: {
    threadId,
    providerSessionId: "bots-mcp-provider-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(),
  issuedAt: 0,
});

const clientScope: McpInvocationContext.McpInvocationScope = {
  ...threadScope(ThreadId.make("unused")),
  thread: undefined,
  client: { sessionId: "outside-session", label: "Outside agent", access: "full-access" },
};

/** The memory tools as `scope` calls them; each yields its result or returned failure. */
const memoryTools = (
  bots: Layer.Layer<BotsService.BotsService>,
  scope: McpInvocationContext.McpInvocationScope,
) =>
  Effect.gen(function* () {
    const dependencies = Layer.mergeAll(
      bots,
      Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
      McpToolAccessTestkit.liveThreadsLayer,
    );
    const toolkit = yield* BotMemoryToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(BotMemoryHandlers.layer).pipe(
          Layer.provide(dependencies),
        ),
      ),
    );
    const run = <A extends { readonly result: unknown }, E, R, E2, R2>(
      handled: Effect.Effect<Stream.Stream<A, E, R>, E2, R2>,
    ) =>
      handled.pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.provide(dependencies),
        Effect.map((results) => results.at(-1)?.result),
      );
    return {
      list: () => run(toolkit.handle("memory_list", {})),
      save: (text: string) => run(toolkit.handle("memory_save", { text })),
      forget: (memoryId: string) =>
        run(toolkit.handle("memory_forget", { memoryId: BotMemoryId.make(memoryId) })),
    };
  });

type MemoryTools = Effect.Success<ReturnType<typeof memoryTools>>;

const everyTool = [
  { name: "memory_list", call: (tools: MemoryTools) => tools.list() },
  { name: "memory_save", call: (tools: MemoryTools) => tools.save("Lives in Lisbon.") },
  { name: "memory_forget", call: (tools: MemoryTools) => tools.forget("mem_alice") },
];

it.effect.each(everyTool)("$name refuses a thread that is not a bot's", ({ call }) =>
  Effect.gen(function* () {
    const bots = makeBots();
    const tools = yield* memoryTools(bots.layer, threadScope(ThreadId.make("plain-thread")));
    const result = yield* call(tools);
    expect(result).toMatchObject({
      _tag: "OrchestratorMcpFailure",
      message: "Memory is only available in a bot's conversation.",
    });
    expect(bots.created).toEqual([]);
    expect(bots.deleted).toEqual([]);
  }),
);

it.effect.each(everyTool)("$name refuses an outside client", ({ call }) =>
  Effect.gen(function* () {
    const bots = makeBots();
    const result = yield* call(yield* memoryTools(bots.layer, clientScope));
    expect(result).toMatchObject({
      _tag: "OrchestratorMcpFailure",
      code: "thread_credential_required",
    });
    expect(bots.created).toEqual([]);
    expect(bots.deleted).toEqual([]);
  }),
);

it.effect("memory_list returns only the calling bot's memories", () =>
  Effect.gen(function* () {
    const bots = makeBots();
    const tools = yield* memoryTools(bots.layer, threadScope(botThreadId(alice, 1)));
    const result = yield* tools.list();
    expect(result).toEqual({
      memories: [
        { id: "mem_alice", text: "Prefers short answers.", enabled: true, source: "user" },
      ],
    });
  }),
);

it.effect("memory_save stores the memory for the calling bot as its own", () =>
  Effect.gen(function* () {
    const bots = makeBots();
    const tools = yield* memoryTools(bots.layer, threadScope(botThreadId(alice, 1)));
    const result = yield* tools.save("Lives in Lisbon.");
    expect(bots.created).toEqual([
      { input: { botId: alice, text: "Lives in Lisbon." }, source: "bot" },
    ]);
    expect(result).toEqual({ id: "mem_1", text: "Lives in Lisbon.", enabled: true, source: "bot" });
  }),
);

it.effect("memory_forget refuses another bot's memory", () =>
  Effect.gen(function* () {
    const bots = makeBots();
    const tools = yield* memoryTools(bots.layer, threadScope(botThreadId(alice, 1)));
    const result = yield* tools.forget("mem_bob");
    expect(result).toMatchObject({ _tag: "OrchestratorMcpFailure", code: "invalid_request" });
    expect(bots.deleted).toEqual([]);
    expect(bots.memoriesOf(bob).map((m) => m.id)).toEqual(["mem_bob"]);
  }),
);

it.effect("memory_forget deletes the calling bot's own memory", () =>
  Effect.gen(function* () {
    const bots = makeBots();
    const tools = yield* memoryTools(bots.layer, threadScope(botThreadId(alice, 1)));
    const result = yield* tools.forget("mem_alice");
    expect(result).toEqual({ memoryId: "mem_alice" });
    expect(bots.deleted).toEqual(["mem_alice"]);
    expect(bots.memoriesOf(alice)).toEqual([]);
  }),
);

/** The bot management tools as `scope` calls them; each yields its result or returned failure. */
const managementTools = (
  bots: Layer.Layer<BotsService.BotsService>,
  scope: McpInvocationContext.McpInvocationScope,
) =>
  Effect.gen(function* () {
    const dependencies = Layer.mergeAll(
      bots,
      Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
      McpToolAccessTestkit.liveThreadsLayer,
    );
    const toolkit = yield* BotManagementToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(BotMemoryHandlers.managementLayer).pipe(
          Layer.provide(dependencies),
        ),
      ),
    );
    const run = <A extends { readonly result: unknown }, E, R, E2, R2>(
      handled: Effect.Effect<Stream.Stream<A, E, R>, E2, R2>,
    ) =>
      handled.pipe(
        Stream.unwrap,
        Stream.runCollect,
        Effect.provide(dependencies),
        Effect.map((results) => results.at(-1)?.result),
      );
    return {
      list: () => run(toolkit.handle("bot_list", {})),
      create: (memories?: ReadonlyArray<string>) =>
        run(
          toolkit.handle("bot_create", {
            name: "Scout",
            role: "Finds jobs.",
            model: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-luna" },
            ...(memories !== undefined ? { memories } : {}),
          }),
        ),
      update: (botId: BotId, role: string, extra: Record<string, unknown> = {}) =>
        run(toolkit.handle("bot_update", { botId, role, ...extra })),
      createWith: (extra: Record<string, unknown>) =>
        run(
          toolkit.handle("bot_create", {
            name: "Scout",
            role: "Finds jobs.",
            model: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6-luna" },
            ...extra,
          }),
        ),
      remove: (botId: BotId) => run(toolkit.handle("bot_delete", { botId })),
    };
  });

type ManagementTools = Effect.Success<ReturnType<typeof managementTools>>;

const everyManagementTool = [
  { name: "bot_list", call: (tools: ManagementTools) => tools.list() },
  { name: "bot_create", call: (tools: ManagementTools) => tools.create() },
  { name: "bot_update", call: (tools: ManagementTools) => tools.update(alice, "Taken over.") },
  { name: "bot_delete", call: (tools: ManagementTools) => tools.remove(alice) },
];

const callers = [
  { caller: "a bot the user did not allow", threadId: botThreadId(bob, 1) },
  { caller: "a thread that is not a bot's", threadId: ThreadId.make("plain-thread") },
];

describe.each(callers)("for $caller", ({ threadId }) => {
  it.effect.each(everyManagementTool)("$name is refused", ({ call }) =>
    Effect.gen(function* () {
      const bots = makeBots();
      const result = yield* call(yield* managementTools(bots.layer, threadScope(threadId)));
      expect(result).toMatchObject({ _tag: "OrchestratorMcpFailure", code: "capability_denied" });
      expect(bots.createdBots).toEqual([]);
      expect(bots.updatedBots).toEqual([]);
      expect(bots.deletedBots).toEqual([]);
    }),
  );
});

it.effect("bot_list shows a managing bot every bot with its role and thread", () =>
  Effect.gen(function* () {
    const bots = makeBots();
    const tools = yield* managementTools(bots.layer, threadScope(botThreadId(alice, 1)));
    const result = yield* tools.list();
    expect(result).toMatchObject({
      bots: [
        { id: alice, canManageBots: true, threadId: "bot:b_alice:1" },
        { id: bob, role: "", canManageBots: false, threadId: "bot:b_bob:1" },
      ],
    });
  }),
);

it.effect("bot_create makes a bot that cannot manage bots, with its starting memories", () =>
  Effect.gen(function* () {
    const bots = makeBots();
    const tools = yield* managementTools(bots.layer, threadScope(botThreadId(alice, 1)));
    const result = yield* tools.create(["Israel is job hunting.", "Israel is job hunting."]);
    expect(bots.createdBots).toEqual([
      {
        name: "Scout",
        role: "Finds jobs.",
        model: { instanceId: "codex", model: "gpt-6-luna" },
      },
    ]);
    expect(result).toMatchObject({ id: "b_new", canManageBots: false, threadId: "bot:b_new:1" });
    expect(bots.created).toEqual([
      { input: { botId: "b_new", text: "Israel is job hunting." }, source: "bot" },
    ]);
  }),
);

it.effect("bot_create refuses starting memories past the budget before making the bot", () =>
  Effect.gen(function* () {
    const bots = makeBots();
    const tools = yield* managementTools(bots.layer, threadScope(botThreadId(alice, 1)));
    const result = yield* tools.create(["a".repeat(4_000), "b".repeat(4_000), "c"]);
    expect(result).toMatchObject({ _tag: "OrchestratorMcpFailure", code: "invalid_request" });
    expect(bots.createdBots).toEqual([]);
    expect(bots.created).toEqual([]);
  }),
);

it.effect("bot_update rewrites another bot's role", () =>
  Effect.gen(function* () {
    const bots = makeBots();
    const tools = yield* managementTools(bots.layer, threadScope(botThreadId(alice, 1)));
    const result = yield* tools.update(bob, "Tracks billing.");
    expect(bots.updatedBots).toEqual([{ botId: bob, role: "Tracks billing." }]);
    expect(result).toMatchObject({ id: bob, role: "Tracks billing.", canManageBots: false });
  }),
);

it.effect("bot_delete deletes another bot but never the caller", () =>
  Effect.gen(function* () {
    const bots = makeBots();
    const tools = yield* managementTools(bots.layer, threadScope(botThreadId(alice, 1)));
    expect(yield* tools.remove(alice)).toMatchObject({
      _tag: "OrchestratorMcpFailure",
      code: "invalid_request",
    });
    expect(bots.deletedBots).toEqual([]);
    expect(yield* tools.remove(bob)).toEqual({ botId: bob });
    expect(bots.deletedBots).toEqual([bob]);
  }),
);

// Linked environments reach the user's other machines, and making a guest's bot regular moves it
// onto the host; only the user's own session does either (bots.bot.linkedEnvironments,
// bots.bot.makeRegular). A managing bot passing the fields anyway changes nothing.
it.effect(
  "bot_update and bot_create never reach the owner's linked-environment or guest switches",
  () =>
    Effect.gen(function* () {
      const bots = makeBots();
      const tools = yield* managementTools(bots.layer, threadScope(botThreadId(alice, 1)));
      const smuggled = {
        linkedEnvironments: true,
        linkedEnvironmentBotIds: [alice],
        makeRegular: true,
        guestBotIds: [],
      };
      yield* tools.update(alice, "Reaches the Mac.", smuggled);
      yield* tools.createWith(smuggled);
      expect(bots.linkedEnvironmentSwitches).toEqual([]);
      expect(bots.madeRegular).toEqual([]);
      expect(bots.updatedBots).toEqual([{ botId: alice, role: "Reaches the Mac." }]);
      expect(bots.createdBots).toEqual([
        { name: "Scout", role: "Finds jobs.", model: { instanceId: "codex", model: "gpt-6-luna" } },
      ]);
    }),
);
