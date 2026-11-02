import type { WorkflowTrigger } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { WorkflowDefinition } from "@t3tools/contracts";
import { listIndex, getVersion } from "../definitions/definitionsStore.ts";
import { Journal } from "../Journal.ts";
import { workflowStream } from "../facts.ts";
import { workflowStatus } from "../workflowStatus.ts";

const decodeDefinition = Schema.decodeEffect(Schema.fromJsonString(WorkflowDefinition));

export interface TriggerTarget {
  readonly workflowId: string;
  readonly enabled: boolean;
  /** The workflow's `home.project` reference, as the definition names it. */
  readonly home: string;
  readonly trigger: WorkflowTrigger;
}
export const listTriggerTargets = Effect.gen(function* () {
  const journal = yield* Journal;
  const targets: TriggerTarget[] = [];
  for (const row of yield* listIndex()) {
    if (!row.head_commit) continue;
    const version = yield* getVersion(row.workflow_id, row.head_commit);
    if (!version) continue;
    const definition = yield* decodeDefinition(version.definition_json);
    const status = workflowStatus(yield* journal.read(workflowStream(row.workflow_id)));
    for (const trigger of definition.triggers ?? [])
      targets.push({
        workflowId: row.workflow_id,
        enabled: status.enabled,
        home: definition.home.project,
        trigger,
      });
  }
  return targets;
});
