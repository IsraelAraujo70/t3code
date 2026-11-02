import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId, WorkflowId, WorkflowLedgerPage } from "@t3tools/contracts";
import {
  formatDuration,
  formatTokens,
  formatUsd,
  runStatusLabel,
} from "@t3tools/client-runtime/workflows";
import { useState } from "react";
import { View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { Chip } from "../../components/ui/Chip";
import { ControlPill } from "../../components/ui/ControlPill";
import { ListSection } from "../../components/ui/ListSection";
import { Notice } from "../../components/ui/Notice";
import { useEnvironmentQuery } from "../../state/query";
import { workflowsEnvironment } from "./state";

/** Compact per-workflow metrics and a cursor-paginated experiment ledger. */
export function WorkflowMetricsScreen({
  environmentId,
  workflowId,
}: {
  environmentId: EnvironmentId;
  workflowId: WorkflowId;
}) {
  const query = useEnvironmentQuery(
    workflowsEnvironment.metrics({ environmentId, input: { workflowId } }),
  );
  const navigation = useNavigation();
  return (
    <>
      <ListSection title="Metrics">
        <View className="gap-3 p-3">
          {query.error && <Notice tone="danger" message={query.error} />}
          {!query.data && !query.error && <Text>Loading metrics…</Text>}
          {query.data?.runsByStatus.map((row) => (
            <Text key={row.status}>
              {runStatusLabel(row.status)} · {row.count}
            </Text>
          ))}
          {query.data?.runs.map((run) => (
            <View key={run.runId} className="gap-1">
              <Chip
                label={run.runId}
                onPress={() =>
                  navigation.navigate("BotsWorkflowRun", { environmentId, runId: run.runId })
                }
              />
              <Text>
                {run.startedAt} · {runStatusLabel(run.status)} ·{" "}
                {run.activeMs === null ? "unknown" : formatDuration(run.activeMs)} ·{" "}
                {formatTokens(run.billable)} tokens · {formatUsd(run.usdEstimate)}
              </Text>
            </View>
          ))}
          {query.data?.nodes.map((node) => (
            <Text key={node.node}>
              {node.node} · {node.failures}/{node.attempts} failures · average{" "}
              {node.averageBillable === null ? "unknown" : formatTokens(node.averageBillable)}{" "}
              tokens
            </Text>
          ))}
        </View>
      </ListSection>
      <ListSection title="Ledger">
        <View className="gap-3 p-3">
          <LedgerPage environmentId={environmentId} workflowId={workflowId} />
        </View>
      </ListSection>
    </>
  );
}

function LedgerPage({
  environmentId,
  workflowId,
  cursor,
}: {
  environmentId: EnvironmentId;
  workflowId: WorkflowId;
  cursor?: NonNullable<WorkflowLedgerPage["nextCursor"]>;
}) {
  const query = useEnvironmentQuery(
    workflowsEnvironment.ledger({
      environmentId,
      input: { workflowId, ...(cursor ? { cursor } : {}), limit: 20 },
    }),
  );
  const [nextCursor, setNextCursor] = useState<WorkflowLedgerPage["nextCursor"]>(null);
  const navigation = useNavigation();
  return (
    <>
      {query.error && <Notice tone="danger" message={query.error} />}
      {!query.data && !query.error && <Text>Loading ledger…</Text>}
      {query.data?.entries.length === 0 && <Text>No ledger entries.</Text>}
      {query.data?.entries.map((entry) => (
        <View key={`${entry.ledger}/${entry.key}`} className="gap-2">
          <Text selectable>
            {entry.hypothesis}
            {"\n"}
            {entry.before?.objective ?? "unknown"} → {entry.after?.objective ?? "unknown"}
            {"\n"}
            {JSON.stringify(entry.before?.values ?? {})} →{" "}
            {JSON.stringify(entry.after?.values ?? {})}
            {"\n"}
            {entry.verdict ?? "Pending"} · {entry.sha ?? "No sha"}
            {"\n"}
            {entry.note}
          </Text>
          <Chip
            label="Open run"
            onPress={() =>
              navigation.navigate("BotsWorkflowRun", { environmentId, runId: entry.runId })
            }
          />
        </View>
      ))}
      {nextCursor ? (
        <LedgerPage environmentId={environmentId} workflowId={workflowId} cursor={nextCursor} />
      ) : query.data?.nextCursor && query.data.nextCursor !== cursor ? (
        <ControlPill
          label="Load more"
          variant="pill"
          onPress={() => setNextCursor(query.data?.nextCursor ?? null)}
        />
      ) : null}
    </>
  );
}
