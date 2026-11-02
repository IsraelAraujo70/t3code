import type { WorkflowDocument } from "@t3tools/contracts";

export interface SourceTabProps {
  readonly document: WorkflowDocument;
  readonly hasDraft: boolean;
  readonly saving: boolean;
  readonly onSave: (source: string, message: string) => void;
}

/** Placeholder replaced by the source editor leaf at integration. */
export function SourceTab(props: SourceTabProps) {
  return <pre>{props.document.source}</pre>;
}
