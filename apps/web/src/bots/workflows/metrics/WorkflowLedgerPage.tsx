import type { EnvironmentId } from "@t3tools/contracts";

import { WorkflowsBreadcrumb, WorkflowsPageFrame } from "../WorkflowsPageFrame";
import { WorkflowLedgerPanel } from "./WorkflowLedgerPanel";

/** Environment-wide experiment ledger. */
export function WorkflowLedgerPage(props: { environmentId: EnvironmentId }) {
  return (
    <WorkflowsPageFrame
      title={<WorkflowsBreadcrumb environmentId={props.environmentId}>Ledger</WorkflowsBreadcrumb>}
    >
      <div className="px-(--workspace-gutter-start) pt-1 pb-10 pr-(--workspace-gutter-end)">
        <WorkflowLedgerPanel environmentId={props.environmentId} />
      </div>
    </WorkflowsPageFrame>
  );
}
