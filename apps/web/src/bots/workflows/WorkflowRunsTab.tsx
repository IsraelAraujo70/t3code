import {
  runMatchesListInput,
  type WorkflowRunsFilterInput,
} from "@t3tools/client-runtime/workflows";
import type { EnvironmentId, WorkflowRunsListInput, WorkflowRunsPage } from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { Button } from "../../components/ui/button";
import { useWorkflowRuns } from "./state";
import {
  RUNS_GUTTER,
  type RunsLayout,
  WorkflowRunRow,
  WorkflowRunsHeader,
  WorkflowRunsSkeleton,
} from "./WorkflowRecentRuns";

const PAGE_SIZE = 50;
/** The run list's largest page (`PageLimit` in the contract). */
const MAX_RUNS = 200;
const LAYOUT: RunsLayout = { showWorkflow: true, inset: RUNS_GUTTER };

/**
 * The host's run list, refetched when `historyKey` (the snapshot's run history) moves: a one-shot
 * query on its own would go stale while the page stays open.
 */
export function useLiveWorkflowRuns(
  environmentId: EnvironmentId,
  input: WorkflowRunsListInput,
  historyKey: string | null,
) {
  const runs = useWorkflowRuns(environmentId, input);
  const seen = useRef<string | null>(null);
  const { refresh, isPending } = runs;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refetches the server's run list when the snapshot stream reports a run started or changed state, or a cached list may be stale on return
  useEffect(() => {
    // A request already in flight may have read before the change, so wait and refetch after it.
    if (historyKey === null || seen.current === historyKey || isPending) return;
    seen.current = historyKey;
    refresh();
  }, [historyKey, refresh, isPending]);
  return runs;
}

/**
 * The Runs tab: the runs that match the filters, newest first. "Load more" grows one query by a
 * page instead of fetching offsets, so a run that starts meanwhile never duplicates or hides a
 * row at a page boundary. The host caps a page, so the tab lists at most `MAX_RUNS`.
 */
export function WorkflowRunsTab(props: {
  environmentId: EnvironmentId;
  filter: WorkflowRunsFilterInput;
  historyKey: string | null;
  filtered: boolean;
}) {
  const [limit, setLimit] = useState(PAGE_SIZE);
  const runs = useLiveWorkflowRuns(
    props.environmentId,
    { ...props.filter, limit },
    props.historyKey,
  );
  // The shorter list stays on screen while the longer one loads.
  const shorter = useLiveWorkflowRuns(
    props.environmentId,
    { ...props.filter, limit: Math.max(PAGE_SIZE, limit - PAGE_SIZE) },
    props.historyKey,
  );
  const page = runs.data ?? shorter.data;
  return (
    <div role="table" aria-label="Runs" className="pb-8">
      <WorkflowRunsHeader layout={LAYOUT} />
      {page === null ? (
        runs.error === null ? (
          <WorkflowRunsSkeleton />
        ) : (
          <p role="alert" className={`${RUNS_GUTTER} py-3 text-destructive text-sm`}>
            Runs unavailable: {runs.error}
          </p>
        )
      ) : (
        <RunRows
          environmentId={props.environmentId}
          filter={props.filter}
          filtered={props.filtered}
          page={page}
          loading={runs.data === null}
          onMore={limit < MAX_RUNS ? () => setLimit(limit + PAGE_SIZE) : null}
        />
      )}
    </div>
  );
}

function RunRows(props: {
  environmentId: EnvironmentId;
  filter: WorkflowRunsFilterInput;
  filtered: boolean;
  page: WorkflowRunsPage;
  loading: boolean;
  onMore: (() => void) | null;
}) {
  // An older host ignores the filters it does not know.
  const shown = props.page.runs.filter((run) => runMatchesListInput(run, props.filter));
  const more = props.page.nextCursor !== null;
  return (
    <>
      {shown.length === 0 && !more ? (
        <p className={`${RUNS_GUTTER} py-3 text-muted-foreground text-sm`}>
          {props.filtered
            ? "No runs match these filters."
            : "No runs yet. Runs appear here when a trigger fires or you press Run now."}
        </p>
      ) : null}
      {shown.map((run) => (
        <WorkflowRunRow
          key={run.runId}
          environmentId={props.environmentId}
          run={run}
          layout={LAYOUT}
        />
      ))}
      {more ? (
        <div className={`${RUNS_GUTTER} flex justify-center py-3`}>
          {props.onMore === null ? (
            <p className="text-muted-foreground text-xs">
              Showing the latest {MAX_RUNS} runs. Narrow the filters to reach older ones.
            </p>
          ) : (
            <Button size="xs" variant="outline" disabled={props.loading} onClick={props.onMore}>
              Load more
            </Button>
          )}
        </div>
      ) : null}
    </>
  );
}
