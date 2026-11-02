import type { EnvironmentId, WorkflowId } from "@t3tools/contracts";

import { WorkflowsNotice, WorkflowsPageFrame } from "../WorkflowsPageFrame";

export function WorkflowEditorPage(props: {
  environmentId: EnvironmentId;
  workflowId: WorkflowId;
}) {
  return (
    <WorkflowsPageFrame title={props.workflowId}>
      <WorkflowsNotice>Loading…</WorkflowsNotice>
    </WorkflowsPageFrame>
  );
}
