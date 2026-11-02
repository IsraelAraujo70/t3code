import type { WorkflowTrigger } from "@t3tools/contracts";
import { InspectorField, type InspectorFieldSpec } from "./NodeConfigForms";
import { fieldValue, type EditFormat } from "./inspectorEdits";

const fields: Record<WorkflowTrigger["kind"], readonly InspectorFieldSpec[]> = {
  manual: [],
  bot: [
    { path: "description", multiline: true },
    { path: "bots", format: "json" },
  ],
  call: [{ path: "from", format: "json" }],
  webhook: [
    { path: "replayKey" },
    { path: "template", multiline: true },
    { path: "signature", format: "json" },
    { path: "filters", format: "json" },
  ],
  cron: [{ path: "expr" }, { path: "tz" }, { path: "misfire", format: "json" }],
  upstreamTag: [{ path: "remote" }, { path: "pattern" }, { path: "pollMinutes", format: "number" }],
  prMerged: [{ path: "scope", choices: ["linked", "repo"] }, { path: "repo" }, { path: "base" }],
  threadSettled: [{ path: "projectId" }, { path: "botId" }, { path: "titlePrefix" }],
  workflowFailed: [{ path: "workflow" }],
};

/** Renders the configuration fields for one trigger kind. */
export function TriggerConfigForms(props: {
  id: string;
  trigger: WorkflowTrigger;
  readOnly: boolean;
  onEdit: (path: string, text: string, format: EditFormat) => string | null;
}) {
  const specs: readonly InspectorFieldSpec[] = [
    { path: "title" },
    ...fields[props.trigger.kind],
    ...(["manual", "bot", "call"].includes(props.trigger.kind)
      ? []
      : [{ path: "params", format: "json" } satisfies InspectorFieldSpec]),
  ];
  return specs.map((spec) => (
    <InspectorField
      key={`${props.id}:${spec.path}`}
      spec={spec}
      value={fieldValue(props.trigger, spec.path)}
      readOnly={props.readOnly}
      onEdit={props.onEdit}
    />
  ));
}
