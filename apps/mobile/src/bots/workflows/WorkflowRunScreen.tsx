import { useAtomValue } from "@effect/atom-react";
import type { StaticScreenProps } from "@react-navigation/native";
import {
  gateReasonOf,
  isRunActive,
  nodeStatuses,
  openGates,
  runNeedsYou,
  runStatusLabel,
  runStatusTone,
  stepRows,
  stepStatusLabel,
  stepStatusTone,
  toCanvasModel,
  withNodeStatuses,
  type WorkflowStepRow,
} from "@t3tools/client-runtime/workflows";
import {
  EnvironmentId,
  WorkflowRunId,
  type WorkflowRunControl,
  type WorkflowRunView,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Crypto from "expo-crypto";
import { useMemo, useState } from "react";
import { Linking, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListSection } from "../../components/ui/ListSection";
import { Notice } from "../../components/ui/Notice";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { useOpenLinkedThread } from "../../features/threads/useOpenLinkedThread";
import { useNowMinuteMs } from "../../lib/clock";
import { relativeTime } from "../../lib/time";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { BotAvatar } from "../BotAvatar";
import { Disclosure } from "./Disclosure";
import { GateDecision } from "./GatePanel";
import { WorkflowGraph } from "./WorkflowGraph";
import { WorkflowStepSheet } from "./WorkflowRunSheets";
import { runIcon, StatusGlyph, StatusLabel, stepIcon } from "./WorkflowStatus";
import { useWorkflowRun, useWorkflowsSnapshot, workflowsEnvironment } from "./state";
import { needsYouLine, runFactsLine, runTriggerText, stepMetaLine } from "./workflowsScreen.logic";

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeWorkflowRunId = Schema.decodeUnknownOption(WorkflowRunId);

const PAUSE_DETAIL = {
  fatigue: "Paused after too many failures in a row. Resume to keep going.",
  ambiguous: "Paused: a step's outcome needs your review before it goes on.",
  user: "Paused at your request.",
  daily_cap: "Paused: the host's daily token limit was reached. It resumes when the day turns.",
} as const;
const SKIP_DETAIL = {
  busy: "Skipped: the workflow was already running.",
  disabled: "Skipped: the workflow was off.",
  suspended: "Skipped: the workflow was suspended.",
  invalid: "Skipped: the workflow did not compile.",
} as const;

/** Validate deep links (the gate push opens here) before mounting the live run subscription. */
export function WorkflowRunScreen({
  route,
}: StaticScreenProps<{ environmentId: string; runId: string }>) {
  const environmentId = decodeEnvironmentId(route.params.environmentId);
  const runId = decodeWorkflowRunId(route.params.runId);
  return environmentId._tag === "Some" && runId._tag === "Some" ? (
    <RunContent
      key={`${environmentId.value}/${runId.value}`}
      environmentId={environmentId.value}
      runId={runId.value}
    />
  ) : (
    <View className="flex-1 bg-screen">
      <AppBar title="Workflow run" />
      <EmptyState title="Invalid link" detail="This run link is malformed." variant="plain" />
    </View>
  );
}

/**
 * A run on a phone: where it stands and what it cost, the gate that waits for the user with its
 * whole question, then each step with its thread. The graph and the rest fold away below.
 */
function RunContent(props: { environmentId: EnvironmentId; runId: WorkflowRunId }) {
  const { environmentId, runId } = props;
  const insets = useSafeAreaInsets();
  const query = useWorkflowRun(environmentId, runId);
  const run = query.data;
  const snapshot = useWorkflowsSnapshot(environmentId);
  const workflow =
    snapshot.data?.workflows.find((w) => w.workflowId === run?.summary.workflowId) ?? null;
  const nowMs = useNowMinuteMs();
  const control = useAtomCommand(workflowsEnvironment.runControl);
  const allowed = useAtomValue(workflowsEnvironment.runControl.permissionAtom(environmentId));
  // A gate routed to the workflow's bot waits for it; Israel may still answer it.
  const botName = workflow?.bot?.name ?? "the bot";
  const [pending, setPending] = useState(false);
  const [openStep, setOpenStep] = useState<string | null>(null);
  const openThread = useOpenLinkedThread();
  const rows = useMemo(() => stepRows(run?.steps ?? []), [run?.steps]);
  const stepRow = rows.find((row) => row.key === openStep) ?? null;
  const submit = async (action: WorkflowRunControl) => {
    setPending(true);
    await control({
      environmentId,
      input: { runId, control: action, clientRequestId: Crypto.randomUUID() },
    });
    setPending(false);
  };
  return (
    <View className="flex-1 bg-header" style={{ paddingBottom: insets.bottom }}>
      <AppBar
        title={run?.summary.title ?? "Workflow run"}
        subtitle={workflow?.title}
        avatar={workflow?.bot ? <BotAvatar botId={workflow.bot.id} size={28} /> : undefined}
      />
      <ScreenContent>
        {query.error && !run ? (
          <EmptyState title="Couldn't load the run" detail={query.error} variant="plain" />
        ) : !run ? (
          <View className="flex-1 items-center justify-center">
            <AppActivityIndicator colorClassName="accent-icon" accessibilityLabel="Loading run" />
          </View>
        ) : (
          <ScrollView
            contentContainerClassName="gap-5 p-3 pb-10"
            keyboardShouldPersistTaps="handled"
          >
            <RunSummaryCard
              run={run}
              nowMs={nowMs}
              pending={pending}
              allowed={allowed}
              onControl={(action) => void submit(action)}
            />
            {openGates(run.gates).map((gate) => (
              <View
                key={gate.key}
                className={
                  gate.bot === undefined
                    ? "gap-3 rounded-2xl border border-warning-border bg-warning p-4"
                    : "gap-3 rounded-2xl border border-border p-4"
                }
              >
                {gate.bot === undefined ? (
                  <Text className="text-xs font-t3-bold text-warning-foreground">NEEDS YOU</Text>
                ) : (
                  <Text className="text-xs font-t3-bold text-foreground-muted">
                    WAITING FOR {botName.toUpperCase()}
                  </Text>
                )}
                <GateDecision
                  environmentId={environmentId}
                  runId={runId}
                  gate={gate}
                  summary={
                    rows.find(
                      (row) => row.key === gate.step && row.latest.status !== "waiting_gate",
                    )?.latest.summary ?? null
                  }
                  pullRequest={run.summary.pullRequest}
                />
              </View>
            ))}
            <ListSection title={rows.length === 0 ? "Steps" : `Steps · ${rows.length}`}>
              {rows.length === 0 ? (
                <Text className="p-4 text-sm text-foreground-muted">
                  {isRunActive(run.summary.status) ? "No step has started yet." : "No steps ran."}
                </Text>
              ) : (
                rows.map((row) => (
                  <StepRow
                    key={row.key}
                    row={row}
                    nowMs={nowMs}
                    onPress={() => setOpenStep(row.key)}
                    onOpenThread={(threadId) => openThread({ environmentId, threadId })}
                  />
                ))
              )}
            </ListSection>
            <RunDetails
              environmentId={environmentId}
              runId={runId}
              run={run}
              onPressStep={(key) => setOpenStep(key)}
            />
          </ScrollView>
        )}
      </ScreenContent>
      {stepRow ? (
        <WorkflowStepSheet
          key={stepRow.key}
          environmentId={environmentId}
          runId={runId}
          row={stepRow}
          canRetry={allowed && !pending}
          onRetry={() => {
            setOpenStep(null);
            void submit({ _tag: "retry", step: stepRow.key });
          }}
          onOpenThread={(threadId) => {
            setOpenStep(null);
            openThread({ environmentId, threadId });
          }}
          onClose={() => setOpenStep(null)}
        />
      ) : null}
    </View>
  );
}

function RunSummaryCard(props: {
  run: WorkflowRunView;
  nowMs: number;
  pending: boolean;
  allowed: boolean;
  onControl: (action: WorkflowRunControl) => void;
}) {
  const { summary } = props.run;
  const needsYou = runNeedsYou(summary);
  const disabled = props.pending || !props.allowed;
  const note = summary.skipReason
    ? SKIP_DETAIL[summary.skipReason]
    : summary.status === "paused" && summary.pausedFor
      ? PAUSE_DETAIL[summary.pausedFor]
      : null;
  return (
    <View className="gap-3 rounded-2xl bg-grouped-card p-4">
      <StatusLabel
        icon={runIcon(summary.status, needsYou)}
        label={needsYou ? `Needs you · ${needsYouLine(summary)}` : runStatusLabel(summary.status)}
        tone={needsYou ? "warning" : runStatusTone(summary.status)}
        large
      />
      <Text className="text-sm text-foreground-muted">
        {runFactsLine(summary, props.nowMs, `${relativeTime(summary.startedAt, props.nowMs)} ago`)}
      </Text>
      <Text className="text-xs text-foreground-tertiary">
        {runTriggerText(summary)}
        {props.run.trigger.test ? " · test event" : ""}
      </Text>
      {note ? <Notice message={note} /> : null}
      {props.run.warnings?.map((warning) => (
        <Notice key={warning} message={warning} />
      ))}
      {summary.pullRequest || isRunActive(summary.status) ? (
        <View className="flex-row flex-wrap gap-2">
          {summary.pullRequest ? (
            <Button
              label="Open pull request"
              icon="arrow.up.right"
              tone="primary"
              onPress={() => void Linking.openURL(summary.pullRequest!)}
            />
          ) : null}
          {summary.status === "paused" ? (
            <Button
              label="Resume"
              icon="play"
              tone="primary"
              disabled={disabled}
              onPress={() => props.onControl({ _tag: "resume" })}
            />
          ) : null}
          {summary.status === "running" ? (
            <Button
              label="Pause"
              icon="pause"
              disabled={disabled}
              onPress={() => props.onControl({ _tag: "pause" })}
            />
          ) : null}
          {isRunActive(summary.status) ? (
            <Button
              label="Cancel run"
              tone="text"
              disabled={disabled}
              onPress={() => props.onControl({ _tag: "cancel" })}
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function StepRow(props: {
  row: WorkflowStepRow;
  nowMs: number;
  onPress: () => void;
  onOpenThread: (threadId: string) => void;
}) {
  const step = props.row.latest;
  const tone = stepStatusTone(step.status);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${props.row.node}, ${stepStatusLabel(step.status)}`}
      accessibilityHint="Double tap for the step's output, logs and attempts."
      onPress={props.onPress}
      className="flex-row gap-3 px-4 active:bg-row-hover"
    >
      <View className="self-start pt-3">
        <StatusGlyph icon={stepIcon(step.status)} tone={tone} size={18} />
      </View>
      <View className="min-w-0 flex-1 gap-1 border-b border-border-subtle py-2.5">
        <Text className="text-base leading-5 font-t3-medium text-foreground" numberOfLines={1}>
          {props.row.node}
        </Text>
        <Text className="text-xs text-foreground-muted" numberOfLines={1}>
          {stepMetaLine(step, props.nowMs)}
        </Text>
        {step.summary && step.status !== "waiting_gate" ? (
          <Text className="text-sm leading-5 text-foreground-muted" numberOfLines={2}>
            {step.summary}
          </Text>
        ) : null}
        {step.threadId ? (
          <View className="flex-row">
            <Button
              label="Open thread"
              icon="bubble.left"
              tone="text"
              onPress={() => props.onOpenThread(step.threadId!)}
            />
          </View>
        ) : null}
      </View>
    </Pressable>
  );
}

/** What a phone rarely needs, folded: the graph, block progress, decided gates, the trigger. */
function RunDetails(props: {
  environmentId: EnvironmentId;
  runId: WorkflowRunId;
  run: WorkflowRunView;
  onPressStep: (key: string) => void;
}) {
  const { run } = props;
  const graph = useMemo(
    () =>
      run.definition
        ? withNodeStatuses(toCanvasModel(run.definition), nodeStatuses(run.steps))
        : null,
    [run.definition, run.steps],
  );
  const decided = run.gates.filter((gate) => gate.decision !== null);
  const rows = stepRows(run.steps);
  return (
    <>
      {graph ? (
        <Disclosure title="Graph" detail="Tap a node for its step">
          <WorkflowGraph
            model={graph}
            firedTriggerId={run.trigger.id}
            onPressNode={(node) => {
              const row = rows.find((candidate) => candidate.node === node);
              if (row) props.onPressStep(row.key);
            }}
          />
        </Disclosure>
      ) : null}
      {run.blocks.length > 0 ? (
        <Disclosure title="Blocks" detail={run.blocks.map((block) => block._tag).join(", ")}>
          {run.blocks.map((block) => (
            <View key={block.step} className="gap-1">
              <Text className="text-sm font-t3-medium text-foreground">
                {block._tag} · {block.step}
              </Text>
              <Text className="text-xs leading-5 text-foreground-muted" selectable>
                {block._tag === "hillclimb"
                  ? `Round ${block.round} · ${block.attempts} attempts · ${block.roundsWithoutGain} without gain`
                  : block._tag === "arena"
                    ? [
                        `Base ${block.base ?? "not picked"}`,
                        ...block.candidates.map(
                          (c) => `${c.id}: ${stepStatusLabel(c.status)}, score ${c.score ?? "–"}`,
                        ),
                      ].join("\n")
                    : block._tag === "graph"
                      ? block.leaves
                          .map((leaf) => `${leaf.id}: ${stepStatusLabel(leaf.status)}`)
                          .join("\n")
                      : [
                          `Round ${block.round} · ${block.verdict ?? "pending"}`,
                          ...block.findings.map((f) => `${f.state}: ${f.summary}`),
                        ].join("\n")}
              </Text>
            </View>
          ))}
        </Disclosure>
      ) : null}
      {decided.length > 0 ? (
        <Disclosure title="Decided gates" detail={`${decided.length} answered`}>
          {decided.map((gate) => (
            <View key={gate.key} className="gap-0.5">
              <Text className="text-sm text-foreground">{gateReasonOf(gate)}</Text>
              <Text className="text-xs text-foreground-muted">
                {gate.decision!.option} · {relativeTime(gate.decision!.at)} ago
                {gate.decision!.note ? ` · ${gate.decision!.note}` : ""}
              </Text>
            </View>
          ))}
        </Disclosure>
      ) : null}
      <Disclosure title="Trigger" detail={run.trigger.label}>
        <TriggerPayload environmentId={props.environmentId} runId={props.runId} />
      </Disclosure>
    </>
  );
}

/** The event that started the run; mounts only when its section opens. */
function TriggerPayload(props: { environmentId: EnvironmentId; runId: WorkflowRunId }) {
  const payload = useEnvironmentQuery(
    workflowsEnvironment.runTrigger({
      environmentId: props.environmentId,
      input: { runId: props.runId, maxBytes: 4096 },
    }),
  );
  if (payload.error) return <Notice tone="danger" message={payload.error} />;
  if (!payload.data) return <AppActivityIndicator colorClassName="accent-icon" />;
  return (
    <Text
      className="rounded-xl bg-subtle p-3 text-xs text-foreground"
      style={{ fontFamily: "monospace" }}
      selectable
    >
      {payload.data.truncated
        ? "The payload is larger than 4 KiB: open it on desktop."
        : JSON.stringify(payload.data.payload, null, 2)}
    </Text>
  );
}
