import type { EnvironmentId, WorkflowId } from "@t3tools/contracts";
import { PlayIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "../../../components/ui/button";
import { Switch } from "../../../components/ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../../components/ui/tooltip";
import { randomUUID } from "~/lib/utils";
import { useAtomCommand } from "../../../state/use-atom-command";
import { commandFailureMessage } from "../../botsSettingsShared";
import { RunNowDialog } from "../RunNowDialog";
import { useWorkflowDocument, workflowsEnvironment } from "../state";
import { WorkflowsBreadcrumb, WorkflowsNotice, WorkflowsPageFrame } from "../WorkflowsPageFrame";
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
  const runBlocked =
    document.data === null
      ? "Loading…"
      : !document.data.valid
        ? "Fix the workflow's errors before running it."
        : document.data.suspended
          ? "Suspended after repeated failures; it cannot run until resumed."
          : !document.data.triggers.some((trigger) => trigger.kind === "manual")
            ? "No Run now trigger. Add one from the Triggers row."
            : null;
  return (
    <WorkflowsPageFrame
      title={
        <WorkflowsBreadcrumb environmentId={props.environmentId}>
          <span className="truncate">{document.data?.definition?.title ?? props.workflowId}</span>
        </WorkflowsBreadcrumb>
      }
      actions={
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-muted-foreground text-xs">
            {document.data?.enabled ? "On" : "Off"}
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
          </label>
          <Tooltip>
            <TooltipTrigger render={<span className="inline-flex" />}>
              <Button
                size="xs"
                variant="outline"
                disabled={runBlocked !== null}
                onClick={() => setRunning(true)}
              >
                <PlayIcon />
                Run now
              </Button>
            </TooltipTrigger>
            {runBlocked === null ? null : <TooltipPopup>{runBlocked}</TooltipPopup>}
          </Tooltip>
        </div>
      }
    >
      {error ? (
        <p role="alert" className="px-(--workspace-gutter-start) pt-2 text-destructive text-sm">
          {error}
        </p>
      ) : null}
      {document.data === null ? (
        <WorkflowsNotice tone={document.error ? "error" : "muted"}>
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
