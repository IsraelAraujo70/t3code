import type { EnvironmentId, WorkflowId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "../../../components/ui/button";
import { useNowMinute } from "../../../hooks/useNowMinute";
import { useEnvironmentQuery } from "../../../state/query";
import { formatRelativeTimeLabel } from "../../../timestampFormat";
import { WorkflowMetricsPanel } from "../metrics/WorkflowMetricsPanel";
import { WorkflowLedgerPanel } from "../metrics/WorkflowLedgerPanel";
import { RunNowDialog } from "../RunNowDialog";
import { useWorkflowRuns, workflowsEnvironment } from "../state";
import { RunStatusBadge } from "../WorkflowStatusBadge";

type TabProps = { environmentId: EnvironmentId; workflowId: WorkflowId };

/** Query-backed tabs mount only when selected. */
export function WorkflowEditorTab(
  props: TabProps & { tab: "Runs" | "Metrics" | "Ledger" | "History" },
) {
  switch (props.tab) {
    case "Runs":
      return <Runs {...props} />;
    case "Metrics":
      return <WorkflowMetricsPanel {...props} />;
    case "Ledger":
      return <WorkflowLedgerPanel {...props} />;
    case "History":
      return <History {...props} />;
  }
}
function Runs(props: TabProps) {
  const runs = useWorkflowRuns(props.environmentId, { workflowId: props.workflowId, limit: 20 });
  const [running, setRunning] = useState(false);
  return (
    <div className="space-y-3">
      <Button size="sm" onClick={() => setRunning(true)}>
        Run now
      </Button>
      {runs.error ? <p role="alert">{runs.error}</p> : null}
      {runs.data === null ? (
        <p>Loading runs…</p>
      ) : runs.data.runs.length === 0 ? (
        <p>No runs yet.</p>
      ) : (
        runs.data.runs.map((run) => (
          <div key={run.runId} className="flex items-center gap-2">
            <Link
              to="/workflows/$environmentId/runs/$runId"
              params={{ environmentId: props.environmentId, runId: run.runId }}
            >
              {run.runId}
            </Link>
            <RunStatusBadge status={run.status} />
            <time dateTime={run.startedAt}>{run.startedAt}</time>
          </div>
        ))
      )}
      {running ? <RunNowDialog {...props} onClose={() => setRunning(false)} /> : null}
    </div>
  );
}
function History(props: TabProps & { cursor?: string }) {
  const history = useEnvironmentQuery(
    workflowsEnvironment.history({
      environmentId: props.environmentId,
      input: { workflowId: props.workflowId, limit: 20, cursor: props.cursor },
    }),
  );
  const [more, setMore] = useState(false);
  const now = useNowMinute();
  return (
    <div className="space-y-3">
      {history.error ? <p role="alert">{history.error}</p> : null}
      {history.data === null ? (
        <p>Loading history…</p>
      ) : (
        <>
          {history.data.versions.length === 0 ? (
            <p>No versions yet.</p>
          ) : (
            history.data.versions.map((version) => (
              <div key={version.commit} className="border-b border-border py-2 text-sm">
                <p>{version.message}</p>
                <p className="text-muted-foreground">
                  {version.author} · {formatRelativeTimeLabel(version.at, Date.parse(`${now}:00Z`))}{" "}
                  · <code>{version.commit.slice(0, 8)}</code>
                </p>
              </div>
            ))
          )}
          {history.data.nextCursor ? (
            more ? (
              <History {...props} cursor={history.data.nextCursor} />
            ) : (
              <Button size="sm" variant="outline" onClick={() => setMore(true)}>
                Load more
              </Button>
            )
          ) : null}
        </>
      )}
    </div>
  );
}
