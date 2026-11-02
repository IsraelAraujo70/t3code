import type { StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, WorkflowRunId } from "@t3tools/contracts";
import { runStatusLabel } from "@t3tools/client-runtime/workflows";
import { View } from "react-native";
import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { useWorkflowRun } from "./state";

/** Run entry point; the run-detail leaf expands this screen. */
export function WorkflowRunScreen({
  route,
}: StaticScreenProps<{ environmentId: string; runId: string }>) {
  const query = useWorkflowRun(
    EnvironmentId.make(route.params.environmentId),
    WorkflowRunId.make(route.params.runId),
  );
  return (
    <View className="flex-1 bg-screen">
      <AppBar title={query.data?.summary.title ?? "Workflow run"} />
      <Text>
        {query.error ?? (query.data ? runStatusLabel(query.data.summary.status) : "Loading run…")}
      </Text>
    </View>
  );
}
