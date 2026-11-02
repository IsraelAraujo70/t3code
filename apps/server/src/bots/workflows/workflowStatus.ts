/** A workflow's switch and fatigue state, folded from its `workflow:<id>` stream. */
import type { StoredFact } from "./facts.ts";

export interface WorkflowStatus {
  /** Off until the first Toggled: a saved workflow never runs before someone turns it on. */
  readonly enabled: boolean;
  /** Fatigue suspended it; only an Unsuspended lifts it. */
  readonly suspended: boolean;
}

export const workflowStatus = (facts: ReadonlyArray<StoredFact>): WorkflowStatus => {
  let enabled = false;
  let suspended = false;
  for (const { fact } of facts) {
    if (fact._tag === "Toggled") enabled = fact.enabled;
    if (fact._tag === "Suspended") suspended = true;
    if (fact._tag === "Unsuspended") suspended = false;
  }
  return { enabled, suspended };
};
