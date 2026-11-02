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
  if (!data) return <p>{query.error ?? "Loading metrics…"}</p>;
  const maximum = Math.max(1, ...data.runs.map((run) => run.billable));
  return (
    <div className="space-y-4">
      {data.runsByStatus.map((row) => (
        <p key={row.status}>
          {row.status}: {row.count}
        </p>
      ))}
      <table className="w-full text-left">
        <thead>
          <tr>
            <th>Started</th>
            <th>Status</th>
            <th>Active</th>
            <th>Tokens</th>
            <th>USD</th>
          </tr>
        </thead>
        <tbody>
          {data.runs.map((run) => (
            <tr key={run.runId}>
              <td>
                <Link
                  to="/workflows/$environmentId/runs/$runId"
                  params={{ environmentId: props.environmentId, runId: run.runId }}
                >
                  {run.startedAt}
                </Link>
              </td>
              <td>
                <RunStatusBadge status={run.status} />
              </td>
              <td>{run.activeMs === null ? "unknown" : formatDuration(run.activeMs)}</td>
              <td>
                {formatTokens(run.billable)}
                <div
                  className="h-1 bg-primary"
                  style={{ width: `${(100 * run.billable) / maximum}%` }}
                />
              </td>
              <td>{formatUsd(run.usdEstimate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <table className="w-full text-left">
        <thead>
          <tr>
            <th>Node</th>
            <th>Attempts</th>
            <th>Failures</th>
            <th>Average tokens</th>
          </tr>
        </thead>
        <tbody>
          {data.nodes.map((node) => (
            <tr key={node.node}>
              <td>{node.node}</td>
              <td>{node.attempts}</td>
              <td>{node.failures}</td>
              <td>
                {node.averageBillable === null ? "unknown" : formatTokens(node.averageBillable)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.series.map((series) => (
        <section key={series.name}>
          <h3>{series.name}</h3>
          <table className="w-full text-left">
            <thead>
              <tr>
                <th>At</th>
                <th>Value</th>
                <th>Verdict</th>
              </tr>
            </thead>
            <tbody>
              {series.points.map((point) => (
                <tr key={`${point.runId}-${point.at}`}>
                  <td>{point.at}</td>
                  <td>{point.value}</td>
                  <td>{point.verdict ?? "Pending"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}
