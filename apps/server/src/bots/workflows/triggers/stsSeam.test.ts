import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { ScheduledTaskError, ScheduledTaskId, ScheduledTaskUpsertInput } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";

import * as ThreadLaunchService from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as ManagedPolicy from "../../../policy/ManagedPolicy.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../../../scheduling/Scheduler.ts";
import * as SecretRequests from "../../../secrets/SecretRequests.ts";
import { asWorkflowEngine, WorkflowTriggerHook } from "./hook.ts";

const decodeUpsertInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);
const HOOK_ID = ScheduledTaskId.make("wf-hook:nightly:on-push");
const COALESCED = { coalesceKey: "{{request}}", coalesceWindowSeconds: 10 };
const MANAGED = "This task is managed by a workflow; change it in the workflow.";

const taskInput = (id: string, dedupe?: typeof COALESCED) =>
  decodeUpsertInput({
    id,
    title: "Hook",
    prompt: "Review this PR: {{body.pull_request.url}}",
    enabled: true,
    schedule: dedupe === undefined ? { type: "webhook" } : { type: "webhook", dedupe },
    projectId: "project-webhook",
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
  });

const body = new TextEncoder().encode(
  JSON.stringify({ pull_request: { url: "https://github.com/acme/app/pull/45" } }),
);

const requestFor = (task: {
  readonly id: string;
  readonly webhook?: { readonly path: string } | undefined;
}): ScheduledTaskService.WebhookTriggerRequest => ({
  hookId: task.id,
  token: task.webhook?.path.split("/").at(-1) ?? "",
  method: "POST",
  path: `/api/hooks/${task.id}`,
  query: "",
  headers: { "content-type": "application/json" },
  body,
  bodyText: new TextDecoder().decode(body),
});

/** Runs a registered worker and waits for the span that ends its dispatch. */
const runWorkerUntilSpan = (work: Effect.Effect<void>, name: string) =>
  Effect.gen(function* () {
    const done = yield* Deferred.make<void>();
    const tracer = Tracer.make({
      span: (options) => {
        const span = new Tracer.NativeSpan(options);
        const end = span.end.bind(span);
        span.end = (...args) => {
          end(...args);
          if (span.name === name) Deferred.doneUnsafe(done, Effect.void);
        };
        return span;
      },
    });
    yield* work.pipe(Effect.withTracer(tracer));
    yield* Deferred.await(done);
  });

const dispatchPending = (workers: Map<string, Effect.Effect<void>>) =>
  runWorkerUntilSpan(
    workers.get("webhook-coalescing")!,
    "ScheduledTaskService.dispatchPendingWebhook",
  );

const recordingHook = Effect.gen(function* () {
  const calls = yield* Ref.make<
    ReadonlyArray<{
      readonly taskId: string;
      readonly deliveryId: string;
      readonly prompt: string;
      readonly request: import("../../../scheduledTasks/webhookTemplate.ts").WebhookRequest;
    }>
  >([]);
  const hook = WorkflowTriggerHook.of({
    fire: (input) => Ref.update(calls, (rows) => [...rows, input]),
  });
  return { calls, hook };
});

interface Harness {
  readonly service: ScheduledTaskService.ScheduledTaskService["Service"];
  readonly launches: Queue.Queue<ThreadLaunchService.ThreadLaunchInput>;
  readonly sql: SqlClient.SqlClient;
}

