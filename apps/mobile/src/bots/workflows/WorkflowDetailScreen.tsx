import { useAtomValue } from "@effect/atom-react";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  describeTrigger,
  runHistoryKey,
  toCanvasModel,
  type WorkflowRunsFilterInput,
} from "@t3tools/client-runtime/workflows";
import {
  EnvironmentId,
  WorkflowId,
  type WorkflowDocument,
  type WorkflowRunSummary,
  type WorkflowTriggerSummary,
} from "@t3tools/contracts";
import * as Clipboard from "expo-clipboard";
import * as Crypto from "expo-crypto";
import * as Schema from "effect/Schema";
import { useState } from "react";
import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListSection } from "../../components/ui/ListSection";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { Notice } from "../../components/ui/Notice";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { useNowMinuteMs } from "../../lib/clock";
import { relativeTime } from "../../lib/time";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { BotAvatar } from "../BotAvatar";
import { Disclosure } from "./Disclosure";
import { RunNowSheet } from "./RunNowSheet";
import { WorkflowEditSheet } from "./WorkflowEditSheet";
import { WorkflowGraph } from "./WorkflowGraph";
import { WorkflowMetricsScreen } from "./WorkflowMetricsScreen";
import { RunRow } from "./WorkflowRows";
import {
  useLiveWorkflowRuns,
  useWorkflowDocument,
  useWorkflowsSnapshot,
  workflowsEnvironment,
} from "./state";
import { runNowBlocker } from "./workflowsScreen.logic";

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);
const decodeWorkflowId = Schema.decodeUnknownOption(WorkflowId);
const LOCAL_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;
const RECENT_RUNS = 10;

/**
 * One workflow, in the order a phone uses it: the switch and Run now, what triggers it, its runs
 * live, then the graph, metrics and history folded. `run: "1"` opens Run now on arrival.
 */
export function WorkflowDetailScreen({
  route,
}: StaticScreenProps<{ environmentId: string; workflowId: string; run?: string }>) {
  const environmentId = decodeEnvironmentId(route.params.environmentId);
  const workflowId = decodeWorkflowId(route.params.workflowId);
  return environmentId._tag === "Some" && workflowId._tag === "Some" ? (
    <DetailContent
      key={`${environmentId.value}/${workflowId.value}`}
      environmentId={environmentId.value}
      workflowId={workflowId.value}
      runOnOpen={route.params.run === "1"}
    />
  ) : (
    <View className="flex-1 bg-screen">
      <AppBar title="Workflow" />
      <EmptyState title="Invalid link" detail="This workflow link is malformed." variant="plain" />
    </View>
  );
}

