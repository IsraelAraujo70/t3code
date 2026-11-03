import type { EnvironmentId, WorkflowId } from "@t3tools/contracts";
import { useState } from "react";
import { Button } from "../../../components/ui/button";
import { useNowMinute } from "../../../hooks/useNowMinute";
import { useEnvironmentQuery } from "../../../state/query";
import { formatRelativeTimeLabel } from "../../../timestampFormat";
import { WorkflowMetricsPanel } from "../metrics/WorkflowMetricsPanel";
import { WorkflowLedgerPanel } from "../metrics/WorkflowLedgerPanel";
import { useWorkflowRuns, workflowsEnvironment } from "../state";
import { WorkflowRunsTable } from "../WorkflowRecentRuns";

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
  if (runs.error)
    return (
      <p role="alert" className="text-destructive text-sm">
        {runs.error}
      </p>
    );
  if (runs.data === null)
    return (
      <p role="status" className="text-muted-foreground text-sm">
        Loading runs…
      </p>
    );
  if (runs.data.runs.length === 0)
    return (
      <p className="rounded-lg border border-dashed px-4 py-8 text-center text-muted-foreground text-sm">
        No runs yet. Use Run now above, or turn the workflow on and let a trigger fire.
      </p>
    );
  return (
    <WorkflowRunsTable
      environmentId={props.environmentId}
      runs={runs.data.runs}
      layout={{ showWorkflow: false, inset: "" }}
    />
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
      {history.error ? (
        <p role="alert" className="text-destructive text-sm">
          {history.error}
        </p>
      ) : null}
      {history.data === null ? (
        <p role="status" className="text-muted-foreground text-sm">
          Loading history…
        </p>
      ) : (
        <>
          {history.data.versions.length === 0 ? (
            <p className="text-muted-foreground text-sm">No versions yet.</p>
          ) : (
            history.data.versions.map((version) => (
              <div
                key={version.commit}
                className="flex items-baseline gap-3 border-b py-2 text-sm last:border-b-0"
              >
                <p className="min-w-0 flex-1 truncate">{version.message}</p>
                <span className="shrink-0 text-muted-foreground text-xs">{version.author}</span>
                <time
                  dateTime={version.at}
                  className="w-20 shrink-0 text-right text-muted-foreground text-xs"
                >
                  {formatRelativeTimeLabel(version.at, Date.parse(`${now}:00Z`))}
                </time>
                <code className="shrink-0 text-muted-foreground text-xs">
                  {version.commit.slice(0, 8)}
                </code>
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
