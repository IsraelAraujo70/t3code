import type { WorkflowTrigger } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { WorkflowDefinition } from "@t3tools/contracts";
import { listIndex, getVersion } from "../definitions/definitionsStore.ts";
import { Journal } from "../Journal.ts";

const decodeDefinition = Schema.decodeEffect(Schema.fromJsonString(WorkflowDefinition));

export interface TriggerTarget {
  readonly workflowId: string;
  /** The workflow switch and the trigger's own switch. */
  readonly enabled: boolean;
  /** The workflow's `home.project` reference, as the definition names it. */
  readonly home: string;
  readonly trigger: WorkflowTrigger & { readonly id: string };
}

/**
 * A lister of every indexed workflow's HEAD triggers with its switch. It decodes a definition once
 * per head commit (a stored version never changes) and reads the switch on every call.
 */
export const makeTriggerTargets = Effect.sync(() => {
  const heads = new Map<
    string,
    {
      readonly commit: string;
      readonly home: string;
      readonly triggers: ReadonlyArray<WorkflowTrigger & { readonly id: string }>;
    }
  >();
  return Effect.gen(function* () {
    const journal = yield* Journal;
    const rows = yield* listIndex();
    const indexed = new Set(rows.map((row) => row.workflow_id));
    for (const id of heads.keys()) if (!indexed.has(id)) heads.delete(id);
    const targets: TriggerTarget[] = [];
    for (const row of rows) {
      if (!row.head_commit) continue;
      let head = heads.get(row.workflow_id);
      if (head?.commit !== row.head_commit) {
        const version = yield* getVersion(row.workflow_id, row.head_commit);
        if (!version) continue;
        const definition = yield* decodeDefinition(version.definition_json);
        head = {
          commit: row.head_commit,
          home: definition.home.project,
          triggers: Object.entries(definition.triggers ?? {}).map(([id, trigger]) => ({
            ...trigger,
            id,
          })),
        };
        heads.set(row.workflow_id, head);
      }
      if (head.triggers.length === 0) continue;
      const status = yield* journal.workflowStatus(row.workflow_id);
      for (const trigger of head.triggers)
        targets.push({
          workflowId: row.workflow_id,
          enabled: status.enabled && !status.off.has(trigger.id),
          home: head.home,
          trigger,
        });
    }
    return targets;
  });
});
