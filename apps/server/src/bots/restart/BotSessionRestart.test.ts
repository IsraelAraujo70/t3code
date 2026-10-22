import { assert, it } from "@effect/vitest";
import {
  type Bot,
  BotId,
  botThreadId,
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderThread,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ClaudeProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "../../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import { BotsStore } from "../BotsStore.ts";
import * as BotSessionRestart from "./BotSessionRestart.ts";

const driver = ProviderDriverKind.make("claudeAgent");
const instanceId = ProviderInstanceId.make("claude-restart-test");
const model = { instanceId, model: "restart-model" } satisfies ModelSelection;

/** What the fake provider saw: each process start and the MCP servers each turn could use. */
interface Seen {
  readonly opens: Array<{ readonly resumeNativeThreadId: string | null }>;
  readonly turns: Array<{
    readonly text: string;
    readonly nativeThreadId: string | null;
    readonly mcpServers: ReadonlyArray<string>;
  }>;
}

/**
 * Like `claude`, each session reads the MCP servers configured when its process starts and keeps
 * them until it ends. A turn whose text is "hold" keeps running.
 */
function makeAdapter(
  seen: Seen,
  config: { mcpServers: ReadonlyArray<string> },
  capabilities: OrchestrationV2ProviderCapabilities,
): ProviderAdapter.ProviderAdapterV2["Service"] {
  return {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(capabilities),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (input) =>
      Effect.gen(function* () {
        seen.opens.push({ resumeNativeThreadId: input.initialNativeThreadId ?? null });
        const mcpServers = config.mcpServers;
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const now = yield* DateTime.now;
        return {
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd: input.runtimePolicy.cwd ?? "/fallback",
            model: input.modelSelection.model,
            capabilities,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: (thread) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              return {
                id: ProviderThreadId.make(`provider-thread:${thread.threadId}`),
                driver,
                providerInstanceId: instanceId,
                providerSessionId: input.providerSessionId,
                appThreadId: thread.threadId,
                ownerNodeId: null,
                nativeThreadRef: {
                  driver,
                  nativeId: `native-thread:${thread.threadId}`,
                  strength: "strong",
                },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
          startTurn: (turn) =>
            Effect.gen(function* () {
              const text = turn.message.text;
              seen.turns.push({
                text,
                nativeThreadId: turn.providerThread.nativeThreadRef?.nativeId ?? null,
                mcpServers,
              });
              const providerTurnId = ProviderTurnId.make(`provider-turn:${turn.attemptId}`);
              const occurredAt = yield* DateTime.now;
              const status = text === "hold" ? "running" : "completed";
              yield* Queue.offer(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: {
                  id: providerTurnId,
                  providerThreadId: turn.providerThread.id,
                  nodeId: turn.rootNodeId,
                  runAttemptId: turn.attemptId,
                  nativeTurnRef: {
                    driver,
                    nativeId: `native:${providerTurnId}`,
                    strength: "strong",
                  },
                  ordinal: turn.providerTurnOrdinal,
                  status,
                  startedAt: occurredAt,
                  completedAt: status === "completed" ? occurredAt : null,
                },
              });
              if (status === "completed")
                yield* Queue.offer(events, {
                  type: "turn.terminal",
                  driver,
                  providerThreadId: turn.providerThread.id,
                  providerTurnId,
                  runOrdinal: turn.runOrdinal,
                  status,
                  failure: null,
                  threadDisposition: "reusable",
                });
            }),
          steerTurn: () => Effect.void,
          interruptTurn: () => Effect.void,
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused readThreadSnapshot"),
          rollbackThread: () => Effect.die("unused rollbackThread"),
          forkThread: () => Effect.die("unused forkThread"),
        };
      }),
  };
}

const bot: Bot = {
  id: BotId.make("b_restart"),
  name: "Ada",
  role: "Helps.",
  model,
  homeGeneration: 1,
  sectionId: null,
  position: 0,
  canManageBots: false,
  createdAt: "2026-10-22T00:00:00.000Z",
  updatedAt: "2026-10-22T00:00:00.000Z",
};
const threadId = botThreadId(bot.id, bot.homeGeneration);
const nativeThreadId = `native-thread:${threadId}`;

/** Runs `use` against the real orchestrator, with the fake provider and a restart for `bot`. */
const withRuntime = <A, E>(
  name: string,
  capabilities: OrchestrationV2ProviderCapabilities,
  use: (input: {
    readonly config: { mcpServers: ReadonlyArray<string> };
    readonly restarts: BotSessionRestart.BotSessionRestart["Service"];
    readonly send: (thread: ThreadId, text: string) => Effect.Effect<void, unknown, Scope.Scope>;
    readonly orchestrator: Orchestrator.OrchestratorV2["Service"];
  }) => Effect.Effect<A, E, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const cwd = yield* checkpointWorkspace(name);
    const seen: Seen = { opens: [], turns: [] };
    const config = { mcpServers: ["t3-code"] as ReadonlyArray<string> };
    // One in-memory database, shared by the runtime and the restart's projection reads.
    const database = SqlitePersistence.layerMemory;
    const runtime = ProviderReplayHarness.layerWithRegistry(
      { name },
      ProviderAdapterRegistry.layerSingle(makeAdapter(seen, config, capabilities)),
      { databaseLayer: database },
    );
    const restartLayer = BotSessionRestart.layer.pipe(
      Layer.provide(ProjectionStore.layer.pipe(Layer.provide(database))),
      Layer.provide(
        Layer.mock(BotsStore)({
          getBot: (id) => Effect.succeed(id === bot.id ? Option.some(bot) : Option.none()),
        }),
      ),
    );
    const result = yield* Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const restarts = yield* BotSessionRestart.BotSessionRestart;
      const created = new Set<ThreadId>();
      const send = (thread: ThreadId, text: string) =>
        Effect.gen(function* () {
          if (!created.has(thread)) {
            created.add(thread);
            yield* orchestrator.dispatch({
              type: "thread.create",
              createdBy: "system",
              creationSource: "server",
              commandId: CommandId.make(`${thread}:create`),
              threadId: thread,
              projectId: ProjectId.make(`project:${name}`),
              title: thread,
              modelSelection: model,
              runtimeMode: "full-access",
              interactionMode: "default",
              branch: null,
              worktreePath: cwd,
            });
          }
          const settled = yield* orchestrator.streamDomainEvents.pipe(
            Stream.filter(
              (event) =>
                event.threadId === thread &&
                event.type === "run.updated" &&
                (event.payload.status === "completed" ||
                  (text === "hold" && event.payload.status === "running")),
            ),
            Stream.take(1),
            Stream.runDrain,
            Effect.forkScoped,
          );
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make(`${thread}:${text}`),
            threadId: thread,
            messageId: MessageId.make(`${thread}:${text}`),
            text,
            attachments: [],
            modelSelection: model,
            dispatchMode: { type: "queue_after_active" },
          });
          yield* worker.drain();
          yield* Fiber.join(settled);
          yield* worker.drain();
        });
      return yield* use({ config, restarts, send, orchestrator });
    }).pipe(Effect.provide(Layer.provideMerge(restartLayer, runtime)));
    return { result, seen };
  });

