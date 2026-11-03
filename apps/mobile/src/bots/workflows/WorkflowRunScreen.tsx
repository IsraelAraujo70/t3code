import { useEnvironmentQuery } from "../../state/query";
import { useAtomValue } from "@effect/atom-react";
import type { StaticScreenProps } from "@react-navigation/native";
import {
  EnvironmentId,
  WorkflowRunId,
  type WorkflowRunControl,
  type WorkflowGateView,
  type WorkflowStepAttemptView,
} from "@t3tools/contracts";
import {
  formatDuration,
  liveActiveMs,
  formatTokens,
  formatUsd,
  isRunActive,
  nodeStatuses,
  openGates,
  runStatusLabel,
  runStatusTone,
  stepDurationMs,
  stepRows,
  stepStatusLabel,
  stepStatusTone,
  toCanvasModel,
  withNodeStatuses,
  gateReasonOf,
} from "@t3tools/client-runtime/workflows";
import * as Schema from "effect/Schema";
import * as Crypto from "expo-crypto";
import { useMemo, useRef, useState, type ComponentRef } from "react";
import { Linking, ScrollView, View } from "react-native";
import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { ListSection } from "../../components/ui/ListSection";
import { Notice } from "../../components/ui/Notice";
import { useNowMinuteMs } from "../../lib/clock";
import { useOpenLinkedThread } from "../../features/threads/useOpenLinkedThread";
import { useAtomCommand } from "../../state/use-atom-command";
import { gateReason } from "@t3tools/shared/workflows";
import { GateAsk } from "./GateAsk";
import { WorkflowGraph } from "./WorkflowGraph";
import { WorkflowGateSheet, WorkflowStepSheet } from "./WorkflowRunSheets";
import { WorkflowStatus } from "./WorkflowStatus";
import { workflowsEnvironment, useWorkflowRun } from "./state";

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeWorkflowRunId = Schema.decodeUnknownOption(WorkflowRunId);

/** Validate deep links before mounting the live run subscription. */
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
      <Notice tone="danger" message="Invalid workflow run link." />
    </View>
  );
}

