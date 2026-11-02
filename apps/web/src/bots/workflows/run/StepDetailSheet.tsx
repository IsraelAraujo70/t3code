import { Button } from "../../../components/ui/button";
import type { EnvironmentId, WorkflowRunId, WorkflowStepAttemptView } from "@t3tools/contracts";
import { useEnvironmentQuery } from "../../../state/query";
import { workflowsEnvironment } from "../state";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogPanel,
  DialogFooter,
} from "../../../components/ui/dialog";
/** Loads the selected attempt's output and bounded log tails. */
export function StepDetailSheet(props: {
  environmentId: EnvironmentId;
  runId: WorkflowRunId;
  step: WorkflowStepAttemptView;
  onClose: () => void;
}) {
  const query = useEnvironmentQuery(
    workflowsEnvironment.step({
      environmentId: props.environmentId,
      input: { runId: props.runId, step: props.step.key, attempt: props.step.attempt },
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
          <DialogTitle>
            {props.step.key} · attempt {props.step.attempt}
          </DialogTitle>
        </DialogHeader>
        <DialogPanel>
          {query.error ??
            (query.data ? (
              <>
                <pre className="max-h-64 overflow-auto rounded-md border bg-muted/30 p-3 text-xs whitespace-pre-wrap break-words">
                  {JSON.stringify(query.data.output, null, 2)}
                </pre>
                <p className="whitespace-pre-wrap text-sm">{query.data.text}</p>
                {query.data.logs.map((log) => (
                  <section key={log.name} className="space-y-2">
                    <h3 className="text-xs font-medium text-muted-foreground">{log.name}</h3>
                    <p className="break-all text-xs text-muted-foreground">{log.path}</p>
                    <pre className="max-h-64 overflow-auto rounded-md border bg-muted/30 p-3 text-xs whitespace-pre-wrap break-words">
                      {log.tail}
                    </pre>
                  </section>
                ))}
              </>
            ) : (
              "Loading…"
            ))}
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
