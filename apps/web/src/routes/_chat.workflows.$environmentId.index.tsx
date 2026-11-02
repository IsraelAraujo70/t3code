import { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { WorkflowsPage } from "../bots/workflows/WorkflowsPage";

export const Route = createFileRoute("/_chat/workflows/$environmentId/")({
  component: function WorkflowsRoute() {
    const { environmentId } = Route.useParams();
    return <WorkflowsPage environmentId={EnvironmentId.make(environmentId)} />;
  },
});
