import { assert, describe, it } from "@effect/vitest";
import {
  type Bot,
  BotId,
  botThreadId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  ProviderInstanceId,
  RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import { BotsService } from "../BotsService.ts";
import { BotsStore } from "../BotsStore.ts";
import { GuestStore } from "../guest/GuestStore.ts";
import { KanbanService } from "../kanban/KanbanService.ts";
import { BotRotation, layerBase } from "./BotRotation.ts";
import { BOT_ROTATION_POLICY, handoffMessageId } from "./rotationPolicy.ts";

// Generations start here; the clock is set past the first quiet hour after it (local time).
const STARTED = "2026-10-20T13:00:00.000Z";
const DUE_NOW = "2026-10-23T12:00:00.000Z";

const makeBot = (id: string, homeGeneration = 1): Bot => ({
  id: BotId.make(id),
  name: id,
  role: "",
  model: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
  homeGeneration,
  sectionId: null,
  position: 0,
  canManageBots: false,
  rotation: "daily",
  createdAt: STARTED,
  updatedAt: STARTED,
});

interface FakeThread {
  readonly runs: Array<OrchestrationV2Run>;
  readonly requests: Array<OrchestrationV2RuntimeRequest>;
  readonly messages: Array<OrchestrationV2ConversationMessage>;
}

const run = (n: number, status: OrchestrationV2Run["status"], userMessageId = `m-${n}`) =>
  ({ id: RunId.make(`run-${n}`), status, userMessageId }) as unknown as OrchestrationV2Run;

const enoughRuns = () =>
  Array.from({ length: BOT_ROTATION_POLICY.minRuns }, (_, n) => run(n, "completed"));

/**
 * BotRotation over fakes: the bots, their conversations' records, delegated child threads, and a
 * log of what it asked the other services to do, in order.
 */
const setup = (bots: Array<Bot>) =>
  Effect.gen(function* () {
    const threads = new Map<ThreadId, FakeThread>();
    const children: Array<OrchestrationV2ThreadShell> = [];
    const log: Array<string> = [];
    const dispatched: Array<OrchestrationV2ServerCommand> = [];
    const archived = yield* Deferred.make<void>();
    for (const bot of bots) {
      threads.set(botThreadId(bot.id, bot.homeGeneration), {
        runs: enoughRuns(),
        requests: [],
        messages: [],
      });
    }
    const find = (id: BotId) => bots.find((bot) => bot.id === id);

    const layer = layerBase.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(BotsStore)({
            getBot: (id) => Effect.succeed(Option.fromNullishOr(find(id))),
            listBots: Effect.sync(() => [...bots]),
          }),
          Layer.mock(BotsService)({
            advanceGeneration: (input) =>
              Effect.sync(() => {
                const index = bots.findIndex((bot) => bot.id === input.botId);
                const current = bots[index]!;
                if (current.homeGeneration !== input.fromGeneration) return Option.none<Bot>();
                const next = { ...current, homeGeneration: current.homeGeneration + 1 };
                bots[index] = next;
                threads.set(botThreadId(next.id, next.homeGeneration), {
                  runs: [],
                  requests: [],
                  messages: [],
                });
                log.push(`advance ${input.botId} from ${input.fromGeneration}: ${input.handoff}`);
                return Option.some(next);
              }),
            archiveGeneration: (botId, generation) =>
              Effect.sync(() => log.push(`archive ${botThreadId(botId, generation)}`)).pipe(
                Effect.andThen(Deferred.succeed(archived, undefined)),
                Effect.asVoid,
              ),
          }),
          Layer.mock(GuestStore)({ guestOfBot: () => Effect.succeedNone }),
          Layer.mock(KanbanService)({
            refresh: Effect.sync(() => void log.push("kanban refresh")),
          }),
          Layer.mock(ScheduledTaskService.ScheduledTaskService)({
            rebindThread: (from, to) => Effect.sync(() => void log.push(`tasks ${from} -> ${to}`)),
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.never,
            dispatch: (command) =>
              Effect.sync(() => {
                dispatched.push(command as OrchestrationV2ServerCommand);
                return {} as never;
              }),
          }),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadRecords: (threadId, _fields, filter) =>
              Effect.sync(() => {
                const thread = threads.get(threadId)!;
                return {
                  thread: {
                    createdAt: DateTime.makeUnsafe(STARTED),
                    archivedAt: null,
                    deletedAt: null,
                  },
                  runs: thread.runs,
                  runtimeRequests: thread.requests,
                  messages: thread.messages.filter(
                    (message) =>
                      filter?.messageRunIds === undefined ||
                      (message.runId !== null && filter.messageRunIds.includes(message.runId)),
                  ),
                } as never;
              }),
            getShellSnapshot: () => Effect.sync(() => ({ threads: children }) as never),
          }),
        ),
      ),
    );
    const rotation = Context.get(yield* Layer.build(layer), BotRotation);
    yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(DUE_NOW)));
    return { rotation, threads, children, log, dispatched, archived };
  });

const handoffsOf = (commands: ReadonlyArray<OrchestrationV2ServerCommand>) =>
  commands.flatMap((command) =>
    command.type === "message.dispatch" ? [`${command.threadId} ${command.messageId}`] : [],
  );