/** One STS over the given database; a second call over the same `sql` is a restarted server. */
const withService = <A, E>(
  run: (harness: Harness) => Effect.Effect<A, E>,
  options: {
    readonly hook?: WorkflowTriggerHook["Service"];
    readonly workers: Map<string, Effect.Effect<void>>;
    readonly sql?: SqlClient.SqlClient;
  },
) =>
  Effect.gen(function* () {
    const launches = yield* Queue.unbounded<ThreadLaunchService.ThreadLaunchInput>();
    const dependencies = Layer.mergeAll(
      NodePlatformCrypto.layer,
      Layer.succeed(Scheduler.Scheduler, {
        register: <E2, R>(name: string, work: Effect.Effect<void, E2, R>) =>
          Effect.gen(function* () {
            const context = yield* Effect.context<R>();
            options.workers.set(name, work.pipe(Effect.provideContext(context), Effect.orDie));
          }),
      }),
      Layer.mock(ThreadLaunchService.ThreadLaunchService)({
        launch: (input) =>
          Queue.offer(launches, input).pipe(
            Effect.as({ threadId: "thread-1", resumed: false } as never),
          ),
      }),
      ManagedPolicy.layerTest(),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
        namedProjectsRoot: "/projects",
        isScratchProject: () => Effect.succeed(false),
      }),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(SecretRequests.SecretRequests)({}),
      Layer.succeed(
        ScheduledTaskService.ScheduledTaskWebhookOrigin,
        Effect.succeed({ relayHookBaseUrl: null }),
      ),
      options.hook === undefined ? Layer.empty : Layer.succeed(WorkflowTriggerHook, options.hook),
    );
    return yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const sql = yield* SqlClient.SqlClient;
      return yield* run({ service, launches, sql });
    }).pipe(
      Effect.provide(Layer.fresh(ScheduledTaskService.layer.pipe(Layer.provide(dependencies)))),
    );
  }).pipe(
    Effect.provide(
      options.sql === undefined
        ? SqlitePersistence.layerMemory
        : Layer.succeed(SqlClient.SqlClient, options.sql),
    ),
  );

const pendingStates = (sql: SqlClient.SqlClient) =>
  sql<{ readonly state: string }>`SELECT state FROM scheduled_task_webhook_pending`.pipe(
    Effect.map((rows) => rows.map((row) => row.state)),
  );

it.effect("an accepted workflow delivery survives a restart and fires the hook once", () =>
  Effect.gen(function* () {
    const { calls, hook } = yield* recordingHook;
    yield* withService(
      ({ service, sql, launches }) =>
        Effect.gen(function* () {
          const { task } = yield* asWorkflowEngine(
            service.upsert(yield* taskInput(HOOK_ID, COALESCED)),
          );
          const accepted = yield* service.triggerWebhook(requestFor(task));
          assert.equal(accepted._tag, "accepted");
          // Durable before the 202: the server can die here.
          assert.deepEqual(yield* pendingStates(sql), ["pending"]);
          assert.deepEqual(yield* Ref.get(calls), []);

          const restarted = new Map<string, Effect.Effect<void>>();
          yield* withService(
            ({ launches: restartedLaunches }) =>
              Effect.gen(function* () {
                yield* TestClock.adjust("10 seconds");
                yield* dispatchPending(restarted);
                yield* restarted.get("webhook-coalescing")!;
                const rows = yield* Ref.get(calls);
                assert.equal(rows.length, 1);
                assert.equal(rows[0]?.request.bodyText, new TextDecoder().decode(body));
                assert.equal(rows[0]?.taskId, HOOK_ID);
                assert.equal(
                  rows[0]?.deliveryId,
                  accepted._tag === "accepted" ? accepted.deliveryId : "",
                );
                assert.include(rows[0]?.prompt ?? "", "https://github.com/acme/app/pull/45");
                assert.deepEqual(yield* pendingStates(sql), []);
                assert.equal(yield* Queue.size(restartedLaunches), 0);
              }),
            { sql, workers: restarted, hook },
          );
          assert.equal(yield* Queue.size(launches), 0);
        }),
      { workers: new Map(), hook },
    );
  }),
);

