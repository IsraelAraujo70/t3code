import type { EnvironmentId } from "@t3tools/contracts";
import { WorkflowsPageFrame } from "../WorkflowsPageFrame";
import { WorkflowLedgerPanel } from "./WorkflowLedgerPanel";
/** Environment-wide experiment ledger. */
export function WorkflowLedgerPage(props: { environmentId: EnvironmentId }) {
  return (
    <WorkflowsPageFrame title="Workflow ledger">
      <div className="p-6">
        <WorkflowLedgerPanel environmentId={props.environmentId} />
      </div>
    </WorkflowsPageFrame>
  );
}
