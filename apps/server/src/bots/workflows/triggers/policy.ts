/**
 * Who may start a run through which trigger (design §5). The workflow decider is the authority;
 * the RPC and MCP handlers call the same function first, to refuse with a clear message.
 */
import type { WorkflowSkipReason, WorkflowTrigger } from "@t3tools/contracts";
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
  const exact = triggers?.[triggerId];
  if (exact) return { ...exact, id: triggerId };
  if (!isOnDemandTrigger(firedKind)) return undefined;
  const matches = Object.entries(triggers ?? {}).filter(([, value]) => value.kind === firedKind);
  const match = matches.length === 1 ? matches[0] : undefined;
  return match ? { ...match[1], id: match[0] } : undefined;
};
