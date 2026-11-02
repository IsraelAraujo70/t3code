import { webhookPayload } from "./webhookPayload.ts";
// @effect-diagnostics preferSchemaOverJson:off - Fixtures store the definition JSON as the store does.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import {
  ProjectId,
  type ScheduledTask,
  type ScheduledTaskUpsertInput,
  type WorkflowTrigger,
  WorkflowRunId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as BotsDb from "../../BotsDb.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import { insertVersion, upsertIndex } from "../definitions/definitionsStore.ts";
import { workflowStream } from "../facts.ts";
import { Journal, layerFromDb } from "../Journal.ts";
import { type TriggerRequest, WorkflowEngine } from "../WorkflowEngine.ts";
import { WorkflowEngineCaller, WorkflowTriggerHook } from "./hook.ts";
import { layerBindHook, layerHook, makeReconciler } from "./webhook.ts";

const request = { method: "POST", path: "/", query: "", headers: {}, bodyText: '{"ref":"main"}' };

const HOOK = "wf-hook:inbox:push";
const runId = WorkflowRunId.make("wfr_00000000000000000000");

const seed = Effect.fn("test.seed")(function* (
  triggers: ReadonlyArray<WorkflowTrigger & { readonly id: string }>,
  commit = `head-${triggers.length}`,
) {
  yield* insertVersion({
    workflow_id: "inbox",
    commit_sha: commit,
    revision: "rev",
    semantic_hash: "hash",
    source: "",
    author: "test",
    created_at: "now",
    definition_json: JSON.stringify({
      schema: "t3.workflow/v1",
      id: "inbox",
      title: "Inbox",
      home: { project: "app" },
      triggers: Object.fromEntries(triggers.map(({ id, ...trigger }) => [id, trigger])),
      budget: { steps: 10, wall: "1h", tokens: 100 },
      fatigue: { consecutiveFailures: 3 },
      nodes: {},
      edges: [],
    }),
  });
  yield* upsertIndex({
    workflow_id: "inbox",
    path: "inbox.workflow.yaml",
    head_commit: commit,
    revision: "rev",
    title: "Inbox",
    valid: 1,
    dirty: 0,
    diagnostics_json: "[]",
    triggers_json: "[]",
    scanned_at: "now",
  });
  const journal = yield* Journal;
  yield* journal.append([
    {
      stream: workflowStream("inbox"),
      key: "toggled:on",
      fact: { _tag: "Toggled", enabled: true, by: "test", at: "now" },
    },
  ]);
});

const push: WorkflowTrigger & { readonly id: string } = {
  id: "push",
  kind: "webhook",
  signature: { header: "x-hub-signature-256", encoding: "hex", prefix: "sha256=" },
};
const db = layerFromDb.pipe(Layer.provideMerge(BotsDb.layerMemory));

const recordingEngine = (requests: Array<TriggerRequest>) =>
  Layer.mock(WorkflowEngine)({
    start: (request) =>
      Effect.sync(() => {
        requests.push(request);
        return { runId };
      }),
  });

it.effect("a delivery becomes the trigger's TriggerFired once the engine is bound", () =>
  Effect.gen(function* () {
    yield* seed([push]);
    const requests: Array<TriggerRequest> = [];
    yield* Effect.gen(function* () {
      const hook = yield* WorkflowTriggerHook;
      yield* hook.fire({ request, taskId: HOOK, deliveryId: "d1", prompt: '{"ref":"main"}' });
      for (const taskId of ["wf-hook:inbox", "wf-hook:inbox:gone", "wf-hook:other:push"]) {
        const exit = yield* Effect.exit(
          hook.fire({ request, taskId, deliveryId: "d2", prompt: "x" }),
        );
        assert.isTrue(Exit.isFailure(exit));
      }
    }).pipe(
      Effect.provide(
        layerBindHook.pipe(Layer.provideMerge(layerHook), Layer.provide(recordingEngine(requests))),
      ),
    );
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      workflowId: "inbox",
      triggerId: "push",
      kind: "webhook",
      occurrence: "webhook:d1",
      payload: webhookPayload(request, '{"ref":"main"}'),
    });
  }).pipe(Effect.provide(db)),
);

it.effect("a delivery before the engine waits for it, and fails after 60 s without it", () =>
  Effect.gen(function* () {
    yield* seed([push]);
    const requests: Array<TriggerRequest> = [];
    const context = yield* Layer.build(layerHook);
    const hook = Context.get(context, WorkflowTriggerHook);
    // Waits, then completes once the engine side binds the hook.
    const waiting = yield* hook
      .fire({ request, taskId: HOOK, deliveryId: "early", prompt: "x" })
      .pipe(Effect.forkChild);
    yield* Layer.build(layerBindHook.pipe(Layer.provide(recordingEngine(requests)))).pipe(
      Effect.provideContext(context),
    );
    yield* Fiber.join(waiting);
    expect(requests.map((request) => request.occurrence)).toEqual(["webhook:early"]);

    const unbound = Context.get(yield* Layer.build(layerHook), WorkflowTriggerHook);
    const late = yield* unbound
      .fire({ request, taskId: HOOK, deliveryId: "late", prompt: "x" })
      .pipe(Effect.exit, Effect.forkChild);
    yield* TestClock.adjust("60 seconds");
    assert.isTrue(Exit.isFailure(yield* Fiber.join(late)));
  }).pipe(Effect.scoped, Effect.provide(db)),
);

