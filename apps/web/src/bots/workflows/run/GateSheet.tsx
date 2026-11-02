import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import type { EnvironmentId, WorkflowRunId, WorkflowGateView } from "@t3tools/contracts";
import { useAtomCommand } from "../../../state/use-atom-command";
import { commandFailureMessage } from "../../botsSettingsShared";
import { workflowsEnvironment } from "../state";
import { Button } from "../../../components/ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogPanel,
} from "../../../components/ui/dialog";
/** Presents a human gate with its evidence before recording a decision. */
export function GateSheet(props: {
  environmentId: EnvironmentId;
  runId: WorkflowRunId;
  gate: WorkflowGateView;
  evidence: string;
  pullRequest: string | null;
  onClose: () => void;
}) {
  const canOperate = useAtomValue(
    workflowsEnvironment.gateDecide.permissionAtom(props.environmentId),
  );
  const decide = useAtomCommand(workflowsEnvironment.gateDecide, { label: "gate decision" });
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (option: string) => {
    setPending(true);
    setError(null);
    const result = await decide({
      environmentId: props.environmentId,
      input: { runId: props.runId, gateKey: props.gate.key, option, note },
    });
    setPending(false);
    if (result._tag === "Failure") setError(commandFailureMessage(result));
    else props.onClose();
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) props.onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Needs you</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <p>{props.gate.ask}</p>
          <p className="whitespace-pre-wrap">{props.evidence}</p>
          {props.pullRequest ? (
            <a href={props.pullRequest} target="_blank" rel="noreferrer">
              Pull request
            </a>
          ) : null}
          <label>
            Optional note
            <textarea
              aria-label="Optional note"
              maxLength={4000}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          <div className="flex gap-2">
            {(props.gate.options.length ? props.gate.options : ["approve", "reject"]).map(
              (option) => (
                <Button
                  key={option}
                  disabled={pending || !canOperate}
                  onClick={() => void submit(option)}
                >
                  {option}
                </Button>
              ),
            )}
          </div>
          {error ? <p role="alert">{error}</p> : null}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
