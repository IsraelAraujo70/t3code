import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type { Json } from "effect/Schema";
import { parseTemplate, evalTemplateValue } from "@t3tools/shared/workflows";
import type { WorkflowEngine, TriggerRequest } from "../WorkflowEngine.ts";
import type { TriggerTarget } from "./targets.ts";

export const fireTrigger = Effect.fn("WorkflowTriggers.fireTrigger")(function* (
  engine: Pick<WorkflowEngine["Service"], "start">,
  target: TriggerTarget,
  occurrence: Pick<TriggerRequest, "kind" | "occurrence" | "label" | "payload">,
  causalDepth = 0,
) {
  const params: Record<string, Json> = {};
  const payload = occurrence.payload;
  const trigger = {
    ...(typeof payload === "object" && payload !== null && !Array.isArray(payload) ? payload : {}),
    kind: occurrence.kind,
    label: occurrence.label,
  };
  for (const [name, template] of Object.entries(target.trigger.params ?? {})) {
    const parsed = parseTemplate(template);
    if (Result.isFailure(parsed)) continue;
    const value = evalTemplateValue(parsed.success, { roots: { trigger } });
    if (Result.isSuccess(value)) params[name] = value.success;
  }
  return yield* engine.start({
    ...occurrence,
    workflowId: target.workflowId,
    triggerId: target.trigger.id,
    params,
    causalDepth,
    parent: null,
  });
});
