import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "../../../components/ui/table";
import type { EnvironmentId, WorkflowId } from "@t3tools/contracts";
import { formatDuration, formatTokens, formatUsd } from "@t3tools/client-runtime/workflows";
import { Link } from "@tanstack/react-router";
import { useEnvironmentQuery } from "../../../state/query";
import { workflowsEnvironment } from "../state";
import { RunStatusBadge } from "../WorkflowStatusBadge";
/** Run costs, node failures and emitted metric history. */
export function WorkflowMetricsPanel(props: {
  environmentId: EnvironmentId;
  workflowId: WorkflowId;
}) {
  const query = useEnvironmentQuery(
    workflowsEnvironment.metrics({
      environmentId: props.environmentId,
      input: { workflowId: props.workflowId },
    }),
  );
  const data = query.data;
  if (!data)
    return <p className="text-sm text-muted-foreground">{query.error ?? "Loading metrics…"}</p>;
  const maximum = Math.max(1, ...data.runs.map((run) => run.billable));
  return (
    <div className="space-y-4">
      <h2 className="text-xs font-medium text-muted-foreground">Workflow metrics</h2>
      <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
        {data.runsByStatus.map((row) => (
          <p key={row.status}>
            {row.status}: {row.count}
          </p>
        ))}
      </div>
      <h3 className="text-xs font-medium text-muted-foreground">Runs</h3>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Started</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Active</TableHead>
            <TableHead>Tokens</TableHead>
            <TableHead>USD</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.runs.map((run) => (
            <TableRow key={run.runId}>
              <TableCell>
                <Link
                  to="/workflows/$environmentId/runs/$runId"
                  params={{ environmentId: props.environmentId, runId: run.runId }}
                >
                  {run.startedAt}
                </Link>
              </TableCell>
              <TableCell>
                <RunStatusBadge status={run.status} />
              </TableCell>
              <TableCell>
                {run.activeMs === null ? "unknown" : formatDuration(run.activeMs)}
              </TableCell>
              <TableCell>
                {formatTokens(run.billable)}
                <div
                  className="h-1 bg-primary"
                  style={{ width: `${(100 * run.billable) / maximum}%` }}
                />
              </TableCell>
              <TableCell>{formatUsd(run.usdEstimate)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {data.runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">No runs yet.</p>
      ) : null}
      <h3 className="text-xs font-medium text-muted-foreground">Nodes</h3>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Node</TableHead>
            <TableHead>Attempts</TableHead>
            <TableHead>Failures</TableHead>
            <TableHead>Average tokens</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.nodes.map((node) => (
            <TableRow key={node.node}>
              <TableCell>{node.node}</TableCell>
              <TableCell>{node.attempts}</TableCell>
              <TableCell>{node.failures}</TableCell>
              <TableCell>
                {node.averageBillable === null ? "unknown" : formatTokens(node.averageBillable)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {data.nodes.length === 0 ? (
        <p className="text-sm text-muted-foreground">No node metrics yet.</p>
      ) : null}
      {data.series.length === 0 ? (
        <p className="text-sm text-muted-foreground">No emitted metrics yet.</p>
      ) : null}
      {data.series.map((series) => (
        <section key={series.name} className="space-y-2">
          <h3 className="text-xs font-medium text-muted-foreground">{series.name}</h3>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>At</TableHead>
                <TableHead>Value</TableHead>
                <TableHead>Verdict</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {series.points.map((point) => (
                <TableRow key={`${point.runId}-${point.at}`}>
                  <TableCell>{point.at}</TableCell>
                  <TableCell>{point.value}</TableCell>
                  <TableCell>{point.verdict ?? "Pending"}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {series.points.length === 0 ? (
            <p className="text-sm text-muted-foreground">No readings yet.</p>
          ) : null}
        </section>
      ))}
    </div>
  );
}
