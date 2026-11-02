import type { EnvironmentId } from "@t3tools/contracts";

import { WorkflowsNotice, WorkflowsPageFrame } from "../WorkflowsPageFrame";

export function WorkflowLedgerPage(_props: { environmentId: EnvironmentId }) {
  return (
    <WorkflowsPageFrame title="Ledger">
      <WorkflowsNotice>Loading…</WorkflowsNotice>
    </WorkflowsPageFrame>
  );
}
