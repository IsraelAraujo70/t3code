import type { EnvironmentId, WorkflowId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "../../../components/ui/button";
import { Switch } from "../../../components/ui/switch";
import { randomUUID } from "~/lib/utils";
import { useAtomCommand } from "../../../state/use-atom-command";
import { commandFailureMessage } from "../../botsSettingsShared";
import { RunNowDialog } from "../RunNowDialog";
import { useWorkflowDocument, workflowsEnvironment } from "../state";
import { WorkflowsNotice, WorkflowsPageFrame } from "../WorkflowsPageFrame";
import { WorkflowEditorTab } from "./WorkflowEditorTab";
import { WorkflowEditorView } from "./WorkflowEditorView";

/** Connects the editor to the selected host's document stream and commands. */
export function WorkflowEditorPage(props: {
  environmentId: EnvironmentId;
  workflowId: WorkflowId;
}) {
  const document = useWorkflowDocument(props.environmentId, props.workflowId);
  const save = useAtomCommand(workflowsEnvironment.save, { label: "workflow save" });
  const setEnabled = useAtomCommand(workflowsEnvironment.setEnabled, { label: "workflow enable" });
  const [running, setRunning] = useState(false);
  const [enabling, setEnabling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <WorkflowsPageFrame
      title={document.data?.definition?.title ?? props.workflowId}
      actions={
        <div className="flex items-center gap-2">
          <Button
            size="xs"
            variant="ghost-muted"
            render={
              <Link
                to="/workflows/$environmentId"
                params={{ environmentId: props.environmentId }}
              />
            }
          >
            Workflows
          </Button>
          <Switch
            aria-label="Enable workflow"
            checked={document.data?.enabled ?? false}
            disabled={document.data === null || enabling}
            onCheckedChange={(enabled) => {
              setEnabling(true);
              setError(null);
              void setEnabled({
                environmentId: props.environmentId,
                input: { workflowId: props.workflowId, enabled, clientRequestId: randomUUID() },
              }).then((result) => {
                setEnabling(false);
                if (result._tag === "Failure") setError(commandFailureMessage(result));
              });
            }}
          />
          <Button size="xs" disabled={!document.data?.valid} onClick={() => setRunning(true)}>
            Run now
          </Button>
        </div>
      }
    >
      {error ? (
        <p role="alert" className="px-4 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {document.data === null ? (
        <WorkflowsNotice>
          {document.error ?? (document.isSuccess ? "Workflow not found." : "Loading workflow…")}
        </WorkflowsNotice>
      ) : (
        <WorkflowEditorView
          key={`${props.environmentId}:${props.workflowId}`}
          environmentId={props.environmentId}
          document={document.data}
          extraTabs={{
            Runs: <WorkflowEditorTab {...props} tab="Runs" />,
            Metrics: <WorkflowEditorTab {...props} tab="Metrics" />,
            Ledger: <WorkflowEditorTab {...props} tab="Ledger" />,
            History: <WorkflowEditorTab {...props} tab="History" />,
          }}
          save={async (input) => {
            const result = await save({ environmentId: props.environmentId, input });
            return result._tag === "Failure"
              ? { ok: false, message: commandFailureMessage(result) ?? "Could not save workflow." }
              : { ok: true, result: result.value };
          }}
        />
      )}
      {running ? <RunNowDialog {...props} onClose={() => setRunning(false)} /> : null}
    </WorkflowsPageFrame>
  );
}
