/**
 * Webhook triggers (design §5): each one is a scheduled task `wf-hook:<workflowId>:<triggerId>`
 * that the engine keeps in step with the definitions. The scheduled-task service sits below the
 * orchestration runtime and the engine above it, so the hook lives in the core layer and waits for
 * the engine side to bind it.
 */
import {
  type ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  type ScheduledTask,
  type ScheduledTaskUpsertInput,
  type WorkflowTrigger,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../../config.ts";
import { ProjectService } from "../../../project/ProjectService.ts";
import { forkParked } from "../../../serverActivation.ts";
import * as ScheduledTaskService from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as WorkflowDefinitions from "../definitions/WorkflowDefinitions.ts";
import { Journal } from "../Journal.ts";
import { projectByRef } from "../exec/projects.ts";
import { WorkflowEngine } from "../WorkflowEngine.ts";
import { fireTrigger } from "./fire.ts";
import {
  asWorkflowEngine,
  isWorkflowHookTaskId,
  workflowHookTaskId,
  WorkflowTriggerHook,
  WorkflowTriggerHookError,
} from "./hook.ts";
import { occurrenceKey } from "./occurrence.ts";
import { makeTriggerTargets, type TriggerTarget } from "./targets.ts";

type HookFire = WorkflowTriggerHook["Service"]["fire"];

/** Filled once the engine is up; deliveries that arrive earlier wait for it. */
export class WorkflowHookBinding extends Context.Service<
  WorkflowHookBinding,
  { readonly fire: Deferred.Deferred<HookFire> }
>()("t3/bots/workflows/triggers/webhook/WorkflowHookBinding") {}

const ENGINE_WAIT = "60 seconds";
const HOOK_TASK_ID = /^wf-hook:([a-z][a-z0-9-]{0,62}):([a-z][a-z0-9_]{0,40})$/;

/** The hook the scheduled-task service reads, plus the binding the engine side completes. */
export const layerHook = Layer.effectContext(
  Effect.gen(function* () {
    const fire = yield* Deferred.make<HookFire>();
    const hook = WorkflowTriggerHook.of({
      fire: Effect.fn("WorkflowTriggerHook.fire")(function* (input) {
        const bound = yield* Deferred.await(fire).pipe(
          Effect.timeoutOrElse({
            duration: ENGINE_WAIT,
            orElse: () => Effect.fail(new WorkflowTriggerHookError({ taskId: input.taskId })),
          }),
        );
        return yield* bound(input);
      }),
    });
    return Context.make(WorkflowHookBinding, WorkflowHookBinding.of({ fire })).pipe(
      Context.add(WorkflowTriggerHook, hook),
    );
  }),
);

/** Binds the hook to the engine: a delivery becomes the trigger's TriggerFired. */
export const layerBindHook = Layer.effectDiscard(
  Effect.gen(function* () {
    const binding = yield* Effect.serviceOption(WorkflowHookBinding);
    const engine = yield* Effect.serviceOption(WorkflowEngine);
    if (Option.isNone(binding) || Option.isNone(engine)) return;
    const context = yield* Effect.context<SqlClient.SqlClient | Journal>();
    const listTriggerTargets = yield* makeTriggerTargets;
    const fire: HookFire = Effect.fn("WorkflowWebhooks.fire")(function* (input) {
      const failed = (cause?: unknown) =>
        new WorkflowTriggerHookError({ taskId: input.taskId, cause });
      const parts = HOOK_TASK_ID.exec(input.taskId);
      if (parts === null) return yield* failed();
      const target = (yield* listTriggerTargets.pipe(Effect.mapError(failed))).find(
        (candidate) =>
          candidate.workflowId === parts[1] &&
          candidate.trigger.id === parts[2] &&
          candidate.trigger.kind === "webhook",
      );
      if (target === undefined) return yield* failed();
      yield* fireTrigger(engine.value, target, {
        kind: "webhook",
        occurrence: occurrenceKey.webhook(input.deliveryId),
        label: "webhook",
        payload: { text: input.prompt },
      }).pipe(Effect.mapError(failed));
    }, Effect.provideContext(context));
    yield* Deferred.succeed(binding.value.fire, fire);
  }),
);

type WebhookTrigger = Extract<WorkflowTrigger, { readonly kind: "webhook" }>;

/** The task a webhook trigger needs, without its secret. */
const desiredTask = (
  target: TriggerTarget,
  trigger: WebhookTrigger,
  projectId: ProjectId,
): ScheduledTaskUpsertInput => ({
  id: ScheduledTaskId.make(workflowHookTaskId(target.workflowId, trigger.id)),
  title: `Workflow ${target.workflowId}: ${trigger.id}`,
  prompt: trigger.template ?? "{{request}}",
  enabled: true,
  schedule: {
    type: "webhook",
    signature: trigger.signature ?? null,
    // Omitted filters keep the stored ones in upsert, so removing them must send [].
    filters: trigger.filters ?? [],
    dedupe: {
      ...(trigger.replayKey === undefined ? {} : { replayKey: trigger.replayKey }),
      // A coalesce key makes each accepted delivery a durable row before the 202.
      coalesceKey: "{{request}}",
      coalesceWindowSeconds: 10,
    },
  },
  projectId,
  workspaceStrategy: { type: "root" },
  // Never used: a wf-hook task dispatches to the engine, not to a thread.
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
  runtimeMode: "full-access",
  interactionMode: "default",
});

const sameTask = (
  existing: ScheduledTask,
  desired: ScheduledTaskUpsertInput,
  needsSecret: boolean,
): boolean => {
  if (existing.schedule.type !== "webhook" || desired.schedule.type !== "webhook") return false;
  const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  return (
    existing.title === desired.title &&
    existing.prompt === desired.prompt &&
    existing.enabled === desired.enabled &&
    existing.projectId === desired.projectId &&
    same(existing.schedule.signature, desired.schedule.signature) &&
    same(existing.schedule.filters ?? [], desired.schedule.filters ?? []) &&
    same(existing.schedule.dedupe, desired.schedule.dedupe) &&
    (!needsSecret || existing.webhook?.hasSecret === true)
  );
};

export interface ReconcilerOptions {
  /** `home.project` → the project the task belongs to (the core's `projectByRef`). */
  readonly resolveProject: (ref: string) => Effect.Effect<Option.Option<ProjectId>>;
  /** Where each trigger's HMAC secret is kept, `<baseDir>/workflows/secrets`. */
  readonly secretsDir: string;
}

export const makeReconciler = Effect.fn("WorkflowWebhooks.makeReconciler")(function* (
  options: ReconcilerOptions,
) {
  const tasks = yield* ScheduledTaskService.ScheduledTaskService;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const context = yield* Effect.context<SqlClient.SqlClient | Journal>();
  const listTriggerTargets = yield* makeTriggerTargets;

  /** The trigger's secret, created once so a recreated task keeps the same one. */
  const secretFor = Effect.fn("WorkflowWebhooks.secretFor")(function* (
    workflowId: string,
    triggerId: string,
  ) {
    const file = path.join(options.secretsDir, `${workflowId}.${triggerId}`);
    if (yield* fs.exists(file)) return (yield* fs.readFileString(file)).trim();
    yield* fs.makeDirectory(options.secretsDir, { recursive: true, mode: 0o700 });
    const secret = Buffer.from(yield* crypto.randomBytes(32)).toString("hex");
    yield* fs.writeFileString(file, `${secret}\n`, { mode: 0o600 });
    return secret;
  });

  const reconcileTarget = Effect.fnUntraced(function* (
    target: TriggerTarget,
    trigger: WebhookTrigger,
    existing: ScheduledTask | undefined,
  ) {
    const projectId = yield* options.resolveProject(target.home);
    if (Option.isNone(projectId)) {
      return yield* Effect.logWarning("workflow webhook: home project not found", {
        workflowId: target.workflowId,
        project: target.home,
      });
    }
    const desired = desiredTask(target, trigger, projectId.value);
    const needsSecret = trigger.signature !== undefined;
    if (existing !== undefined && sameTask(existing, desired, needsSecret)) return;
    const input: ScheduledTaskUpsertInput =
      needsSecret && desired.schedule.type === "webhook" && desired.schedule.signature
        ? {
            ...desired,
            schedule: {
              ...desired.schedule,
              signature: {
                ...desired.schedule.signature,
                secret: yield* secretFor(target.workflowId, trigger.id),
              },
            },
          }
        : desired;
    yield* asWorkflowEngine(tasks.upsert(input));
  });

  const reconcile = Effect.fn("WorkflowWebhooks.reconcile")(function* () {
    const targets = yield* listTriggerTargets.pipe(Effect.provideContext(context));
    const existing = new Map(
      (yield* tasks.list()).tasks
        .filter((task) => isWorkflowHookTaskId(task.id))
        .map((task) => [task.id as string, task] as const),
    );
    const wanted = new Set<string>();
    for (const target of targets) {
      const trigger = target.trigger;
      if (trigger.kind !== "webhook") continue;
      const id = workflowHookTaskId(target.workflowId, trigger.id);
      wanted.add(id);
      yield* reconcileTarget(target, trigger, existing.get(id)).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("workflow webhook reconcile failed", { taskId: id, cause }),
        ),
      );
    }
    for (const id of existing.keys()) {
      if (wanted.has(id)) continue;
      yield* asWorkflowEngine(tasks.delete({ id: ScheduledTaskId.make(id) })).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("workflow webhook delete failed", { taskId: id, cause }),
        ),
      );
    }
  });

  return { reconcile };
});

/** Reconciles on every definitions change and every 30 s (a task deleted elsewhere comes back). */
export const layerReconcile = (options: ReconcilerOptions) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const { reconcile } = yield* makeReconciler(options);
      const definitions = yield* WorkflowDefinitions.WorkflowDefinitions;
      const quiet = reconcile().pipe(
        Effect.catchCause((cause) => Effect.logWarning("workflow webhook reconcile failed", cause)),
      );
      yield* forkParked(quiet.pipe(Effect.repeat(Schedule.spaced("30 seconds"))));
      yield* forkParked(definitions.changes.pipe(Stream.runForEach(() => quiet)));
    }),
  );

/** The reconciler as the bots host runs it: projects resolved as the interpreter resolves them. */
export const layerReconcileOnHost = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const path = yield* Path.Path;
    const projects = yield* ProjectService;
    return layerReconcile({
      secretsDir: path.join(config.baseDir, "workflows", "secrets"),
      resolveProject: (ref) =>
        projects.snapshot.pipe(
          Effect.map((snapshot) =>
            Option.fromUndefinedOr(projectByRef(snapshot.projects, ref)?.id),
          ),
          Effect.orElseSucceed(() => Option.none()),
        ),
    });
  }),
);