describe("BotRotation", () => {
  it.effect(
    "a due idle bot gets one handoff turn, then rotates, and its tasks, links and old thread follow",
    () =>
      Effect.gen(function* () {
        const bot = makeBot("b_a");
        const { rotation, threads, log, dispatched } = yield* setup([bot]);
        const old = botThreadId(bot.id, 1);

        yield* rotation.consider(bot.id);
        assert.deepStrictEqual(handoffsOf(dispatched), [`${old} ${handoffMessageId(bot.id, 1)}`]);
        const request = dispatched[0] as Extract<
          OrchestrationV2ServerCommand,
          { type: "message.dispatch" }
        >;
        assert.deepStrictEqual(request.dispatchMode, { type: "queue_after_active" });

        // Its turn is under way: nothing more until it ends.
        const thread = threads.get(old)!;
        thread.runs.push(run(50, "running", handoffMessageId(bot.id, 1)));
        yield* rotation.consider(bot.id);
        assert.strictEqual(dispatched.length, 1);
        assert.deepStrictEqual(log, []);

        thread.runs[thread.runs.length - 1] = run(50, "completed", handoffMessageId(bot.id, 1));
        thread.messages.push({
          runId: RunId.make("run-50"),
          role: "assistant",
          text: "  Waiting on Ana for PR 12.  ",
          createdAt: DateTime.makeUnsafe(DUE_NOW),
        } as unknown as OrchestrationV2ConversationMessage);
        yield* rotation.consider(bot.id);

        assert.deepStrictEqual(log, [
          "advance b_a from 1: Waiting on Ana for PR 12.",
          `tasks ${old} -> ${botThreadId(bot.id, 2)}`,
          "kanban refresh",
          `archive ${old}`,
        ]);
        assert.strictEqual(dispatched.length, 1);
      }).pipe(Effect.scoped),
  );

  it.effect("waits while a question is pending or a delegated task of the bot still runs", () =>
    Effect.gen(function* () {
      const bot = makeBot("b_a");
      const { rotation, threads, children, dispatched } = yield* setup([bot]);
      const thread = threads.get(botThreadId(bot.id, 1))!;

      thread.requests.push({ status: "pending" } as OrchestrationV2RuntimeRequest);
      yield* rotation.consider(bot.id);
      assert.strictEqual(dispatched.length, 0);
      thread.requests.length = 0;

      children.push({
        lineage: {
          parentThreadId: botThreadId(bot.id, 1),
          relationshipToParent: "subagent",
          rootThreadId: botThreadId(bot.id, 1),
        },
        activeRunId: RunId.make("child-run"),
      } as unknown as OrchestrationV2ThreadShell);
      yield* rotation.consider(bot.id);
      assert.strictEqual(dispatched.length, 0);

      children.length = 0;
      yield* rotation.consider(bot.id);
      assert.strictEqual(dispatched.length, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("only one bot waits on its handoff at a time", () =>
    Effect.gen(function* () {
      const a = makeBot("b_a");
      const b = makeBot("b_b");
      const { rotation, threads, dispatched } = yield* setup([a, b]);

      yield* rotation.consider(a.id);
      yield* rotation.consider(b.id);
      assert.deepStrictEqual(handoffsOf(dispatched), [
        `${botThreadId(a.id, 1)} ${handoffMessageId(a.id, 1)}`,
      ]);

      threads.get(botThreadId(a.id, 1))!.runs.push(run(50, "failed", handoffMessageId(a.id, 1)));
      yield* rotation.consider(a.id);
      yield* rotation.consider(b.id);
      assert.deepStrictEqual(handoffsOf(dispatched).slice(1), [
        `${botThreadId(b.id, 1)} ${handoffMessageId(b.id, 1)}`,
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("the user's reset rotates at once, without a handoff turn, even while busy", () =>
    Effect.gen(function* () {
      const bot = makeBot("b_a");
      const { rotation, threads, log, dispatched } = yield* setup([bot]);
      threads.get(botThreadId(bot.id, 1))!.runs.push(run(50, "running"));

      const next = yield* rotation.reset({ botId: bot.id });
      assert.strictEqual(next.homeGeneration, 2);
      assert.deepStrictEqual(log, [
        "advance b_a from 1: null",
        `tasks ${botThreadId(bot.id, 1)} -> ${botThreadId(bot.id, 2)}`,
        "kanban refresh",
        `archive ${botThreadId(bot.id, 1)}`,
      ]);
      assert.strictEqual(dispatched.length, 0);
    }).pipe(Effect.scoped),
  );

  it.effect("startup finishes a rotation that stopped before the old thread was archived", () =>
    Effect.gen(function* () {
      const bot: Bot = { ...makeBot("b_a", 2), rotation: "off" };
      const { rotation, log, archived } = yield* setup([bot]);

      yield* rotation.start();
      yield* Deferred.await(archived);
      assert.deepStrictEqual(log, [
        `tasks ${botThreadId(bot.id, 1)} -> ${botThreadId(bot.id, 2)}`,
        "kanban refresh",
        `archive ${botThreadId(bot.id, 1)}`,
      ]);
    }).pipe(Effect.scoped),
  );
});
