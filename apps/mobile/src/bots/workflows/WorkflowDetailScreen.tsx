import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { EnvironmentId, WorkflowId } from "@t3tools/contracts";
import { runStatusLabel, runStatusTone, toCanvasModel } from "@t3tools/client-runtime/workflows";
import * as Crypto from "expo-crypto";
import { ScrollView, Switch, View } from "react-native";
import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Chip } from "../../components/ui/Chip";
import { ControlPill } from "../../components/ui/ControlPill";
import { ListSection } from "../../components/ui/ListSection";
import { Notice } from "../../components/ui/Notice";
import { WorkflowEditSheet } from "./WorkflowEditSheet";
import { WorkflowMetricsScreen } from "./WorkflowMetricsScreen";
import { WorkflowStatus } from "./WorkflowStatus";
import { RunNowSheet } from "./RunNowSheet";
import { WorkflowGraph } from "./WorkflowGraph";
import { workflowsEnvironment, useWorkflowDocument, useWorkflowRuns } from "./state";

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeWorkflowId = Schema.decodeUnknownOption(WorkflowId);

/** Mobile definition graph, execution entry point and revision history. */
export function WorkflowDetailScreen({
  route,
}: StaticScreenProps<{ environmentId: string; workflowId: string }>) {
  const environmentId = decodeEnvironmentId(route.params.environmentId);
  const workflowId = decodeWorkflowId(route.params.workflowId);
  return environmentId._tag === "Some" && workflowId._tag === "Some" ? (
    <DetailContent
      key={`${environmentId.value}/${workflowId.value}`}
      environmentId={environmentId.value}
      workflowId={workflowId.value}
    />
  ) : (
    <View className="flex-1 bg-screen">
      <AppBar title="Workflow" />
      <Notice tone="danger" message="Invalid workflow link." />
    </View>
  );
}

function DetailContent({
  environmentId,
  workflowId,
}: {
  environmentId: EnvironmentId;
  workflowId: WorkflowId;
}) {
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
  const [editDocument, setEditDocument] = useState<typeof query.data>(null);
  const canEdit = useAtomValue(workflowsEnvironment.save.permissionAtom(environmentId));
  const navigation = useNavigation();
  const document = query.data;
  return (
    <View className="flex-1 bg-screen">
      <AppBar title={document?.definition?.title ?? "Workflow"} />
      <ScrollView contentContainerStyle={{ padding: 16, gap: 16 }}>
        {query.error && <Notice tone="danger" message={query.error} />}
        {!document ? (
          <Text>Loading workflow…</Text>
        ) : (
          <>
            <View className="flex-row flex-wrap gap-2">
              <WorkflowStatus
                label={document.valid ? "Valid" : "Invalid"}
                tone={document.valid ? "success" : "danger"}
              />
              {document.dirty && <Chip label="Dirty" />}
              {document.suspended && <Chip label="Suspended" />}
            </View>
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
                <View className="flex-row flex-wrap gap-2">
                  <ControlPill
                    label="Run now"
                    variant="primary"
                    disabled={!canRun || !document.valid}
                    onPress={() => setShowRun(true)}
                  />
                  {document.valid && (
                    <ControlPill
                      label="Edit"
                      variant="pill"
                      disabled={!canEdit}
                      onPress={() => setEditDocument(document)}
                    />
                  )}
                </View>
                <WorkflowGraph model={toCanvasModel(document.definition)} />
                <ListSection title="Triggers">
                  {(document.definition.triggers ?? []).map((trigger) => (
                    <Text key={trigger.id}>
                      {trigger.id} · {trigger.kind}
                    </Text>
                  ))}
                </ListSection>
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
                  </View>
                ))}
              </View>
            </ListSection>
            <ListSection title="History">
              {history.error && <Notice tone="danger" message={history.error} />}
              {history.data?.versions.map((version) => (
                <Text key={version.commit}>
                  {version.message} · {version.author} · {version.at}
                </Text>
              ))}
            </ListSection>
            <WorkflowMetricsScreen environmentId={environmentId} workflowId={workflowId} />
          </>
        )}
      </ScrollView>
      {editDocument?.definition && (
        <WorkflowEditSheet
          environmentId={environmentId}
          document={editDocument}
          definition={editDocument.definition}
          onClose={() => setEditDocument(null)}
        />
      )}
    </View>
  );
}
