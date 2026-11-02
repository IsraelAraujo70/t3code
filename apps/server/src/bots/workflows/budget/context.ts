/**
 * The `BudgetContext` the engine hands `decide` (§9.1): reservations learned from earlier runs and
 * the host's workflow day, summed over every run. Pure; the engine folds the runs it reads.
 */
import type { WorkflowNode } from "@t3tools/contracts";
import type { CompiledWorkflow } from "@t3tools/shared/workflows";

import type { RunState } from "../state.ts";
import {
  type BudgetContext,
  chargedBetween,
  chargeOf,
  DEFAULT_TURN_RESERVATION,
  workflowDay,
} from "./budget.ts";

const nodeIdOf = (step: string): string => (step.split("/").at(-1) ?? step).replace(/\[\d+\]$/, "");

export interface BudgetContextInput {
  readonly now: number;
  readonly timeZone: string;
  readonly dayStartsAtHour: number;
  /** `HostLimits.workflowTokensPerDay`. */
  readonly cap: number;
  /** Every run that may have charged in the current workflow day, of any workflow. */
  readonly runs: ReadonlyArray<RunState>;
  /** Earlier runs of this workflow; their settled turns teach each node's reservation. */
  readonly history: ReadonlyArray<RunState>;
}

/** Mean billable of a node's settled turns in `history`, else `DEFAULT_TURN_RESERVATION`. */
export const nodeEstimates = (history: ReadonlyArray<RunState>): ((nodeId: string) => number) => {
  const totals = new Map<string, { sum: number; count: number }>();
  for (const state of history) {
    for (const entry of state.intents.values()) {
      if (entry.intent._tag !== "StartTurn" || entry.intent.key.startsWith("nudge:")) continue;
      const charge = chargeOf(state, entry);
      if (charge === null || charge === 0) continue;
      const id = nodeIdOf(entry.intent.step);
      const total = totals.get(id) ?? { sum: 0, count: 0 };
      totals.set(id, { sum: total.sum + charge, count: total.count + 1 });
    }
  }
  return (nodeId) => {
    const total = totals.get(nodeId);
    return total === undefined ? DEFAULT_TURN_RESERVATION : Math.ceil(total.sum / total.count);
  };
};

export const budgetContext = (input: BudgetContextInput): BudgetContext => {
  const day = workflowDay(input.now, input.timeZone, input.dayStartsAtHour);
  return {
    estimate: nodeEstimates(input.history),
    day: {
      spent: input.runs.reduce((sum, state) => sum + chargedBetween(state, day.start, day.end), 0),
      cap: input.cap,
      endsAt: day.end,
    },
  };
};

/** The workflows a definition's `call` nodes start, at any depth of map and loop bodies. */
export const calledWorkflowsOf = (compiled: CompiledWorkflow): ReadonlyArray<string> => {
  const ids = new Set<string>();
  const visit = (nodes: { readonly [id: string]: WorkflowNode }) => {
    for (const node of Object.values(nodes)) {
      if (node.kind === "call") ids.add(node.workflow);
      if (node.kind === "map" || node.kind === "loop") visit(node.body.nodes);
    }
  };
  visit(compiled.definition.nodes);
  return [...ids].sort();
};
