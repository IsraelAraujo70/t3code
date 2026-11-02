import {
  WORKFLOW_ON_DEMAND_TRIGGER_KINDS,
  type WorkflowTrigger,
  type WorkflowParamSpec,
} from "@t3tools/contracts";
import { matchesWhole } from "./output.ts";
/** `manual`, `bot` and `call`: the caller passes the params, and the trigger has no `params` map. */
export const isOnDemandTrigger = (kind: string): boolean =>
  WORKFLOW_ON_DEMAND_TRIGGER_KINDS.some((value) => value === kind);
/** One line about the trigger. */
export const triggerLabel = (trigger: WorkflowTrigger): string => {
  switch (trigger.kind) {
    case "cron":
      return `${trigger.expr} (${trigger.tz})`;
    case "webhook":
      return trigger.filters?.length
        ? `webhook · ${trigger.filters.length} filter${trigger.filters.length === 1 ? "" : "s"}`
        : "webhook";
    case "upstreamTag":
      return `tag ${trigger.pattern} on ${trigger.remote}`;
    case "prMerged":
      return `PR merged in ${trigger.repo}`;
    case "threadSettled":
      return "thread settled";
    case "workflowFailed":
      return `${trigger.workflow ?? "any"} failed`;
    case "manual":
      return "Run now";
    case "bot":
      return trigger.bots === undefined
        ? "bot · any bot"
        : `bot · ${trigger.bots.length} bot${trigger.bots.length === 1 ? "" : "s"}`;
    case "call":
      return trigger.from === undefined
        ? "called by any workflow"
        : `called by ${trigger.from.join(", ")}`;
  }
};
export type DecodeRunParamsResult =
  | { readonly ok: true; readonly params: Readonly<Record<string, string | number | boolean>> }
  | {
      readonly ok: false;
      readonly errors: ReadonlyArray<{ readonly param: string; readonly message: string }>;
    };
/**
 * The params a run starts with: each declared param from `input` or its default, typed as
 * declared, string patterns matched whole; an undeclared key is an error. The decider and every
 * caller that refuses early (RPC, MCP) use this one function.
 */
export const decodeRunParams = (
  declarations: Readonly<Record<string, WorkflowParamSpec>> | undefined,
  input: Readonly<Record<string, unknown>>,
): DecodeRunParamsResult => {
  const specs = declarations ?? {};
  const errors: Array<{ param: string; message: string }> = [];
  const params: Record<string, string | number | boolean> = {};
  for (const name of Object.keys(input))
    if (!Object.hasOwn(specs, name))
      errors.push({ param: name, message: `${name} is not a declared param` });
  for (const [name, spec] of Object.entries(specs)) {
    const value = Object.hasOwn(input, name) ? input[name] : spec.default;
    if (value === undefined) {
      errors.push({ param: name, message: `${name} is required` });
      continue;
    }
    if (
      (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") ||
      typeof value !== spec.type
    ) {
      errors.push({ param: name, message: `${name}: expected ${spec.type}` });
      continue;
    }
    if (
      typeof value === "string" &&
      spec.pattern !== undefined &&
      !matchesWhole(spec.pattern, value)
    )
      errors.push({ param: name, message: `${name} does not match ${spec.pattern}` });
    params[name] = value;
  }
  return errors.length ? { ok: false, errors } : { ok: true, params };
};
