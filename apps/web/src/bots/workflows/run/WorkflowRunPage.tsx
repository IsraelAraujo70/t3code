import type { EnvironmentId, WorkflowRunId } from "@t3tools/contracts";

import { useWorkflowRun } from "../state";
import { WorkflowsNotice, WorkflowsPageFrame } from "../WorkflowsPageFrame";

export function WorkflowRunPage(props: { environmentId: EnvironmentId; runId: WorkflowRunId }) {
  const run = useWorkflowRun(props.environmentId, props.runId);
  return (
    <WorkflowsPageFrame title={run.data?.summary.title ?? "Workflow run"}>
      <WorkflowsNotice>{run.error ?? "Loading…"}</WorkflowsNotice>
    </WorkflowsPageFrame>
  );
}
