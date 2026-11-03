import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "../../../components/ui/table";
import type { EnvironmentId, WorkflowId } from "@t3tools/contracts";
import {
  formatDuration,
  formatTokens,
  formatUsd,
  runStatusLabel,
} from "@t3tools/client-runtime/workflows";
import { Link } from "@tanstack/react-router";
import { useEnvironmentQuery } from "../../../state/query";
import { formatRelativeTimeLabel } from "../../../timestampFormat";
import { workflowsEnvironment } from "../state";
import { useNowMs } from "../WorkflowListRow";
import { RunStatusIcon, RunStatusLabel } from "../WorkflowStatusBadge";

/** Run costs and node failures. */
export function WorkflowMetricsPanel(props: {
  environmentId: EnvironmentId;
  workflowId: WorkflowId;
}) {
  const now = useNowMs();
  const query = useEnvironmentQuery(
    workflowsEnvironment.metrics({
      environmentId: props.environmentId,
      input: { workflowId: props.workflowId },
    }),
  );
  const data = query.data;
  if (!data)
    return (
      <p
        role={query.error ? "alert" : "status"}
        className={query.error ? "text-destructive text-sm" : "text-muted-foreground text-sm"}
      >
        {query.error ?? "Loading metrics…"}
      </p>
    );
  if (data.runs.length === 0 && data.nodes.length === 0)
    return (
      <p className="rounded-lg border border-dashed px-4 py-8 text-center text-muted-foreground text-sm">
        No runs yet. Metrics appear after the first run.
      </p>
    );
  const maximum = Math.max(1, ...data.runs.map((run) => run.billable));
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap gap-2">
        {data.runsByStatus.map((row) => (
          <span
            key={row.status}
            className="inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs"
          >
            <RunStatusIcon status={row.status} />
            {runStatusLabel(row.status)}
            <span className="text-muted-foreground tabular-nums">{row.count}</span>
          </span>
        ))}
      </div>
      <section className="flex flex-col gap-1 tabular-nums">
        <h3 className="font-medium text-muted-foreground text-xs">Runs</h3>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Started</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Active</TableHead>
              <TableHead className="w-1/3">Tokens</TableHead>
              <TableHead className="text-right">Cost</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.runs.map((run) => (
              <TableRow key={run.runId}>
                <TableCell>
                  <Link
                    to="/workflows/$environmentId/runs/$runId"
                    params={{ environmentId: props.environmentId, runId: run.runId }}
                    className="hover:underline"
                  >
                    <time dateTime={run.startedAt}>
                      {formatRelativeTimeLabel(run.startedAt, now)}
                    </time>
                  </Link>
                </TableCell>
                <TableCell>
                  <RunStatusLabel status={run.status} />
                </TableCell>
                <TableCell className="text-right">
                  {run.activeMs === null ? "-" : formatDuration(run.activeMs)}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-2">
                    <span className="w-12 shrink-0 text-right tabular-nums">
                      {formatTokens(run.billable)}
                    </span>
                    <div className="h-1.5 min-w-0 flex-1 rounded-full bg-muted">
                      <div
                        className="h-full rounded-full bg-primary/70"
                        style={{ width: `${(100 * run.billable) / maximum}%` }}
                      />
                    </div>
                  </div>
                </TableCell>
                <TableCell className="text-right">
                  {run.usdEstimate === null ? "-" : formatUsd(run.usdEstimate)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </section>
      {data.nodes.length > 0 ? (
        <section className="flex flex-col gap-1 tabular-nums">
          <h3 className="font-medium text-muted-foreground text-xs">Steps</h3>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Step</TableHead>
                <TableHead className="text-right">Attempts</TableHead>
                <TableHead className="text-right">Failures</TableHead>
                <TableHead className="text-right">Average tokens</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.nodes.map((node) => (
                <TableRow key={node.node}>
                  <TableCell>
                    <span className="font-medium">{node.node}</span>
                  </TableCell>
                  <TableCell className="text-right">{node.attempts}</TableCell>
                  <TableCell className="text-right">
                    <span className={node.failures > 0 ? "text-destructive" : undefined}>
                      {node.failures}
                    </span>
                  </TableCell>
                  <TableCell className="text-right">
                    {node.averageBillable === null ? "-" : formatTokens(node.averageBillable)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      ) : null}
    </div>
  );
}
