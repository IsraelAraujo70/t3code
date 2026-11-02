import * as Schema from "effect/Schema";
import { WorkflowRunId, parseWorkflowStepThreadId, type EnvironmentId } from "@t3tools/contracts";
import { workflowRunHref } from "@t3tools/client-runtime/workflows";
import {
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbText,
} from "../../components/WorkspaceBreadcrumb";
const isRunId = Schema.is(WorkflowRunId);

/** A local backlink derived from a workflow step thread's encoded run id. */
export function WorkflowStepCrumb(props: { environmentId: EnvironmentId; threadId: string }) {
  const parsed = parseWorkflowStepThreadId(props.threadId);
  if (!parsed || !isRunId(parsed.runId)) return null;
  return (
    <WorkspaceBreadcrumbItem>
      <a href={workflowRunHref(props.environmentId, parsed.runId)}>
        <WorkspaceBreadcrumbText>Workflow run</WorkspaceBreadcrumbText>
      </a>
    </WorkspaceBreadcrumbItem>
  );
}
