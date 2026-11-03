import type { WorkflowStepRow } from "@t3tools/client-runtime/workflows";
import { formatUsd, stepStatusTone } from "@t3tools/client-runtime/workflows";
import type { EnvironmentId, WorkflowRunId } from "@t3tools/contracts";
import { useState } from "react";
import { ScrollView, View } from "react-native";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Chip } from "../../components/ui/Chip";
import { Notice } from "../../components/ui/Notice";
import { Sheet } from "../../components/ui/Sheet";
import { useNowMinuteMs } from "../../lib/clock";
import { useEnvironmentQuery } from "../../state/query";
import { StatusLabel, stepIcon } from "./WorkflowStatus";
import { workflowsEnvironment } from "./state";
import { isRetryable, stepMetaLine } from "./workflowsScreen.logic";

const MONO = { fontFamily: "monospace" } as const;

/**
 * One step: status, time and cost, its thread and Retry up top, then the attempt's final text,
 * output and log tails, read only while the sheet is open.
 */
export function WorkflowStepSheet(props: {
  environmentId: EnvironmentId;
  runId: WorkflowRunId;
  row: WorkflowStepRow;
  canRetry: boolean;
  onRetry: () => void;
  onOpenThread: (threadId: string) => void;
  onClose: () => void;
}) {
  const { row } = props;
  const [attemptNumber, setAttempt] = useState(row.latest.attempt);
  const step = row.attempts.find((a) => a.attempt === attemptNumber) ?? row.latest;
  const nowMs = useNowMinuteMs();
  const query = useEnvironmentQuery(
    workflowsEnvironment.step({
      environmentId: props.environmentId,
      input: { runId: props.runId, step: step.key, attempt: step.attempt },
    }),
  );
  const latest = step.attempt === row.latest.attempt;
  return (
    <Sheet title={row.node} onClose={props.onClose}>
      <ScrollView contentContainerClassName="gap-4 p-4 pb-10">
        <View className="gap-1">
          <StatusLabel
            icon={stepIcon(step.status)}
            label={stepMetaLine(step, nowMs)}
            tone={stepStatusTone(step.status)}
          />
          {step.cost?.usdEstimate != null ? (
            <Text className="text-xs text-foreground-muted">
              About {formatUsd(step.cost.usdEstimate)}
              {step.cost.usage === "complete" ? "" : " (usage incomplete)"}
            </Text>
          ) : null}
          {step.queuedMs ? (
            <Text className="text-xs text-foreground-muted">
              Waited {Math.round(step.queuedMs / 1000)}s for the heavy lock
            </Text>
          ) : null}
        </View>
        {row.attempts.length > 1 ? (
          <ScrollView horizontal showsHorizontalScrollIndicator={false}>
            <View className="flex-row gap-2">
              {row.attempts.map((attempt) => (
                <Chip
                  key={attempt.attempt}
                  label={`Attempt ${attempt.attempt}`}
                  selected={attempt.attempt === step.attempt}
                  onPress={() => setAttempt(attempt.attempt)}
                />
              ))}
            </View>
          </ScrollView>
        ) : null}
        <View className="flex-row flex-wrap gap-2">
          {step.threadId ? (
            <Button
              label="Open thread"
              icon="bubble.left"
              tone="primary"
              onPress={() => props.onOpenThread(step.threadId!)}
            />
          ) : null}
          {latest && isRetryable(step.status) ? (
            <Button
              label="Retry step"
              icon="arrow.clockwise"
              disabled={!props.canRetry}
              onPress={props.onRetry}
            />
          ) : null}
        </View>
        {step.summary ? (
          <Text className="text-sm leading-5 text-foreground" selectable>
            {step.summary}
          </Text>
        ) : null}
        {query.error ? <Notice tone="danger" message={query.error} /> : null}
        {!query.data && !query.error ? (
          <AppActivityIndicator colorClassName="accent-icon" accessibilityLabel="Loading details" />
        ) : null}
        {query.data ? (
          <>
            {query.data.text ? (
              <View className="gap-1">
                <Text className="text-xs font-t3-medium text-foreground-muted">Final text</Text>
                <Text className="text-sm leading-5 text-foreground" selectable>
                  {query.data.text}
                </Text>
              </View>
            ) : null}
            {query.data.output !== null && query.data.output !== undefined ? (
              <View className="gap-1">
                <Text className="text-xs font-t3-medium text-foreground-muted">Output</Text>
                <Text
                  className="rounded-xl bg-subtle p-3 text-xs text-foreground"
                  style={MONO}
                  selectable
                >
                  {JSON.stringify(query.data.output, null, 2)}
                </Text>
              </View>
            ) : null}
            {query.data.logs.map((log) => (
              <View key={log.name} className="gap-1">
                <Text className="text-xs font-t3-medium text-foreground-muted">{log.name} log</Text>
                <Text
                  className="rounded-xl bg-subtle p-3 text-xs text-foreground"
                  style={MONO}
                  selectable
                >
                  {log.tail || "Empty."}
                </Text>
                {log.path ? (
                  <Text className="text-2xs text-foreground-tertiary" selectable>
                    {log.path}
                  </Text>
                ) : null}
              </View>
            ))}
          </>
        ) : null}
      </ScrollView>
    </Sheet>
  );
}
