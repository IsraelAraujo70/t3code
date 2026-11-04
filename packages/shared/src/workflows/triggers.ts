/** Triggers (friend fork): the helpers the server, the canvas and Android share. Design §5. */
import {
  WORKFLOW_ON_DEMAND_TRIGGER_KINDS,
  type WorkflowTrigger,
  type WorkflowTriggerParts,
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
/** The trigger's definition as the summary's structured parts; clients word triggers from it. */
export const triggerParts = (trigger: WorkflowTrigger): WorkflowTriggerParts => {
  switch (trigger.kind) {
    case "cron":
      return { cron: { expr: trigger.expr, tz: trigger.tz } };
    case "webhook":
      return { webhook: { filters: trigger.filters?.length ?? 0 } };
    case "upstreamTag":
      return { upstreamTag: { remote: trigger.remote, pattern: trigger.pattern } };
    case "prMerged":
      return { prMerged: { repo: trigger.repo } };
    case "workflowFailed":
      return { workflowFailed: { workflow: trigger.workflow ?? null } };
    case "bot":
      return { bot: { bots: trigger.bots ?? null } };
    case "call":
      return { call: { from: trigger.from ?? null } };
    case "threadSettled":
    case "manual":
      return {};
  }
};
/** A run param's value: `string[]` params decode to a list of strings. */
type RunParamValue = string | number | boolean | ReadonlyArray<string>;
export type DecodeRunParamsResult =
  | { readonly ok: true; readonly params: Readonly<Record<string, RunParamValue>> }
  | {
      readonly ok: false;
      readonly errors: ReadonlyArray<{ readonly param: string; readonly message: string }>;
    };
/** Why one value does not fit its declaration, or null. */
const paramError = (name: string, spec: WorkflowParamSpec, value: unknown): string | null => {
  if (spec.type === "string[]") {
    if (!Array.isArray(value) || !value.every((v) => typeof v === "string"))
      return `${name}: expected a list of strings`;
    if (spec.maxItems !== undefined && value.length > spec.maxItems)
      return `${name} has ${value.length} items; at most ${spec.maxItems}`;
    const bad =
      spec.pattern === undefined
        ? undefined
        : value.find((v: string) => !matchesWhole(spec.pattern!, v));
    return bad === undefined ? null : `${name}: "${bad}" does not match ${spec.pattern}`;
  }
  if (typeof value !== spec.type) return `${name}: expected ${spec.type}`;
  if (typeof value === "string" && spec.pattern !== undefined && !matchesWhole(spec.pattern, value))
    return `${name} does not match ${spec.pattern}`;
  return null;
};
/**
 * The params a run starts with: each declared param from `input` or its default, typed as
 * declared, string patterns matched whole (every element of a `string[]`, which also respects
 * `maxItems`); an undeclared key is an error. The decider and every caller that refuses early
 * (RPC, MCP) use this one function.
 */
export const decodeRunParams = (
  declarations: Readonly<Record<string, WorkflowParamSpec>> | undefined,
  input: Readonly<Record<string, unknown>>,
): DecodeRunParamsResult => {
  const specs = declarations ?? {};
  const errors: Array<{ param: string; message: string }> = [];
  const params: Record<string, RunParamValue> = {};
  for (const name of Object.keys(input))
    if (!Object.hasOwn(specs, name))
      errors.push({ param: name, message: `${name} is not a declared param` });
  for (const [name, spec] of Object.entries(specs)) {
    const value = Object.hasOwn(input, name) ? input[name] : spec.default;
    if (value === undefined) {
      errors.push({ param: name, message: `${name} is required` });
      continue;
    }
    const error = paramError(name, spec, value);
    if (error !== null) {
      errors.push({ param: name, message: error });
      continue;
    }
    params[name] = value as RunParamValue;
  }
  return errors.length ? { ok: false, errors } : { ok: true, params };
};
