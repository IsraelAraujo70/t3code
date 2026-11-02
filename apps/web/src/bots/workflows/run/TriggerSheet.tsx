import type { EnvironmentId, WorkflowRunId, WorkflowRunView } from "@t3tools/contracts";
import { useEnvironmentQuery } from "../../../state/query";
import { workflowsEnvironment } from "../state";
import { Button } from "../../../components/ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogPanel,
  DialogFooter,
} from "../../../components/ui/dialog";

/** Reads the run payload only while its trigger details are open. */
export function TriggerSheet(props: {
  environmentId: EnvironmentId;
  runId: WorkflowRunId;
  trigger: WorkflowRunView["trigger"];
  onClose: () => void;
}) {
  const query = useEnvironmentQuery(
    workflowsEnvironment.runTrigger({
      environmentId: props.environmentId,
      input: { runId: props.runId },
    }),
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>{props.trigger.label}</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <dl>
            <dt>ID</dt>
            <dd>{props.trigger.id}</dd>
            <dt>Kind</dt>
            <dd>{props.trigger.kind}</dd>
            <dt>Occurrence</dt>
            <dd>{props.trigger.occurrence}</dd>
            <dt>Payload size</dt>
            <dd>{props.trigger.payloadBytes} bytes</dd>
          </dl>
          {query.error ? (
            <p role="alert">{query.error}</p>
          ) : query.data ? (
            <>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words">
                {query.data.payload === null
                  ? "No payload"
                  : JSON.stringify(query.data.payload, null, 2)}
              </pre>
              {query.data.truncated ? <p>Payload truncated</p> : null}
            </>
          ) : (
            "Loading…"
          )}
        </DialogPanel>
        <DialogFooter>
          <Button size="sm" variant="outline" onClick={props.onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