it.effect("an immediate workflow delivery preserves its request", () =>
  Effect.gen(function* () {
    const { calls, hook } = yield* recordingHook;
    const delivered = yield* Deferred.make<void>();
    const immediateHook = WorkflowTriggerHook.of({
      fire: (input) =>
        hook.fire(input).pipe(Effect.andThen(Deferred.succeed(delivered, undefined))),
    });
    yield* withService(
      ({ service }) =>
        Effect.gen(function* () {
          const { task } = yield* asWorkflowEngine(service.upsert(yield* taskInput(HOOK_ID)));
          assert.equal((yield* service.triggerWebhook(requestFor(task)))._tag, "accepted");
          yield* Deferred.await(delivered);
          const rows = yield* Ref.get(calls);
          assert.equal(rows.length, 1);
          assert.equal(rows[0]?.request.bodyText, new TextDecoder().decode(body));
        }),
      { workers: new Map(), hook: immediateHook },
    );
  }),
);

it.effect("without the engine a workflow delivery fails and never launches a thread", () =>
  Effect.gen(function* () {
    const workers = new Map<string, Effect.Effect<void>>();
    yield* withService(
      ({ service, sql, launches }) =>
        Effect.gen(function* () {
          const { task } = yield* asWorkflowEngine(
            service.upsert(yield* taskInput(HOOK_ID, COALESCED)),
          );
          assert.equal((yield* service.triggerWebhook(requestFor(task)))._tag, "accepted");
          yield* TestClock.adjust("10 seconds");
          yield* dispatchPending(workers);
          assert.deepEqual(yield* pendingStates(sql), []);
          const { tasks } = yield* service.list();
          assert.equal(tasks[0]?.lastRunStatus, "failed");
          assert.include(tasks[0]?.lastRunError ?? "", "The workflow engine is not available.");
          assert.equal(yield* Queue.size(launches), 0);
        }),
      { workers },
    );
  }),
);

it.effect("an ordinary webhook task still launches its thread", () =>
  Effect.gen(function* () {
    const { calls, hook } = yield* recordingHook;
    yield* withService(
      ({ service, launches }) =>
        Effect.gen(function* () {
          const { task } = yield* service.upsert(yield* taskInput("scheduled-task:plain"));
          assert.equal((yield* service.triggerWebhook(requestFor(task)))._tag, "accepted");
          const launched = yield* Queue.take(launches);
          assert.include(
            launched.initialMessage?.text ?? "",
            "https://github.com/acme/app/pull/45",
          );
          assert.deepEqual(yield* Ref.get(calls), []);
        }),
      { workers: new Map(), hook },
    );
  }),
);

it.effect("only the engine changes a workflow task, and nobody runs it now", () =>
  Effect.gen(function* () {
    const { hook } = yield* recordingHook;
    yield* withService(
      ({ service }) =>
        Effect.gen(function* () {
          const input = yield* taskInput(HOOK_ID);
          const refused = <A>(effect: Effect.Effect<A, ScheduledTaskError>) =>
            effect.pipe(
              Effect.flip,
              Effect.map((error) => error.message),
            );
          assert.equal(yield* refused(service.upsert(input)), MANAGED);
          yield* asWorkflowEngine(service.upsert(input));

          assert.equal(
            yield* refused(service.setEnabled({ id: HOOK_ID, enabled: false })),
            MANAGED,
          );
          assert.equal(yield* refused(service.rotateWebhookToken({ id: HOOK_ID })), MANAGED);
          assert.equal(yield* refused(service.runNow({ id: HOOK_ID })), MANAGED);
          assert.equal(yield* refused(service.delete({ id: HOOK_ID })), MANAGED);
          assert.equal(
            yield* refused(asWorkflowEngine(service.runNow({ id: HOOK_ID }))),
            "Workflow tasks fire only by webhook.",
          );
          yield* asWorkflowEngine(service.setEnabled({ id: HOOK_ID, enabled: false }));
          yield* asWorkflowEngine(service.rotateWebhookToken({ id: HOOK_ID }));
          yield* asWorkflowEngine(service.delete({ id: HOOK_ID }));
          assert.deepEqual((yield* service.list()).tasks, []);
        }),
      { workers: new Map(), hook },
    );
  }),
);