function DetailContent(props: {
  environmentId: EnvironmentId;
  workflowId: WorkflowId;
  runOnOpen: boolean;
}) {
  const { environmentId, workflowId } = props;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const query = useWorkflowDocument(environmentId, workflowId);
  const snapshot = useWorkflowsSnapshot(environmentId);
  const summary = snapshot.data?.workflows.find((w) => w.workflowId === workflowId) ?? null;
  const canEnable = useAtomValue(workflowsEnvironment.setEnabled.permissionAtom(environmentId));
  const canRun = useAtomValue(workflowsEnvironment.runStart.permissionAtom(environmentId));
  const canEdit = useAtomValue(workflowsEnvironment.save.permissionAtom(environmentId));
  const enable = useAtomCommand(workflowsEnvironment.setEnabled);
  const [pending, setPending] = useState(false);
  const [showRun, setShowRun] = useState(props.runOnOpen);
  const [editDocument, setEditDocument] = useState<WorkflowDocument | null>(null);
  const document = query.data;
  const setSwitch = async (enabled: boolean, triggerId?: string) => {
    setPending(true);
    await enable({
      environmentId,
      input: {
        workflowId,
        ...(triggerId ? { triggerId } : {}),
        enabled,
        clientRequestId: Crypto.randomUUID(),
      },
    });
    setPending(false);
  };
  const blocker = document ? runNowBlocker(document, canRun) : null;
  return (
    <View className="flex-1 bg-header" style={{ paddingBottom: insets.bottom }}>
      <AppBar
        title={document?.definition?.title ?? summary?.title ?? "Workflow"}
        subtitle={summary?.bot ? (summary.bot.name ?? `${summary.bot.id} (deleted)`) : undefined}
        avatar={summary?.bot ? <BotAvatar botId={summary.bot.id} size={28} /> : undefined}
        actions={
          document?.valid && canEdit
            ? [
                {
                  accessibilityLabel: "Edit workflow",
                  icon: "pencil",
                  onPress: () => setEditDocument(document),
                },
              ]
            : undefined
        }
      />
      <ScreenContent>
        {query.error && !document ? (
          <EmptyState title="Couldn't load the workflow" detail={query.error} variant="plain" />
        ) : !document ? (
          <View className="flex-1 items-center justify-center">
            <AppActivityIndicator colorClassName="accent-icon" accessibilityLabel="Loading" />
          </View>
        ) : (
          <ScrollView contentContainerClassName="gap-5 p-3 pb-10">
            {summary?.description ? (
              <Text className="px-1 text-sm leading-5 text-foreground-muted">
                {summary.description}
              </Text>
            ) : null}
            {!document.valid ? (
              <Notice
                tone="danger"
                message={`This workflow does not compile (${document.diagnostics.length} problems). Fix it on desktop.`}
              />
            ) : null}
            {document.suspended ? (
              <Notice message="Suspended after too many failures in a row. Its triggers stay off until it is resumed on desktop." />
            ) : null}
            {document.dirty ? (
              <Notice message="The file on the host has edits that are not saved as a version yet." />
            ) : null}
            <ListSection>
              <ListToggleRow
                label="On"
                description={
                  document.enabled ? "Its triggers start runs." : "Off: only Run now starts it."
                }
                value={document.enabled}
                disabled={pending || !canEnable}
                onValueChange={(enabled) => void setSwitch(enabled)}
              />
              <View className="gap-2 px-4 pb-4">
                <Button
                  label="Run now"
                  icon="play"
                  tone="primary"
                  fullWidth
                  disabled={blocker !== null}
                  onPress={() => setShowRun(true)}
                />
                {blocker ? (
                  <Text className="text-center text-xs text-foreground-muted">{blocker}</Text>
                ) : null}
              </View>
            </ListSection>
            <ListSection title="Triggers">
              {document.triggers.length === 0 ? (
                <Text className="p-4 text-sm text-foreground-muted">No triggers.</Text>
              ) : (
                document.triggers.map((trigger) => (
                  <TriggerRow
                    key={trigger.id}
                    trigger={trigger}
                    disabled={pending || !canEnable}
                    onSwitch={(enabled) => void setSwitch(enabled, trigger.id)}
                  />
                ))
              )}
            </ListSection>
            <RecentRuns
              environmentId={environmentId}
              historyKey={snapshot.data ? runHistoryKey(snapshot.data) : null}
              filter={{ workflowIds: [workflowId] }}
              onOpen={(run) =>
                navigation.navigate("BotsWorkflowRun", { environmentId, runId: run.runId })
              }
              onAll={() =>
                navigation.dispatch(
                  StackActions.push("BotsWorkflows", {
                    environmentId,
                    tab: "runs",
                    workflow: workflowId,
                  }),
                )
              }
            />
            {document.definition ? (
              <Disclosure title="Graph" detail="The steps and how they connect">
                <WorkflowGraph model={toCanvasModel(document.definition)} />
              </Disclosure>
            ) : null}
            <Disclosure title="Metrics" detail="Runs by status, cost per step, ledger">
              <WorkflowMetricsScreen environmentId={environmentId} workflowId={workflowId} />
            </Disclosure>
            <Disclosure
              title="History"
              detail={
                document.updatedAt
                  ? `Last saved ${relativeTime(document.updatedAt)} ago${document.updatedBy ? ` by ${document.updatedBy}` : ""}`
                  : undefined
              }
            >
              <History environmentId={environmentId} workflowId={workflowId} />
            </Disclosure>
          </ScrollView>
        )}
      </ScreenContent>
      {showRun && document?.definition && blocker === null ? (
        <RunNowSheet
          environmentId={environmentId}
          workflowId={workflowId}
          definition={document.definition}
          onClose={() => setShowRun(false)}
        />
      ) : null}
      {editDocument?.definition ? (
        <WorkflowEditSheet
          environmentId={environmentId}
          document={editDocument}
          definition={editDocument.definition}
          onClose={() => setEditDocument(null)}
        />
      ) : null}
    </View>
  );
}