it.live("restarts an idle bot's provider process: same conversation, new MCP servers", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { seen } = yield* withRuntime(
        "bot-session-restart",
        ClaudeProviderCapabilitiesV2,
        ({ config, restarts, send, orchestrator }) =>
          Effect.gen(function* () {
            yield* send(threadId, "before");
            // A server added after the process started is not loaded by the running process.
            config.mcpServers = ["t3-code", "new-server"];
            yield* send(threadId, "unchanged");
            assert.deepStrictEqual(yield* restarts.restart({ botId: bot.id }), {
              botId: bot.id,
              stopped: true,
            });
            // Nothing runs now, so a second restart has nothing to stop.
            assert.deepStrictEqual(yield* restarts.restart({ botId: bot.id }), {
              botId: bot.id,
              stopped: false,
            });
            yield* send(threadId, "after");

            const projection = yield* orchestrator.getThreadProjection(threadId);
            assert.isFalse(projection.runs.some((run) => run.queueHeld === true));
            assert.deepStrictEqual(
              projection.runs.map((run) => run.status),
              ["completed", "completed", "completed"],
            );

            // A turn in flight is never cut off.
            yield* send(threadId, "hold");
            const refused = yield* restarts.restart({ botId: bot.id }).pipe(Effect.flip);
            assert.strictEqual(
              refused.message,
              "Ada is working. Restart the session once the current turn ends.",
            );
          }),
      );
      assert.deepStrictEqual(seen.opens, [
        { resumeNativeThreadId: null },
        { resumeNativeThreadId: nativeThreadId },
      ]);
      assert.deepStrictEqual(seen.turns, [
        { text: "before", nativeThreadId, mcpServers: ["t3-code"] },
        { text: "unchanged", nativeThreadId, mcpServers: ["t3-code"] },
        { text: "after", nativeThreadId, mcpServers: ["t3-code", "new-server"] },
        { text: "hold", nativeThreadId, mcpServers: ["t3-code", "new-server"] },
      ]);
    }),
  ),
);

it.live("keeps a process another thread's turn is running on", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const other = ThreadId.make("thread:restart-other");
      const { seen } = yield* withRuntime(
        "bot-session-restart-shared",
        CodexProviderCapabilitiesV2,
        ({ restarts, send }) =>
          Effect.gen(function* () {
            yield* send(threadId, "before");
            yield* send(other, "hold");
            const refused = yield* restarts.restart({ botId: bot.id }).pipe(Effect.flip);
            assert.strictEqual(
              refused.message,
              "Ada's provider process is still working (background work, or another thread sharing it). Try again once it is idle.",
            );
          }),
      );
      assert.deepStrictEqual(seen.opens, [{ resumeNativeThreadId: null }]);
    }),
  ),
);
