import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  BotId,
  botThreadId,
  ScheduledTaskId,
  ScheduledTaskUpsertInput,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";

const decodeUpsert = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);

const task = (id: string, threadId: ThreadId, schedule: unknown) =>
  decodeUpsert({
    id,
    title: id,
    prompt: "Check in",
    enabled: true,
    schedule,
    projectId: "project:scratch",
    threadId,
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
    runtimeMode: "full-access",
    interactionMode: "default",
  });

it.effect(
  "a bot's scheduled and webhook tasks move to its next generation, and the next run goes there",
  () =>
    Effect.gen(function* () {
      const sentTo: Array<ThreadId> = [];
      const layer = ScheduledTaskService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
            Layer.mock(ThreadManagementService.ThreadManagementService)({
              sendToThread: (input) =>
                Effect.sync(() => {
                  sentTo.push(input.threadId);
                  return {} as never;
                }),
            }),
            Layer.mock(SecretRequests.SecretRequests)({}),
            Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
              namedProjectsRoot: "/projects",
              isScratchProject: () => Effect.succeed(true),
            }),
            NodeCrypto.layer,
            Scheduler.layer,
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const service = yield* ScheduledTaskService.ScheduledTaskService;
        const bot = BotId.make("b_rotating");
        const old = botThreadId(bot, 1);
        const next = botThreadId(bot, 2);
        const other = ThreadId.make("thread-other");
        yield* service.upsert(
          yield* task("task:interval", old, { type: "interval", everyMs: 3_600_000 }),
        );
        yield* service.upsert(yield* task("task:webhook", old, { type: "webhook" }));
        yield* service.upsert(
          yield* task("task:other", other, { type: "interval", everyMs: 3_600_000 }),
        );

        yield* service.rebindThread(old, next);

        const bound = Object.fromEntries(
          (yield* service.list()).tasks.map((entry) => [entry.id, entry.threadId]),
        );
        assert.deepStrictEqual(bound, {
          "task:interval": next,
          "task:webhook": next,
          "task:other": other,
        });
        const { threadId } = yield* service.runNow({ id: ScheduledTaskId.make("task:interval") });
        assert.strictEqual(threadId, next);
        assert.deepStrictEqual(sentTo, [next]);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
