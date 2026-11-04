import { Textarea } from "../../../components/ui/textarea";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import type { EnvironmentId, WorkflowRunId, WorkflowGateView } from "@t3tools/contracts";
import { useAtomCommand } from "../../../state/use-atom-command";
import { commandFailureMessage } from "../../botsSettingsShared";
import { workflowsEnvironment } from "../state";
import { gateReasonOf } from "@t3tools/client-runtime/workflows";
import { GateAskMarkdown } from "./GateAsk";
import { Button } from "../../../components/ui/button";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogPanel,
  DialogFooter,
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
          <p className="text-sm font-medium">{gateReasonOf(props.gate)}</p>
          <GateAskMarkdown environmentId={props.environmentId} ask={props.gate.ask} />
          {props.evidence ? (
            <pre className="max-h-64 overflow-auto rounded-md border bg-muted/30 p-3 text-xs whitespace-pre-wrap break-words">
              {props.evidence}
            </pre>
          ) : null}
          {props.pullRequest ? (
            <a
              className="text-sm underline underline-offset-4"
              href={props.pullRequest}
              target="_blank"
              rel="noreferrer"
            >
              Pull request
            </a>
          ) : null}
          <label className="block space-y-2 text-xs text-muted-foreground">
            Optional note
            <Textarea
              aria-label="Optional note"
              maxLength={4000}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </label>
          {error ? (
            <p role="alert" className="text-sm text-destructive-foreground">
              {error}
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button size="sm" variant="outline" disabled={pending} onClick={props.onClose}>
            Close
          </Button>
          {(props.gate.options.length ? props.gate.options : ["approve", "reject"])
            // `escalate` is how the bot hands the gate to Israel, not one of Israel's answers.
            .filter((option) => props.gate.bot === undefined || option !== "escalate")
            .map((option) => (
              <Button
                key={option}
                size="sm"
                variant={option === "reject" ? "destructive-outline" : "default"}
                disabled={pending || !canOperate}
                onClick={() => void submit(option)}
              >
                {option}
              </Button>
            ))}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
