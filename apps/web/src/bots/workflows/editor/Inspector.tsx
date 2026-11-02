import type { WorkflowDefinition, WorkflowDiagnostic } from "@t3tools/contracts";

export interface InspectorProps {
  readonly definition: WorkflowDefinition;
  readonly selected: string | null;
  readonly diagnostics: ReadonlyArray<WorkflowDiagnostic>;
  readonly readOnly: boolean;
  readonly onChange: (definition: WorkflowDefinition) => void;
  readonly onSelect: (id: string | null) => void;
}

/** Placeholder replaced by the inspector leaf at integration. */
export function Inspector(props: InspectorProps) {
  return <p>{props.selected ?? props.definition.title}</p>;
}
