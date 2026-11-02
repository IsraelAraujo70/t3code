import { EnvironmentId, WorkflowId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { WorkflowEditorPage } from "../bots/workflows/editor/WorkflowEditorPage";
import { WorkflowsNotice, WorkflowsPageFrame } from "../bots/workflows/WorkflowsPageFrame";

const decodeWorkflowId = Schema.decodeUnknownOption(WorkflowId);

export const Route = createFileRoute("/_chat/workflows/$environmentId/$workflowId")({
  component: function WorkflowEditorRoute() {
    const params = Route.useParams();
    const workflowId = Option.getOrNull(decodeWorkflowId(params.workflowId));
    if (workflowId === null) {
      return (
        <WorkflowsPageFrame title="Workflow">
          <WorkflowsNotice>No workflow is named {params.workflowId}.</WorkflowsNotice>
        </WorkflowsPageFrame>
      );
    }
    return (
      <WorkflowEditorPage
        key={workflowId}
        environmentId={EnvironmentId.make(params.environmentId)}
        workflowId={workflowId}
      />
    );
  },
});
