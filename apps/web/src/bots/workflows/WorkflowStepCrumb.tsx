import { WorkflowRunId, parseWorkflowStepThreadId, type EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import * as Schema from "effect/Schema";

import {
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbText,
} from "../../components/WorkspaceBreadcrumb";

const isRunId = Schema.is(WorkflowRunId);

/** A step thread's way back to its run; the run id is in the thread id, so no server call. */
export function WorkflowStepCrumb(props: { environmentId: EnvironmentId; threadId: string }) {
  const parsed = parseWorkflowStepThreadId(props.threadId);
  if (parsed === null || !isRunId(parsed.runId)) return null;
  return (
    <WorkspaceBreadcrumbItem className="shrink">
      <Link
        to="/workflows/$environmentId/runs/$runId"
        params={{ environmentId: props.environmentId, runId: parsed.runId }}
        className="text-muted-foreground hover:text-foreground"
      >
        <WorkspaceBreadcrumbText>Workflow run</WorkspaceBreadcrumbText>
      </Link>
    </WorkspaceBreadcrumbItem>
  );
}
