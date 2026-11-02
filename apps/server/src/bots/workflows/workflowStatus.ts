/** A workflow's switch and fatigue state, folded from its `workflow:<id>` stream. */
import type { StoredFact } from "./facts.ts";

export interface WorkflowStatus {
  /** Off until the first Toggled: a saved workflow never runs before someone turns it on. */
  readonly enabled: boolean;
  /** Fatigue suspended it; only an Unsuspended lifts it. */
  readonly suspended: boolean;
  /** Seq of the latest Toggled (0 before any), so an action can key itself to one activation. */
  readonly toggledSeq: number;
  /** Triggers whose latest TriggerToggled turned them off; a trigger without one is on. */
  readonly off: ReadonlySet<string>;
}

export const workflowStatus = (facts: ReadonlyArray<StoredFact>): WorkflowStatus => {
  let enabled = false;
  let suspended = false;
  let toggledSeq = 0;
  const off = new Set<string>();
  for (const { fact, seq } of facts) {
    if (fact._tag === "Toggled") {
      enabled = fact.enabled;
      toggledSeq = seq;
    }
    if (fact._tag === "TriggerToggled") {
      if (fact.enabled) off.delete(fact.triggerId);
      else off.add(fact.triggerId);
    }
    if (fact._tag === "Suspended") suspended = true;
    if (fact._tag === "Unsuspended") suspended = false;
  }
  return { enabled, suspended, toggledSeq, off };
};
