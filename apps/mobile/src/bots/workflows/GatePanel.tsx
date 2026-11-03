import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, WorkflowGateView, WorkflowRunId } from "@t3tools/contracts";
import { gateReasonOf, openGates } from "@t3tools/client-runtime/workflows";
import { gateAskMarkdown } from "@t3tools/shared/workflows";
import { useState } from "react";
import { Linking, ScrollView, TextInput, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { Notice } from "../../components/ui/Notice";
import { Sheet } from "../../components/ui/Sheet";
import { useMarkdownPreviewStyles } from "../../features/files/FileMarkdownPreview";
import { relativeTime } from "../../lib/time";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useAtomCommand } from "../../state/use-atom-command";
import { workflowsEnvironment, useWorkflowRun } from "./state";
import { gateOptionTone, sameText } from "./workflowsScreen.logic";

function GateAskMarkdown({ ask }: { ask: string }) {
  const styles = useMarkdownPreviewStyles();
  return (
    <SelectableMarkdownText
      markdown={gateAskMarkdown(ask)}
      textStyle={styles.nativeTextStyle}
      onLinkPress={(href) => void Linking.openURL(href)}
    />
  );
}

/**
 * One gate, readable and answerable on a phone: the short reason first, the whole ask under it,
 * then one button per option. Only the user's own session may decide (`gateDecide` is guarded).
 */
export function GateDecision(props: {
  readonly environmentId: EnvironmentId;
  readonly runId: WorkflowRunId;
  readonly gate: WorkflowGateView;
  /** The gated step's own summary, when it has one. */
  readonly summary?: string | null;
  readonly pullRequest?: string | null;
  readonly onDecided?: () => void;
}) {
  const { gate } = props;
  const decide = useAtomCommand(workflowsEnvironment.gateDecide);
  const allowed = useAtomValue(workflowsEnvironment.gateDecide.permissionAtom(props.environmentId));
  const [note, setNote] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reason = gateReasonOf(gate);
  const submit = async (option: string) => {
    setPending(option);
    setError(null);
    const result = await decide({
      environmentId: props.environmentId,
      input: {
        runId: props.runId,
        gateKey: gate.key,
        option,
        ...(note.trim() ? { note: note.trim() } : {}),
      },
    });
    setPending(null);
    if (result._tag === "Success") props.onDecided?.();
    else setError("The decision did not go through. Try again.");
  };
  return (
    <View className="gap-3">
      <Text className="text-base leading-6 font-t3-bold text-foreground" selectable>
        {reason}
      </Text>
      {sameText(reason, gate.ask) ? null : <GateAskMarkdown ask={gate.ask} />}
      {props.summary ? (
        <Text className="text-sm text-foreground-muted" selectable>
          {props.summary}
        </Text>
      ) : null}
      {props.pullRequest ? (
        <Button
          label="Open pull request"
          icon="arrow.up.right"
          tone="text"
          onPress={() => void Linking.openURL(props.pullRequest!)}
        />
      ) : null}
      <Text className="text-xs text-foreground-tertiary">
        Waiting {relativeTime(gate.openedAt)}
        {gate.expiresAt ? ` · expires ${new Date(gate.expiresAt).toLocaleString()}` : ""}
      </Text>
      {gate.decision ? (
        <Notice message={`Decided: ${gate.decision.option}`} />
      ) : (
        <>
          <TextInput
            accessibilityLabel="Note for the run (optional)"
            placeholder="Add a note (optional)"
            value={note}
            onChangeText={setNote}
            maxLength={4000}
            multiline
            className="min-h-11 rounded-xl border border-border bg-input px-3 py-2.5 text-foreground"
          />
          {error ? <Notice tone="danger" message={error} /> : null}
          {allowed ? null : <Notice message="This device may not decide gates." />}
          <View className="gap-2">
            {gate.options.map((option, index) => (
              <Button
                key={option}
                label={option}
                tone={gateOptionTone(option, index)}
                fullWidth
                loading={pending === option}
                disabled={pending !== null || !allowed}
                onPress={() => void submit(option)}
              />
            ))}
          </View>
        </>
      )}
    </View>
  );
}

/**
 * Answer a run's oldest open gate from a list, without opening the run. The list's summary carries
 * only the reason, so the sheet follows the run for the ask and its options.
 */
export function GateSheet(props: {
  readonly environmentId: EnvironmentId;
  readonly runId: WorkflowRunId;
  readonly title: string;
  readonly onOpenRun: () => void;
  readonly onClose: () => void;
}) {
  const query = useWorkflowRun(props.environmentId, props.runId);
  const gate = query.data ? openGates(query.data.gates)[0] : undefined;
  return (
    <Sheet title={props.title} onClose={props.onClose}>
      <ScrollView contentContainerClassName="gap-4 p-4 pb-10" keyboardShouldPersistTaps="handled">
        {query.error ? (
          <EmptyState title="Couldn't load the run" detail={query.error} variant="plain" />
        ) : !query.data ? (
          <View className="items-center py-10">
            <AppActivityIndicator colorClassName="accent-icon" />
          </View>
        ) : gate ? (
          <GateDecision
            environmentId={props.environmentId}
            runId={props.runId}
            gate={gate}
            pullRequest={query.data.summary.pullRequest}
            onDecided={props.onClose}
          />
        ) : (
          <EmptyState
            title="Nothing to decide"
            detail="This run no longer waits on a gate."
            variant="plain"
          />
        )}
        <Button label="Open run" tone="text" onPress={props.onOpenRun} />
      </ScrollView>
    </Sheet>
  );
}
