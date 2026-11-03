import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  activeWorkflowRuns,
  filterWorkflows,
  parseWorkflowsSearch,
  runHistoryKey,
  runMatchesListInput,
  runsFilterInput,
  workflowsFilterOptions,
  workflowsFiltersOf,
  workflowsTabOf,
  type WorkflowsFilters,
  type WorkflowsTab,
} from "@t3tools/client-runtime/workflows";
import {
  EnvironmentId,
  type WorkflowRunSummary,
  type WorkflowSummary,
  type WorkflowsSnapshot,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Crypto from "expo-crypto";
import { useState, type ReactElement } from "react";
import { FlatList, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Chip } from "../../components/ui/Chip";
import { EmptyState } from "../../components/ui/EmptyState";
import type { MenuProps } from "../../components/ui/Menu.types";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { ListFilterMenu } from "../../features/workspace/ListFilterMenu";
import { useNowMinuteMs } from "../../lib/clock";
import { useDebouncedValue } from "../../state/queries";
import { useAtomCommand } from "../../state/use-atom-command";
import { GateSheet } from "./GatePanel";
import { NeedsYouCard, RunRow, WorkflowRow } from "./WorkflowRows";
import { useLiveWorkflowRuns, useWorkflowsSnapshot, workflowsEnvironment } from "./state";
import {
  activeFilterCount,
  applyFilterChoice,
  filterPills,
  isFiltered,
  RESET_FILTERS_ID,
} from "./workflowsScreen.logic";

const decodeEnvironmentId = Schema.decodeUnknownOption(EnvironmentId);

/** The web page's search params, so a link or another screen can open a tab with filters. */
type WorkflowsRouteParams = {
  environmentId: string;
  tab?: string;
  bot?: string;
  trigger?: string;
  q?: string;
  on?: string;
  workflow?: string;
  status?: string;
  period?: string;
};
const PAGE_SIZE = 50;
/** The run list's largest page (`PageLimit` in the contract). */
const MAX_RUNS = 200;

/**
 * Workflows on the bots host: what needs the user on top, then the workflows and their runs as
 * two tabs with the web's filters. `tab`, `workflow`, `status` and the other web search params
 * open it on a tab and filters.
 */
export function WorkflowsListScreen({ route }: StaticScreenProps<WorkflowsRouteParams>) {
  const env = decodeEnvironmentId(route.params.environmentId);
  const search = parseWorkflowsSearch(route.params);
  return env._tag === "Some" ? (
    <ListContent
      environmentId={env.value}
      initialTab={workflowsTabOf(search)}
      initialFilters={workflowsFiltersOf(search)}
    />
  ) : (
    <View className="flex-1 bg-screen">
      <AppBar title="Workflows" />
      <EmptyState
        title="Invalid link"
        detail="This workflows link names no host."
        variant="plain"
      />
    </View>
  );
}

function ListContent(props: {
  environmentId: EnvironmentId;
  initialTab: WorkflowsTab;
  initialFilters: WorkflowsFilters;
}) {
  const { environmentId } = props;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const snapshot = useWorkflowsSnapshot(environmentId);
  const [tab, setTab] = useState(props.initialTab);
  const [filters, setFilters] = useState(props.initialFilters);
  const [answering, setAnswering] = useState<WorkflowRunSummary | null>(null);
  const nowMs = useNowMinuteMs();
  const data = snapshot.data;
  const workflows = data?.workflows ?? [];
  const needsYou = data ? activeWorkflowRuns(data).filter((item) => item.needsYou) : [];
  const shownWorkflows = filterWorkflows(workflows, filters);
  const pills = filterPills(tab, filters, workflowsFilterOptions(workflows));
  const filterCount = activeFilterCount(tab, filters);
  const openRun = (run: WorkflowRunSummary) =>
    navigation.navigate("BotsWorkflowRun", { environmentId, runId: run.runId });
  const openWorkflow = (workflow: WorkflowSummary, run?: boolean) =>
    navigation.navigate("BotsWorkflow", {
      environmentId,
      workflowId: workflow.workflowId,
      ...(run ? { run: "1" } : {}),
    });
  const header = (
    <View className="gap-3 pt-3">
      {needsYou.length > 0 ? (
        <View className="gap-2 px-3">
          <Text className="px-1 text-sm font-t3-bold text-foreground">
            Needs you · {needsYou.length}
          </Text>
          {needsYou.map((item) => (
            <NeedsYouCard
              key={item.run.runId}
              item={item}
              nowMs={nowMs}
              onAnswer={setAnswering}
              onOpen={openRun}
            />
          ))}
        </View>
      ) : null}
      <View className="px-3">
        <SegmentedControl
          options={[
            { value: "workflows", label: data ? `Workflows · ${workflows.length}` : "Workflows" },
            { value: "runs", label: "Runs" },
          ]}
          selected={tab}
          onSelect={setTab}
          role="tab"
          size="compact"
        />
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 12, paddingBottom: 4, gap: 8 }}
        keyboardShouldPersistTaps="handled"
      >
        {pills.map((pill) => (
          <ListFilterMenu
            key={pill.key}
            label={pill.label}
            active={pill.active}
            accessibilityLabel={pill.accessibilityLabel}
            actions={pill.actions as MenuProps["actions"]}
            onSelect={(id) => setFilters((current) => applyFilterChoice(tab, current, id))}
          />
        ))}
        {filterCount > 0 ? (
          <Chip
            label="Clear"
            icon="xmark"
            accessibilityLabel={`Clear ${filterCount} filters`}
            onPress={() =>
              setFilters((current) => applyFilterChoice(tab, current, RESET_FILTERS_ID))
            }
          />
        ) : null}
      </ScrollView>
    </View>
  );
  return (
    <View className="flex-1 bg-header" style={{ paddingBottom: insets.bottom }}>
      <AppBar
        title="Workflows"
        search={{
          value: filters.query,
          onChangeText: (query) => setFilters((current) => ({ ...current, query })),
          placeholder: tab === "workflows" ? "Search workflows" : "Search runs",
          mode: "collapsible",
        }}
      />
      <ScreenContent>
        {snapshot.error && !data ? (
          <EmptyState title="Couldn't load workflows" detail={snapshot.error} variant="plain" />
        ) : !data ? (
          <View className="flex-1 items-center justify-center">
            <AppActivityIndicator colorClassName="accent-icon" accessibilityLabel="Loading" />
          </View>
        ) : tab === "workflows" ? (
          <WorkflowsTabList
            environmentId={environmentId}
            header={header}
            workflows={shownWorkflows}
            empty={
              isFiltered(tab, filters)
                ? { title: "No matching workflows", detail: "Change or clear the filters." }
                : {
                    title: "No workflows yet",
                    detail: "Create one in T3 Code on your computer, from a template or blank.",
                  }
            }
            onOpen={openWorkflow}
          />
        ) : (
          <RunsTabList
            environmentId={environmentId}
            snapshot={data}
            filters={filters}
            nowMs={nowMs}
            header={header}
            onOpen={openRun}
          />
        )}
      </ScreenContent>
      {answering ? (
        <GateSheet
          key={answering.runId}
          environmentId={environmentId}
          runId={answering.runId}
          title={answering.title}
          onOpenRun={() => {
            setAnswering(null);
            openRun(answering);
          }}
          onClose={() => setAnswering(null)}
        />
      ) : null}
    </View>
  );
}

