import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  WorkflowGateView,
  WorkflowRunId,
  WorkflowStepAttemptView,
} from "@t3tools/contracts";
import { useState } from "react";
import { Linking, ScrollView } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { Notice } from "../../components/ui/Notice";
import { Sheet } from "../../components/ui/Sheet";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { gateReasonOf } from "@t3tools/client-runtime/workflows";
import { GateAskMarkdown } from "./GateAsk";
import { WorkflowEditField } from "./WorkflowEditField";
import { workflowsEnvironment } from "./state";

/** Read the selected attempt's output and logs only while its sheet is open. */
export function WorkflowStepSheet({
  environmentId,
  runId,
  step,
  onClose,
}: {
  environmentId: EnvironmentId;
  runId: WorkflowRunId;
  step: WorkflowStepAttemptView;
  onClose: () => void;
}) {
  const query = useEnvironmentQuery(
    workflowsEnvironment.step({
      environmentId,
      input: { runId, step: step.key, attempt: step.attempt },
    }),
  );
  return (
    <Sheet title={`${step.key} · attempt ${step.attempt}`} onClose={onClose}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-3 p-4 pb-10"
      >
        {query.error && <Notice tone="danger" message={query.error} />}
        {!query.data && !query.error && <Text>Loading details…</Text>}
        {query.data && (
          <>
            <Text selectable>{query.data.text ?? "No final text."}</Text>
            <Text selectable>{JSON.stringify(query.data.output, null, 2)}</Text>
            {query.data.logs.map((log) => (
              <Text selectable key={log.name}>
                {log.name}
                {"\n"}
                {log.path}
                {"\n"}
                {log.tail}
              </Text>
            ))}
          </>
        )}
      </ScrollView>
    </Sheet>
  );
}

/** Only the authenticated user's guarded command can decide an open gate. */
export function WorkflowGateSheet({
  environmentId,
  runId,
  gate,
  summary,
  pullRequest,
  onClose,
}: {
  environmentId: EnvironmentId;
  runId: WorkflowRunId;
  gate: WorkflowGateView;
  summary: string | null;
  pullRequest: string | null;
  onClose: () => void;
}) {
  const decide = useAtomCommand(workflowsEnvironment.gateDecide);
  const allowed = useAtomValue(workflowsEnvironment.gateDecide.permissionAtom(environmentId));
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const submit = async (option: string) => {
    setPending(true);
    const result = await decide({
      environmentId,
      input: { runId, gateKey: gate.key, option, ...(note ? { note } : {}) },
    });
    setPending(false);
    if (result._tag === "Success") onClose();
  };
  return (
    <Sheet title="Needs you" onClose={onClose}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-3 p-4 pb-10"
      >
        <Text selectable>{gateReasonOf(gate)}</Text>
        <GateAskMarkdown ask={gate.ask} />
        {summary && <Text selectable>{summary}</Text>}
        {pullRequest && (
          <ControlPill
            label="Open PR evidence"
            variant="pill"
            onPress={() => void Linking.openURL(pullRequest)}
          />
        )}
        <Text>
          Opened {gate.openedAt}
          {gate.expiresAt ? ` · Expires ${gate.expiresAt}` : ""}
        </Text>
        <WorkflowEditField label="Optional note" value={note} onChange={setNote} maxLength={4000} />
        {gate.decision ? (
          <Notice message={`Decided: ${gate.decision.option}`} />
        ) : (
          gate.options.map((option) => (
            <ControlPill
              key={option}
              label={option}
              variant="primary"
              disabled={pending || !allowed}
              onPress={() => void submit(option)}
            />
          ))
        )}
      </ScrollView>
    </Sheet>
  );
}
