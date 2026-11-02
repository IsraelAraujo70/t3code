import type { EnvironmentId, WorkflowRunId, WorkflowStepAttemptView } from "@t3tools/contracts";
import { useEnvironmentQuery } from "../../../state/query";
import { workflowsEnvironment } from "../state";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogPanel,
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
                <pre className="whitespace-pre-wrap break-words">
                  {JSON.stringify(query.data.output, null, 2)}
                </pre>
                <p className="whitespace-pre-wrap">{query.data.text}</p>
                {query.data.logs.map((log) => (
                  <section key={log.name}>
                    <h3>{log.name}</h3>
                    <p>{log.path}</p>
                    <pre className="whitespace-pre-wrap break-words">{log.tail}</pre>
                  </section>
                ))}
              </>
            ) : (
              "Loading…"
            ))}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
