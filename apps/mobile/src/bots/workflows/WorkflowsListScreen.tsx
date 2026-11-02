import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId } from "@t3tools/contracts";
import { runStatusLabel } from "@t3tools/client-runtime/workflows";
import { Pressable, ScrollView, View } from "react-native";
import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { relativeTime } from "../../lib/time";
import { useWorkflowRuns, useWorkflowsSnapshot } from "./state";

/** Workflow directory and latest runs on the selected host. */
export function WorkflowsListScreen({ route }: StaticScreenProps<{ environmentId: string }>) {
  const { environmentId } = route.params;
  const env = EnvironmentId.make(environmentId);
  const query = useWorkflowsSnapshot(env);
  const runs = useWorkflowRuns(env, { limit: 20 });
  const navigation = useNavigation();
  return (
    <View className="flex-1 bg-screen">
      <AppBar title="Workflows" />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
        {query.error ? (
          <Text>{query.error}</Text>
        ) : !query.data ? (
          <Text>Loading workflows…</Text>
        ) : query.data.workflows.length === 0 ? (
          <Text>No workflows yet.</Text>
        ) : (
          query.data.workflows.map((workflow) => (
            <Pressable
              key={workflow.workflowId}
              onPress={() =>
                navigation.navigate("BotsWorkflow", {
                  environmentId,
                  workflowId: workflow.workflowId,
                })
              }
            >
              <Text>{workflow.title}</Text>
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
                <Text key={trigger.id}>{trigger.label}</Text>
              ))}
              {workflow.lastRun && (
                <Text>
                  {runStatusLabel(workflow.lastRun.status)} ·{" "}
                  {relativeTime(workflow.lastRun.startedAt)}
                </Text>
              )}
            </Pressable>
          ))
        )}
        <Text>Recent runs</Text>
        {runs.error && <Text>{runs.error}</Text>}
        {runs.data?.runs.map((run) => (
          <Pressable
            key={run.runId}
            onPress={() =>
              navigation.navigate("BotsWorkflowRun", { environmentId, runId: run.runId })
            }
          >
            <Text>
              {run.title} · {runStatusLabel(run.status)} · {relativeTime(run.startedAt)}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}
