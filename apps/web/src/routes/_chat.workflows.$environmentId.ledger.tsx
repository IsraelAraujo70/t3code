import { EnvironmentId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";

import { WorkflowLedgerPage } from "../bots/workflows/metrics/WorkflowLedgerPage";

export const Route = createFileRoute("/_chat/workflows/$environmentId/ledger")({
  component: function WorkflowLedgerRoute() {
    const { environmentId } = Route.useParams();
    return <WorkflowLedgerPage environmentId={EnvironmentId.make(environmentId)} />;
  },
});
