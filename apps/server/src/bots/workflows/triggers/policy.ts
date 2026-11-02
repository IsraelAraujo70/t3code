/**
 * Who may start a run through which trigger (design §5). The workflow decider is the authority;
 * the RPC and MCP handlers call the same function first, to refuse with a clear message.
 */
import type { WorkflowSkipReason, WorkflowTrigger } from "@t3tools/contracts";
import type { Json } from "effect/Schema";
import { isOnDemandTrigger } from "@t3tools/shared/workflows";
import type { WorkflowStatus } from "../workflowStatus.ts";

/** Who asked, read from the occurrence prefix that only server code writes. */
export type TriggerOrigin = "owner" | "bot" | "workflow" | "event";

/** manual/test are owner fires; bot is a bot; child/run-failed are workflows. */
export const originOf = (occurrence: string): TriggerOrigin => {
  const prefix = occurrence.split(":")[0];
  if (prefix === "manual" || prefix === "test") return "owner";
  if (prefix === "bot") return "bot";
  if (prefix === "child" || prefix === "run-failed") return "workflow";
  return "event";
};

export interface TriggerBlockInput {
  readonly trigger: (WorkflowTrigger & { readonly id: string }) | undefined;
  readonly firedKind: string;
  readonly origin: TriggerOrigin;
  readonly status: Pick<WorkflowStatus, "enabled" | "suspended" | "off">;
  readonly caller: string | null;
}

/**
 * First match decides:
 * 1. missing/mismatched trigger → invalid; 2. caller outside bots/from → invalid;
 * 3. suspended → suspended; 4. owner → allowed; 5. workflow off → disabled;
 * 6. trigger off → disabled; 7. otherwise allowed.
 */
export const triggerBlock = ({
  trigger,
  firedKind,
  origin,
  status,
  caller,
}: TriggerBlockInput): WorkflowSkipReason | null => {
  if (!trigger || trigger.kind !== firedKind) return "invalid";
  const allowed =
    trigger.kind === "bot" ? trigger.bots : trigger.kind === "call" ? trigger.from : undefined;
  if (allowed && (caller === null || !allowed.includes(caller))) return "invalid";
  if (status.suspended) return "suspended";
  if (origin === "owner") return null;
  if (!status.enabled || status.off.has(trigger.id)) return "disabled";
  return null;
};

/** Resolve by id, falling back to the sole on-demand trigger of the fired kind. */
export const resolveTrigger = (
  triggers: Readonly<Record<string, WorkflowTrigger>> | undefined,
  triggerId: string,
  firedKind: string,
): (WorkflowTrigger & { readonly id: string }) | undefined => {
  const exact = triggers && Object.hasOwn(triggers, triggerId) ? triggers[triggerId] : undefined;
  // A child run names its trigger "call", which can also be the id of another kind's trigger.
  if (exact && (exact.kind === firedKind || !isOnDemandTrigger(firedKind)))
    return { ...exact, id: triggerId };
  if (!isOnDemandTrigger(firedKind)) return undefined;
  const matches = Object.entries(triggers ?? {}).filter(([, value]) => value.kind === firedKind);
  const match = matches.length === 1 ? matches[0] : undefined;
  return match ? { ...match[1], id: match[0] } : undefined;
};

const isRecord = (value: Json | undefined): value is { readonly [key: string]: Json } =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const field = (value: Json | undefined, key: string): Json | undefined =>
  isRecord(value) && Object.hasOwn(value, key) ? value[key] : undefined;

/** The caller a server-written payload names: `bot.id` for a bot fire, `parent.workflowId` for a call. */
export const callerOf = (kind: string, payload: Json): string | null => {
  const id =
    kind === "bot"
      ? field(field(payload, "bot"), "id")
      : kind === "call"
        ? field(field(payload, "parent"), "workflowId")
        : undefined;
  return typeof id === "string" ? id : null;
};
