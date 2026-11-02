/**
 * The seam between scheduled tasks and workflows. A webhook trigger is a scheduled task with id
 * `wf-hook:<workflowId>:<triggerId>`; its deliveries go to `WorkflowTriggerHook.fire`, never to a
 * thread launch, and only the engine (inside `asWorkflowEngine`) may change or delete the task.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { WebhookRequest } from "../../../scheduledTasks/webhookTemplate.ts";

export const WORKFLOW_HOOK_TASK_PREFIX = "wf-hook:";

export const isWorkflowHookTaskId = (taskId: string): boolean =>
  taskId.startsWith(WORKFLOW_HOOK_TASK_PREFIX);

export const workflowHookTaskId = (workflowId: string, triggerId: string): string =>
  `${WORKFLOW_HOOK_TASK_PREFIX}${workflowId}:${triggerId}`;

export class WorkflowTriggerHookError extends Schema.TaggedError<WorkflowTriggerHookError>()(
  "WorkflowTriggerHookError",
  { taskId: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return "The workflow engine could not accept this webhook delivery.";
  }
}

export class WorkflowTriggerHook extends Context.Service<
  WorkflowTriggerHook,
  {
    /**
     * Records the structured request and rendered prompt as the trigger's TriggerFired (occurrence `webhook:<deliveryId>`).
     * Idempotent by deliveryId: a delivery replayed after a crash fires once.
     */
    readonly fire: (input: {
      readonly taskId: string;
      readonly deliveryId: string;
      readonly prompt: string;
      readonly request: WebhookRequest;
    }) => Effect.Effect<void, WorkflowTriggerHookError>;
  }
>()("t3/bots/workflows/triggers/hook/WorkflowTriggerHook") {}

/** True only inside the engine's own calls; scheduled tasks refuse `wf-hook:` changes otherwise. */
export class WorkflowEngineCaller extends Context.Reference<boolean>(
  "t3/bots/workflows/triggers/hook/WorkflowEngineCaller",
  { defaultValue: () => false },
) {}

/** Runs `effect` as the workflow engine, allowed to manage `wf-hook:` tasks. */
export const asWorkflowEngine = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.provideService(effect, WorkflowEngineCaller, true);