function RunContent({
  environmentId,
  runId,
}: {
  environmentId: EnvironmentId;
  runId: WorkflowRunId;
}) {
  const query = useWorkflowRun(environmentId, runId);
  const run = query.data;
  const [showPayload, setShowPayload] = useState(false);
  const payload = useEnvironmentQuery(
    showPayload
      ? workflowsEnvironment.runTrigger({ environmentId, input: { runId, maxBytes: 4096 } })
      : null,
  );
  const now = useNowMinuteMs();
  const activeMs = run ? liveActiveMs(run.summary, now) : null;
  const definition = run?.definition;
  const steps = run?.steps;
  const control = useAtomCommand(workflowsEnvironment.runControl);
  const allowed = useAtomValue(workflowsEnvironment.runControl.permissionAtom(environmentId));
  const [pending, setPending] = useState(false);
  const [sheet, setSheet] = useState<
    { kind: "step"; step: WorkflowStepAttemptView } | { kind: "gate"; key: string } | null
  >(null);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const positions = useRef(new Map<string, number>());
  const openThread = useOpenLinkedThread();
  const graph = useMemo(
    () =>
      definition ? withNodeStatuses(toCanvasModel(definition), nodeStatuses(steps ?? [])) : null,
    [definition, steps],
  );
  const pullRequest = run?.summary.pullRequest;
  const rows = useMemo(() => stepRows(steps ?? []), [steps]);
  const gate: WorkflowGateView | undefined =
    sheet?.kind === "gate" ? run?.gates.find((g) => g.key === sheet.key) : undefined;
  const submit = async (action: WorkflowRunControl) => {
    setPending(true);
    await control({
      environmentId,
      input: { runId, control: action, clientRequestId: Crypto.randomUUID() },
    });
    setPending(false);
  };
  return (
    <View className="flex-1 bg-screen">
      <AppBar title={run?.summary.title ?? "Workflow run"} />
      <ScrollView ref={scroll} contentContainerClassName="gap-4 p-4 pb-10">
        {query.error && <Notice tone="danger" message={query.error} />}
        {!run && !query.error && <Text>Loading run…</Text>}
        {run && (
          <>
            <ListSection title="Trigger">
              <View className="gap-2 p-3">
                <Text>
                  {run.trigger.label} · {run.trigger.kind}
                  {run.trigger.test ? " · test event" : ""}
                </Text>
                <ControlPill
                  label="Show payload"
                  variant="pill"
                  onPress={() => setShowPayload(true)}
                />
                {payload.error && <Notice tone="danger" message={payload.error} />}
                {showPayload && !payload.data && !payload.error && <Text>Loading payload…</Text>}
                {payload.data && (
                  <Text selectable>
                    {payload.data.truncated
                      ? "Payload is larger than 4 KiB: open it on desktop."
                      : JSON.stringify(payload.data.payload, null, 2)}
                  </Text>
                )}
              </View>
            </ListSection>
            <WorkflowStatus
              label={runStatusLabel(run.summary.status)}
              tone={runStatusTone(run.summary.status)}
            />
            {(run.summary.pausedFor ?? run.summary.skipReason) && (
              <Notice message={run.summary.pausedFor ?? run.summary.skipReason ?? ""} />
            )}
            {run.warnings?.map((warning) => (
              <Notice key={warning} message={warning} />
            ))}
            <Text>
              {run.summary.trigger.label} · {run.summary.trigger.kind}
              {"\n"}Started {run.summary.startedAt}
              {"\n"}Active duration {activeMs === null ? "unknown" : formatDuration(activeMs)}
              {"\n"}
              {formatTokens(run.summary.cost.billable)} tokens ·{" "}
              {formatUsd(run.summary.cost.usdEstimate)} · {run.summary.cost.usage} usage
            </Text>
            <Text textRole="footnote">Native subagents may add usage outside this total.</Text>
            {pullRequest && (
              <ControlPill
                label="Open PR"
                variant="pill"
                onPress={() => void Linking.openURL(pullRequest)}
              />
            )}
            <View className="flex-row flex-wrap gap-2">
              {run.summary.status === "running" && (
                <ControlPill
                  label="Pause"
                  variant="pill"
                  disabled={pending || !allowed}
                  onPress={() => void submit({ _tag: "pause" })}
                />
              )}
              {run.summary.status === "paused" && (
                <ControlPill
                  label="Resume"
                  variant="primary"
                  disabled={pending || !allowed}
                  onPress={() => void submit({ _tag: "resume" })}
                />
              )}
              {isRunActive(run.summary.status) && (
                <ControlPill
                  label="Cancel"
                  variant="pill"
                  disabled={pending || !allowed}
                  onPress={() => void submit({ _tag: "cancel" })}
                />
              )}
            </View>
            {openGates(run.gates).map((g) => (
              <View
                key={g.key}
                className="gap-2 rounded-xl border border-warning-border bg-warning p-4"
              >
                <GateAsk gate={g} />
                <ControlPill
                  label="Needs you"
                  variant="primary"
                  onPress={() => setSheet({ kind: "gate", key: g.key })}
                />
              </View>
            ))}
            {graph && (
              <WorkflowGraph
                model={graph}
                firedTriggerId={run.trigger.id}
                onPressNode={(node) => {
                  const row = rows.find((candidate) => candidate.node === node);
                  const y = row ? positions.current.get(row.key) : undefined;
                  if (y !== undefined) scroll.current?.scrollTo({ y, animated: true });
                }}
              />
            )}
            <ListSection title="Steps">
              <Text>{rows.length} steps</Text>
            </ListSection>
            {rows.map(({ key, node, latest, attempts }) => {
              const duration = stepDurationMs(latest, now);
              const threadId = latest.threadId;
              return (
                <View
                  key={key}
                  className="gap-2 rounded-xl bg-grouped-card p-3"
                  onLayout={(event) => positions.current.set(key, event.nativeEvent.layout.y)}
                >
                  <Text>
                    {node} · {key} · {attempts.length} attempts
                  </Text>
                  <WorkflowStatus
                    label={stepStatusLabel(latest.status)}
                    tone={stepStatusTone(latest.status)}
                  />
                  <Text>
                    {duration === null ? "Not started" : formatDuration(duration)} ·{" "}
                    {latest.cost ? formatTokens(latest.cost.billable) : "unknown"} tokens ·{" "}
                    {formatUsd(latest.cost?.usdEstimate ?? null)}
                  </Text>
                  {latest.summary && (
                    <Text selectable>
                      {latest.status === "waiting_gate"
                        ? gateReason(latest.summary)
                        : latest.summary}
                    </Text>
                  )}
                  <View className="flex-row flex-wrap gap-2">
                    {threadId && (
                      <ControlPill
                        label="Open thread"
                        variant="pill"
                        onPress={() => openThread({ environmentId, threadId })}
                      />
                    )}
                    <ControlPill
                      label="Details"
                      variant="pill"
                      onPress={() => setSheet({ kind: "step", step: latest })}
                    />
                    {["failed", "lost", "timed_out", "ambiguous"].includes(latest.status) && (
                      <ControlPill
                        label="Retry"
                        variant="pill"
                        disabled={pending || !allowed}
                        onPress={() => void submit({ _tag: "retry", step: key })}
                      />
                    )}
                  </View>
                  {attempts.length > 1 && (
                    <View className="flex-row flex-wrap gap-2">
                      {attempts.map((attempt) => (
                        <ControlPill
                          key={attempt.attempt}
                          label={`#${attempt.attempt} ${stepStatusLabel(attempt.status)}`}
                          variant="pill"
                          onPress={() => setSheet({ kind: "step", step: attempt })}
                        />
                      ))}
                    </View>
                  )}
                </View>
              );
            })}
            {run.blocks.map((block) => (
              <ListSection title={`${block._tag} · ${block.step}`} key={block.step}>
                <View className="gap-2 p-3">
                  {block._tag === "hillclimb" ? (
                    <Text>
                      Round {block.round} · {block.attempts} attempts · {block.roundsWithoutGain}{" "}
                      without gain{"\n"}Origin {block.origin ?? "unknown"}
                      {"\n"}Best {JSON.stringify(block.best)}
                    </Text>
                  ) : block._tag === "arena" ? (
                    <>
                      <Text>
                        Base {block.base ?? "unknown"} · Grafts {block.grafts.join(", ")}
                      </Text>
                      {block.candidates.map((c) => (
                        <Text key={c.id}>
                          {c.id} · {stepStatusLabel(c.status)} · score {c.score ?? "unknown"}
                        </Text>
                      ))}
                    </>
                  ) : block._tag === "graph" ? (
                    block.leaves.map((leaf) => (
                      <Text key={leaf.id}>
                        {leaf.id} · {stepStatusLabel(leaf.status)}
                        {"\n"}Owns {leaf.owns.join(", ")} · Deps {leaf.deps.join(", ")} · Rework{" "}
                        {leaf.rework} · {leaf.sha}
                      </Text>
                    ))
                  ) : (
                    <>
                      <Text>
                        Round {block.round} · {block.verdict ?? "Pending"}
                      </Text>
                      {block.findings.map((f) => (
                        <Text key={f.id}>
                          {f.id} · {f.state} · {f.summary}
                        </Text>
                      ))}
                    </>
                  )}
                </View>
              </ListSection>
            ))}
            {run.gates
              .filter((g) => g.decision !== null)
              .map((g) => (
                <ListSection key={g.key} title="Decided gate">
                  <View className="p-3">
                    <Text>
                      {gateReasonOf(g)}
                      {"\n"}
                      {g.decision?.option} · {g.decision?.at}
                      {"\n"}
                      {g.decision?.note}
                    </Text>
                  </View>
                </ListSection>
              ))}
          </>
        )}
      </ScrollView>
      {sheet?.kind === "step" && (
        <WorkflowStepSheet
          environmentId={environmentId}
          runId={runId}
          step={sheet.step}
          onClose={() => setSheet(null)}
        />
      )}
      {gate && (
        <WorkflowGateSheet
          key={gate.key}
          environmentId={environmentId}
          runId={runId}
          gate={gate}
          summary={
            rows.find((row) => row.key === gate.step && row.latest.status !== "waiting_gate")
              ?.latest.summary ?? null
          }
          pullRequest={run?.summary.pullRequest ?? null}
          onClose={() => setSheet(null)}
        />
      )}
    </View>
  );
}