function TriggerRow(props: {
  trigger: WorkflowTriggerSummary;
  disabled: boolean;
  onSwitch: (enabled: boolean) => void;
}) {
  const { trigger } = props;
  const text = describeTrigger(trigger, LOCAL_TIME_ZONE);
  const lastEvent = trigger.lastFiredAt
    ? `Last event ${relativeTime(trigger.lastFiredAt)} ago`
    : null;
  const description = [text.detail || null, lastEvent].filter(Boolean).join(" · ") || undefined;
  return (
    <View>
      {trigger.kind === "manual" ? (
        <View className="px-4 py-3">
          <Text className="text-base text-foreground">{text.text}</Text>
          {description ? (
            <Text className="text-xs text-foreground-muted">{description}</Text>
          ) : null}
        </View>
      ) : (
        <ListToggleRow
          label={text.text}
          description={description}
          value={trigger.enabled}
          disabled={props.disabled}
          onValueChange={props.onSwitch}
        />
      )}
      {trigger.kind === "webhook" && trigger.webhookUrl ? (
        <View className="flex-row items-center gap-2 px-4 pb-3">
          <Text
            className="min-w-0 flex-1 text-xs text-foreground-muted"
            numberOfLines={1}
            selectable
          >
            {trigger.webhookUrl}
          </Text>
          <Button
            label="Copy URL"
            tone="text"
            onPress={() => void Clipboard.setStringAsync(trigger.webhookUrl!)}
          />
        </View>
      ) : null}
    </View>
  );
}

/** A workflow's latest runs, live, with the way to all of them in the Runs tab. */
function RecentRuns(props: {
  environmentId: EnvironmentId;
  historyKey: string | null;
  filter: WorkflowRunsFilterInput;
  onOpen: (run: WorkflowRunSummary) => void;
  onAll: () => void;
}) {
  const nowMs = useNowMinuteMs();
  const runs = useLiveWorkflowRuns(
    props.environmentId,
    { ...props.filter, limit: RECENT_RUNS },
    props.historyKey,
  );
  const list = runs.data?.runs ?? [];
  return (
    <ListSection
      title="Runs"
      trailing={
        list.length > 0 ? <Button label="See all" tone="text" onPress={props.onAll} /> : undefined
      }
    >
      {runs.error && !runs.data ? (
        <Text className="p-4 text-sm text-danger-foreground">{runs.error}</Text>
      ) : !runs.data ? (
        <View className="items-center py-6">
          <AppActivityIndicator colorClassName="accent-icon" accessibilityLabel="Loading runs" />
        </View>
      ) : list.length === 0 ? (
        <Text className="p-4 text-sm text-foreground-muted">
          No runs yet. Press Run now to try it.
        </Text>
      ) : (
        list.map((run) => (
          <RunRow
            key={run.runId}
            run={run}
            workflow={null}
            showWorkflow={false}
            nowMs={nowMs}
            onPress={props.onOpen}
          />
        ))
      )}
    </ListSection>
  );
}

function History(props: { environmentId: EnvironmentId; workflowId: WorkflowId }) {
  const history = useEnvironmentQuery(
    workflowsEnvironment.history({
      environmentId: props.environmentId,
      input: { workflowId: props.workflowId, limit: 10 },
    }),
  );
  if (history.error) return <Text className="text-sm text-danger-foreground">{history.error}</Text>;
  if (!history.data) return <AppActivityIndicator colorClassName="accent-icon" />;
  return (
    <>
      {history.data.versions.map((version) => (
        <View key={version.commit} className="gap-0.5">
          <Text className="text-sm text-foreground">{version.message}</Text>
          <Text className="text-xs text-foreground-muted">
            {version.author} · {relativeTime(version.at)} ago
          </Text>
        </View>
      ))}
    </>
  );
}
