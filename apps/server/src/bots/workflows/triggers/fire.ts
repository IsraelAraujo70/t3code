import * as Effect from "effect/Effect";
import type { Json } from "effect/Schema";
import { triggerParams } from "@t3tools/shared/workflows";
import type { WorkflowEngine, TriggerRequest } from "../WorkflowEngine.ts";
import type { TriggerTarget } from "./targets.ts";

export const fireTrigger = Effect.fn("WorkflowTriggers.fireTrigger")(function* (
  engine: Pick<WorkflowEngine["Service"], "start">,
  target: TriggerTarget,
  occurrence: Pick<TriggerRequest, "kind" | "occurrence" | "label" | "payload">,
  causalDepth = 0,
) {
  const payload = occurrence.payload;
  const trigger = {
    ...(typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as Readonly<Record<string, Json>>)
      : {}),
    kind: occurrence.kind,
    label: occurrence.label,
  };
  const params = triggerParams(target.trigger.params, trigger);
  return yield* engine.start({
    ...occurrence,
    workflowId: target.workflowId,
    triggerId: target.trigger.id,
    params,
    causalDepth,
    parent: null,
  });
});
