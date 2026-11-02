import { EnvironmentId, WorkflowRunId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { WorkflowRunPage } from "../bots/workflows/run/WorkflowRunPage";
import { WorkflowsNotice, WorkflowsPageFrame } from "../bots/workflows/WorkflowsPageFrame";

const decodeRunId = Schema.decodeUnknownOption(WorkflowRunId);

export const Route = createFileRoute("/_chat/workflows/$environmentId/runs/$runId")({
  component: function WorkflowRunRoute() {
    const params = Route.useParams();
    const runId = Option.getOrNull(decodeRunId(params.runId));
    if (runId === null) {
      return (
        <WorkflowsPageFrame title="Workflow run">
          <WorkflowsNotice>No run is named {params.runId}.</WorkflowsNotice>
        </WorkflowsPageFrame>
      );
    }
    return (
      <WorkflowRunPage
        key={runId}
        environmentId={EnvironmentId.make(params.environmentId)}
        runId={runId}
      />
    );
  },
});
