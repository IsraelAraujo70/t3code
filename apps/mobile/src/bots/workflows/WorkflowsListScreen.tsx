import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import * as Schema from "effect/Schema";
import { EnvironmentId } from "@t3tools/contracts";
import {
  activeWorkflowRuns,
  describeTrigger,
  runHistoryKey,
  runStatusLabel,
  runStatusTone,
} from "@t3tools/client-runtime/workflows";
import { useEffect, useRef } from "react";
import { ScrollView, View } from "react-native";
import { BotAvatar } from "../BotAvatar";
import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { Chip } from "../../components/ui/Chip";
import { ListSection } from "../../components/ui/ListSection";
import { Notice } from "../../components/ui/Notice";
import { WorkflowStatus } from "./WorkflowStatus";
import { relativeTime } from "../../lib/time";
import { useWorkflowRuns, useWorkflowsSnapshot } from "./state";

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const LOCAL_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Workflow directory and latest runs on the selected host. */
export function WorkflowsListScreen({ route }: StaticScreenProps<{ environmentId: string }>) {
  const env = decodeEnvironmentId(route.params.environmentId);
  return env._tag === "Some" ? (
    <ListContent environmentId={env.value} />
  ) : (
    <View className="flex-1 bg-screen">
      <AppBar title="Workflows" />
      <Notice tone="danger" message="Invalid environment link." />
    </View>
  );
}

function ListContent({ environmentId }: { environmentId: EnvironmentId }) {
  const env = environmentId;
  const query = useWorkflowsSnapshot(env);
  const runs = useWorkflowRuns(env, { limit: 20 });
  const navigation = useNavigation();
  const lastRuns = query.data === null ? null : runHistoryKey(query.data);
  const active = query.data === null ? [] : activeWorkflowRuns(query.data);
  const seenLastRuns = useRef<string | null>(null);
  const refreshRuns = runs.refresh;
  const runsPending = runs.isPending;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refetches the one-shot run list when the snapshot stream reports a run that started, stopped at a gate or ended
  useEffect(() => {
    // A request already in flight may have read before the change, so wait and refetch after it.
    if (lastRuns === null || seenLastRuns.current === lastRuns || runsPending) return;
    seenLastRuns.current = lastRuns;
    refreshRuns();
  }, [lastRuns, refreshRuns, runsPending]);
  return (
    <View className="flex-1 bg-screen">
      <AppBar title="Workflows" />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
        {active.length > 0 ? (
          <ListSection title="Active">
            <View className="gap-3 p-3">
              {active.map(({ run, workflow, needsYou, since }) => (
                <View
                  key={run.runId}
                  className={needsYou ? "gap-1.5 rounded-xl bg-warning p-3" : "gap-1.5"}
                >
                  <View className="flex-row items-center gap-1.5">
                    {workflow?.bot ? <BotAvatar botId={workflow.bot.id} size={14} /> : null}
                    <Text className="flex-1 font-t3-medium" numberOfLines={1}>
                      {run.title}
                    </Text>
                    <Text className="text-xs text-foreground-muted">{relativeTime(since)}</Text>
                  </View>
                  {needsYou ? (
                    <Text className="text-sm text-warning-foreground" numberOfLines={2}>
                      {run.gate?.reason ?? "Needs you"}
                    </Text>
                  ) : (
                    <WorkflowStatus
                      label={runStatusLabel(run.status)}
                      tone={runStatusTone(run.status)}
                    />
                  )}
                  <View className="flex-row">
                    <Chip
                      label={needsYou ? "Answer" : "Open run"}
                      onPress={() =>
                        navigation.navigate("BotsWorkflowRun", { environmentId, runId: run.runId })
                      }
                    />
                  </View>
                </View>
              ))}
            </View>
          </ListSection>
        ) : null}
        {query.error ? (
          <Notice tone="danger" message={query.error} />
        ) : !query.data ? (
          <Text>Loading workflows…</Text>
        ) : query.data.workflows.length === 0 ? (
          <Text>No workflows yet.</Text>
        ) : (
          query.data.workflows.map((workflow) => (
            <ListSection key={workflow.workflowId} title={workflow.title}>
              <View className="gap-2 p-3">
                <Chip
                  label="Open workflow"
                  onPress={() =>
                    navigation.navigate("BotsWorkflow", {
                      environmentId,
                      workflowId: workflow.workflowId,
                    })
                  }
                />
                {workflow.bot ? (
                  <View className="flex-row items-center gap-1.5">
                    <BotAvatar botId={workflow.bot.id} size={14} />
                    <Text className="text-xs text-foreground-muted">
                      {workflow.bot.name ?? `${workflow.bot.id} (deleted)`}
                    </Text>
                  </View>
                ) : null}
                <Text>
                  {workflow.enabled ? "Enabled" : "Disabled"} ·{" "}
                  {workflow.suspended
                    ? "Suspended"
                    : workflow.dirty
                      ? "Dirty"
                      : workflow.valid
                        ? "Valid"
                        : "Invalid"}{" "}
                  · {workflow.lastRun?.openGates ?? 0} open gates
                </Text>
                {workflow.triggers.map((trigger) => (
                  <Text key={trigger.id}>
                    {describeTrigger(trigger, LOCAL_TIME_ZONE).text}
                    {trigger.enabled === false ? " (off)" : ""}
                  </Text>
                ))}
                {workflow.lastRun && (
                  <View className="gap-1">
                    <WorkflowStatus
                      label={runStatusLabel(workflow.lastRun.status)}
                      tone={runStatusTone(workflow.lastRun.status)}
                    />
                    <Text>{relativeTime(workflow.lastRun.startedAt)}</Text>
                  </View>
                )}
              </View>
            </ListSection>
          ))
        )}
        <ListSection title="Recent runs">
          <View className="gap-3 p-3">
            {runs.error && <Notice tone="danger" message={runs.error} />}
            {runs.data?.runs.map((run) => (
              <View key={run.runId} className="gap-1">
                <Chip
                  label={run.title}
                  onPress={() =>
                    navigation.navigate("BotsWorkflowRun", { environmentId, runId: run.runId })
                  }
                />
                <WorkflowStatus
                  label={runStatusLabel(run.status)}
                  tone={runStatusTone(run.status)}
                />
                <Text>{relativeTime(run.startedAt)}</Text>
              </View>
            ))}
          </View>
        </ListSection>
      </ScrollView>
    </View>
  );
}
