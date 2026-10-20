import { expect, it } from "@effect/vitest";
import {
  type Bot,
  BotId,
  type BotMemory,
  BotMemoryId,
  type BotMemoryCreateInput,
  type BotMemorySource,
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
import { BotMemoryToolkit } from "./tools.ts";

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

/** A BotsService over two bots and their memories that records every write. */
const makeBots = () => {
  const bots = [bot(alice), bot(bob)];
  let memories = [
    memory("mem_alice", alice, "Prefers short answers."),
    memory("mem_bob", bob, "Works on the billing service."),
  ];
  const created: Array<{ input: BotMemoryCreateInput; source: BotMemorySource }> = [];
  const deleted: Array<BotMemoryId> = [];
  const layer = Layer.mock(BotsService.BotsService)({
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
