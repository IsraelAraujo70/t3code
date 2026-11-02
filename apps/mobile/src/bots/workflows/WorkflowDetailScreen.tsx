import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, WorkflowId } from "@t3tools/contracts";
import { runStatusLabel, toCanvasModel } from "@t3tools/client-runtime/workflows";
import * as Crypto from "expo-crypto";
import { Pressable, ScrollView, Switch, View } from "react-native";
import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { RunNowSheet } from "./RunNowSheet";
import { WorkflowGraph } from "./WorkflowGraph";
import { workflowsEnvironment, useWorkflowDocument, useWorkflowRuns } from "./state";

/** Mobile definition graph, execution entry point and revision history. */
export function WorkflowDetailScreen({
  route,
}: StaticScreenProps<{ environmentId: string; workflowId: string }>) {
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const workflowId = WorkflowId.make(route.params.workflowId);
  const query = useWorkflowDocument(environmentId, workflowId);
  const runs = useWorkflowRuns(environmentId, { workflowId, limit: 10 });
  const history = useEnvironmentQuery(
    workflowsEnvironment.history({ environmentId, input: { workflowId, limit: 10 } }),
  );
  const canEnable = useAtomValue(workflowsEnvironment.setEnabled.permissionAtom(environmentId));
  const canRun = useAtomValue(workflowsEnvironment.runStart.permissionAtom(environmentId));
  const enable = useAtomCommand(workflowsEnvironment.setEnabled);
  const [pending, setPending] = useState(false);
  const [showRun, setShowRun] = useState(false);
  const navigation = useNavigation();
  const document = query.data;
  return (
    <View className="flex-1 bg-screen">
      <AppBar title={document?.definition?.title ?? "Workflow"} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
        {query.error && <Text>{query.error}</Text>}
        {!document ? (
          <Text>Loading workflow…</Text>
        ) : (
          <>
            <Text>
              {document.valid ? "Valid" : "Invalid"}
              {document.dirty ? " · Dirty" : ""}
              {document.suspended ? " · Suspended" : ""}
            </Text>
            <Switch
              accessibilityLabel="Enabled"
              value={document.enabled}
              disabled={pending || !canEnable}
              onValueChange={async (enabled) => {
                setPending(true);
                await enable({
                  environmentId,
                  input: { workflowId, enabled, clientRequestId: Crypto.randomUUID() },
                });
                setPending(false);
              }}
            />
            {document.definition && (
              <>
                <Pressable disabled={!canRun} onPress={() => setShowRun(true)}>
                  <Text>Run now</Text>
                </Pressable>
                <WorkflowGraph model={toCanvasModel(document.definition)} />
                <Text>Triggers</Text>
                {(document.definition.triggers ?? []).map((trigger) => (
                  <Text key={trigger.id}>
                    {trigger.id} · {trigger.kind}
                  </Text>
                ))}
                {showRun && (
                  <RunNowSheet
                    environmentId={environmentId}
                    workflowId={workflowId}
                    definition={document.definition}
                    onClose={() => setShowRun(false)}
                  />
                )}
              </>
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
                  {run.title} · {runStatusLabel(run.status)}
                </Text>
              </Pressable>
            ))}
            <Text>History</Text>
            {history.error && <Text>{history.error}</Text>}
            {history.data?.versions.map((version) => (
              <Text key={version.commit}>
                {version.message} · {version.author} · {version.at}
              </Text>
            ))}
          </>
        )}
      </ScrollView>
    </View>
  );
}