const fakeTasks = (calls: Array<string>) => {
  const tasks = new Map<string, ScheduledTask>();
  const engineOnly = <A>(name: string, effect: Effect.Effect<A>) =>
    Effect.gen(function* () {
      assert.isTrue(yield* WorkflowEngineCaller, `${name} outside asWorkflowEngine`);
      calls.push(name);
      return yield* effect;
    });
  const service = Layer.mock(ScheduledTaskService.ScheduledTaskService)({
    list: () => Effect.sync(() => ({ tasks: [...tasks.values()] })),
    upsert: (input: ScheduledTaskUpsertInput) =>
      engineOnly(
        `upsert ${input.id}`,
        Effect.sync(() => {
          const signature =
            input.schedule.type === "webhook" ? input.schedule.signature : undefined;
          const secret = signature && "secret" in signature ? signature.secret : undefined;
          calls.push(`secret ${secret ?? "none"}`);
          const task = {
            ...input,
            id: input.id!,
            schedule:
              input.schedule.type === "webhook" && signature
                ? {
                    ...input.schedule,
                    signature: {
                      header: signature.header,
                      encoding: signature.encoding,
                      prefix: signature.prefix,
                    },
                  }
                : input.schedule,
            webhook: { path: `/api/hooks/${input.id}`, url: null, hasSecret: secret !== undefined },
          } as unknown as ScheduledTask;
          tasks.set(task.id, task);
          return { task };
        }),
      ),
    delete: (input) =>
      engineOnly(
        `delete ${input.id}`,
        Effect.sync(() => {
          tasks.delete(input.id);
          return { id: input.id };
        }),
      ),
  });
  return { tasks, service };
};

it.live("keeps each webhook trigger's task in step, with one secret for its whole life", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const secretsDir = `${yield* fs.makeTempDirectoryScoped()}/secrets`;
      yield* seed([push]);
      const calls: Array<string> = [];
      const { tasks, service } = fakeTasks(calls);
      const project = ProjectId.make("project-app");
      const resolveProject = (ref: string) =>
        Effect.succeed(ref === "app" ? Option.some(project) : Option.none());
      yield* Effect.gen(function* () {
        const { reconcile } = yield* makeReconciler({ resolveProject, secretsDir });
        yield* reconcile();
        expect(calls[0]).toBe(`upsert ${HOOK}`);
        const secret = calls[1];
        expect(secret).toMatch(/^secret [0-9a-f]{64}$/);
        expect(tasks.get(HOOK)).toMatchObject({ projectId: project, prompt: "{{request}}" });

        calls.length = 0;
        yield* reconcile();
        expect(calls).toEqual([]);

        // Deleted elsewhere: the next pass brings it back with the same secret.
        tasks.delete(HOOK);
        yield* reconcile();
        expect(calls).toEqual([`upsert ${HOOK}`, secret]);

        // Filters removed from the trigger are cleared on the task, and that converges.
        calls.length = 0;
        yield* seed(
          [{ ...push, filters: [{ path: "body.action", op: "equals", value: "opened" }] }],
          "head-filtered",
        );
        yield* reconcile();
        expect(tasks.get(HOOK)?.schedule).toMatchObject({ filters: [{ path: "body.action" }] });
        yield* seed([push], "head-unfiltered");
        yield* reconcile();
        expect(tasks.get(HOOK)?.schedule).toMatchObject({ filters: [] });
        calls.length = 0;
        yield* reconcile();
        expect(calls).toEqual([]);

        calls.length = 0;
        yield* seed([]);
        yield* reconcile();
        expect(calls).toEqual([`delete ${HOOK}`]);
      }).pipe(Effect.provide(service));
    }),
  ).pipe(Effect.provide(Layer.mergeAll(db, NodeServices.layer))),
);

it.effect("a workflow whose home project is unknown gets no task", () =>
  Effect.gen(function* () {
    yield* seed([push]);
    const calls: Array<string> = [];
    const { service } = fakeTasks(calls);
    yield* Effect.gen(function* () {
      const { reconcile } = yield* makeReconciler({
        resolveProject: () => Effect.succeedNone,
        secretsDir: "/nonexistent",
      });
      yield* reconcile();
    }).pipe(Effect.provide(service));
    expect(calls).toEqual([]);
  }).pipe(Effect.provide(Layer.mergeAll(db, NodeServices.layer))),
);