function WorkflowsTabList(props: {
  environmentId: EnvironmentId;
  header: ReactElement;
  workflows: ReadonlyArray<WorkflowSummary>;
  empty: { title: string; detail: string };
  onOpen: (workflow: WorkflowSummary, run?: boolean) => void;
}) {
  const setEnabled = useAtomCommand(workflowsEnvironment.setEnabled);
  const canEnable = useAtomValue(
    workflowsEnvironment.setEnabled.permissionAtom(props.environmentId),
  );
  const canRun = useAtomValue(workflowsEnvironment.runStart.permissionAtom(props.environmentId));
  const actionsFor = (workflow: WorkflowSummary): MenuProps["actions"] => [
    {
      id: "run",
      title: "Run now…",
      attributes: {
        disabled:
          !canRun ||
          !workflow.valid ||
          !workflow.triggers.some((trigger) => trigger.kind === "manual"),
      },
    },
    {
      id: "toggle",
      title: workflow.enabled ? "Turn off" : "Turn on",
      attributes: { disabled: !canEnable },
    },
    { id: "open", title: "Open" },
  ];
  const onAction = (workflow: WorkflowSummary, action: string) => {
    if (action === "open") props.onOpen(workflow);
    else if (action === "run") props.onOpen(workflow, true);
    else if (action === "toggle")
      void setEnabled({
        environmentId: props.environmentId,
        input: {
          workflowId: workflow.workflowId,
          enabled: !workflow.enabled,
          clientRequestId: Crypto.randomUUID(),
        },
      });
  };
  return (
    <FlatList
      data={props.workflows}
      keyExtractor={(workflow) => workflow.workflowId}
      ListHeaderComponent={props.header}
      renderItem={({ item }) => (
        <WorkflowRow
          workflow={item}
          onPress={props.onOpen}
          actions={actionsFor(item)}
          onAction={onAction}
        />
      )}
      ListEmptyComponent={
        <View className="py-6">
          <EmptyState title={props.empty.title} detail={props.empty.detail} variant="plain" />
        </View>
      }
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingBottom: 24 }}
    />
  );
}

