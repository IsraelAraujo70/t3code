import type { EnvironmentId, WorkflowGateView } from "@t3tools/contracts";
import { gateReasonOf } from "@t3tools/client-runtime/workflows";
import { gateAskMarkdown } from "@t3tools/shared/workflows";
import { useState } from "react";

import ChatMarkdown from "../../../components/ChatMarkdown";
import { Button } from "../../../components/ui/button";

/** Whether the full ask says more than its short reason. */
const saysMore = (gate: Pick<WorkflowGateView, "ask" | "reason">) =>
  gateReasonOf(gate) !== gate.ask.replace(/\s+/g, " ").trim();

/** The ask as readable markdown. */
export function GateAskMarkdown(props: { environmentId: EnvironmentId; ask: string }) {
  return (
    <div className="max-h-96 overflow-auto text-sm">
      <ChatMarkdown
        text={gateAskMarkdown(props.ask)}
        cwd={undefined}
        environmentId={props.environmentId}
      />
    </div>
  );
}

/** A gate's short reason, with the full ask behind "Show more". */
export function GateAsk(props: { environmentId: EnvironmentId; gate: WorkflowGateView }) {
  const [open, setOpen] = useState(false);
  const more = saysMore(props.gate);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <p className="text-sm">{gateReasonOf(props.gate)}</p>
      {more && open ? (
        <GateAskMarkdown environmentId={props.environmentId} ask={props.gate.ask} />
      ) : null}
      {more ? (
        <Button
          size="xs"
          variant="link"
          className="self-start"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? "Show less" : "Show more"}
        </Button>
      ) : null}
    </div>
  );
}
