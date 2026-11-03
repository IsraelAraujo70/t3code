import {
  runMatchesListInput,
  type WorkflowRunsFilterInput,
} from "@t3tools/client-runtime/workflows";
import type { EnvironmentId, WorkflowRunsListInput } from "@t3tools/contracts";
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

/** The Runs tab: every run that matches the filters, newest first, a page at a time. */
export function WorkflowRunsTab(props: {
  environmentId: EnvironmentId;
  filter: WorkflowRunsFilterInput;
  historyKey: string | null;
  filtered: boolean;
}) {
  const [pages, setPages] = useState(1);
  return (
    <div role="table" aria-label="Runs" className="pb-8">
      <WorkflowRunsHeader layout={LAYOUT} />
      {Array.from({ length: pages }, (_, page) => (
        <RunsPage
          key={page}
          {...props}
          offset={page * PAGE_SIZE}
          last={page === pages - 1}
          onMore={() => setPages(pages + 1)}
        />
      ))}
    </div>
  );
}

function RunsPage(props: {
  environmentId: EnvironmentId;
  filter: WorkflowRunsFilterInput;
  historyKey: string | null;
  filtered: boolean;
  offset: number;
  last: boolean;
  onMore: () => void;
}) {
  const runs = useLiveWorkflowRuns(
    props.environmentId,
    {
      ...props.filter,
      limit: PAGE_SIZE,
      ...(props.offset === 0 ? {} : { cursor: String(props.offset) }),
    },
    props.historyKey,
  );
  if (runs.data === null)
    return runs.error === null ? (
      <WorkflowRunsSkeleton />
    ) : (
      <p role="alert" className={`${RUNS_GUTTER} py-3 text-destructive text-sm`}>
        Runs unavailable: {runs.error}
      </p>
    );
  // An older host ignores the filters it does not know.
  const shown = runs.data.runs.filter((run) => runMatchesListInput(run, props.filter));
  return (
    <>
      {props.offset === 0 && shown.length === 0 && runs.data.nextCursor === null ? (
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
      {props.last && runs.data.nextCursor !== null ? (
        <div className={`${RUNS_GUTTER} flex justify-center py-3`}>
          <Button size="xs" variant="outline" onClick={props.onMore}>
            Load more
          </Button>
        </div>
      ) : null}
    </>
  );
}