/**
 * Runs matching the filters, newest first, from the host's filtered list. "Load more" grows one
 * query by a page, so a run that starts meanwhile never duplicates a row at a page boundary.
 */
function RunsTabList(props: {
  environmentId: EnvironmentId;
  snapshot: WorkflowsSnapshot;
  filters: WorkflowsFilters;
  nowMs: number;
  header: ReactElement;
  onOpen: (run: WorkflowRunSummary) => void;
}) {
  const [limit, setLimit] = useState(PAGE_SIZE);
  const query = useDebouncedValue(props.filters.query, 250);
  const filter = runsFilterInput(
    { ...props.filters, query },
    props.snapshot.workflows,
    props.nowMs,
  );
  const historyKey = runHistoryKey(props.snapshot);
  const runs = useLiveWorkflowRuns(props.environmentId, { ...filter, limit }, historyKey);
  // The shorter list stays on screen while the longer one loads.
  const shorter = useLiveWorkflowRuns(
    props.environmentId,
    { ...filter, limit: Math.max(PAGE_SIZE, limit - PAGE_SIZE) },
    historyKey,
  );
  const page = runs.data ?? shorter.data;
  const workflows = new Map(props.snapshot.workflows.map((w) => [w.workflowId as string, w]));
  // An older host ignores the filters it does not know.
  const shown = page?.runs.filter((run) => runMatchesListInput(run, filter)) ?? [];
  const more = page?.nextCursor != null;
  const filtered = isFiltered("runs", props.filters);
  return (
    <FlatList
      data={shown}
      keyExtractor={(run) => run.runId}
      ListHeaderComponent={props.header}
      renderItem={({ item }) => (
        <RunRow
          run={item}
          workflow={workflows.get(item.workflowId) ?? null}
          showWorkflow
          nowMs={props.nowMs}
          onPress={props.onOpen}
        />
      )}
      ListEmptyComponent={
        page === null ? (
          runs.error ? (
            <View className="py-6">
              <EmptyState
                title="Couldn't load runs"
                detail={runs.error}
                actionLabel="Try again"
                onAction={runs.refresh}
                variant="plain"
              />
            </View>
          ) : (
            <View className="items-center py-12">
              <AppActivityIndicator
                colorClassName="accent-icon"
                accessibilityLabel="Loading runs"
              />
            </View>
          )
        ) : more ? undefined : (
          <View className="py-6">
            <EmptyState
              title={filtered ? "No matching runs" : "No runs yet"}
              detail={
                filtered
                  ? "Change or clear the filters."
                  : "Runs appear here when a trigger fires or you press Run now."
              }
              variant="plain"
            />
          </View>
        )
      }
      ListFooterComponent={
        more ? (
          <View className="items-center gap-2 px-8 py-4">
            {runs.error && runs.data === null ? (
              <>
                <Text className="text-center text-xs text-foreground-muted">{runs.error}</Text>
                <Button label="Try again" onPress={runs.refresh} />
              </>
            ) : limit < MAX_RUNS ? (
              <Button
                label="Load more"
                loading={runs.data === null}
                onPress={() => setLimit(limit + PAGE_SIZE)}
              />
            ) : (
              <Text className="text-center text-xs text-foreground-muted">
                Showing the latest {MAX_RUNS} runs. Narrow the filters to reach older ones.
              </Text>
            )}
          </View>
        ) : undefined
      }
      keyboardDismissMode="on-drag"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingBottom: 24 }}
    />
  );
}
