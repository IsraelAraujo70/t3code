import {
  describeTrigger,
  formatDuration,
  formatTokens,
  formatUsd,
  isAutomaticTrigger,
} from "@t3tools/client-runtime/workflows";
import type { EnvironmentId, WorkflowRunSummary } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { HandIcon } from "lucide-react";

import { Skeleton } from "../../components/ui/skeleton";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { TriggerIcon } from "./run/TriggerIcon";
import { runDurationMs, useNowMs } from "./WorkflowListRow";
import { RunStatusLabel } from "./WorkflowStatusBadge";

// With the workflow column, the trigger column shows from lg up; without it, it takes the free width.
const ROW_WITH_WORKFLOW =
  "grid grid-cols-[8rem_minmax(0,1fr)_4rem_4rem_5rem] items-center gap-3 lg:grid-cols-[8rem_minmax(0,1fr)_minmax(0,14rem)_4rem_4rem_5rem]";
const ROW_WITHOUT_WORKFLOW =
  "grid grid-cols-[8rem_minmax(0,1fr)_4rem_4rem_5rem] items-center gap-3";
export const RUNS_GUTTER = "pr-(--workspace-gutter-end) pl-(--workspace-gutter-start)";

export interface RunsLayout {
  /** Each workflow's own runs leave the workflow column out. */
  readonly showWorkflow: boolean;
  /** Page gutters on full-bleed lists; none inside an already padded panel. */
  readonly inset: string;
}

const rowClass = (layout: RunsLayout) =>
  `${layout.showWorkflow ? ROW_WITH_WORKFLOW : ROW_WITHOUT_WORKFLOW} ${layout.inset}`;

/** The runs table's column headings. */
export function WorkflowRunsHeader(props: { layout: RunsLayout }) {
  const { layout } = props;
  return (
    <div role="row" className={`${rowClass(layout)} h-8 border-b text-muted-foreground text-xs`}>
      <span role="columnheader">Status</span>
      {layout.showWorkflow ? <span role="columnheader">Workflow</span> : null}
      <span role="columnheader" className={layout.showWorkflow ? "hidden lg:block" : undefined}>
        Trigger
      </span>
      <span role="columnheader" className="text-right">
        Time
      </span>
      <span role="columnheader" className="text-right">
        Tokens
      </span>
      <span role="columnheader" className="text-right">
        Started
      </span>
    </div>
  );
}

/** Runs as table rows linking to each run; the editor's Runs tab. */
export function WorkflowRunsTable(props: {
  environmentId: EnvironmentId;
  runs: ReadonlyArray<WorkflowRunSummary>;
  layout: RunsLayout;
}) {
  return (
    <div role="table" aria-label="Runs">
      <WorkflowRunsHeader layout={props.layout} />
      {props.runs.map((run) => (
        <WorkflowRunRow
          key={run.runId}
          environmentId={props.environmentId}
          run={run}
          layout={props.layout}
        />
      ))}
    </div>
  );
}

export function WorkflowRunRow(props: {
  environmentId: EnvironmentId;
  run: WorkflowRunSummary;
  layout: RunsLayout;
}) {
  const { layout } = props;
  const { run } = props;
  const now = useNowMs();
  const duration = runDurationMs(run, now);
  // A scheduled or watched trigger reads better in words; "Run now by Owner" already does.
  const trigger = isAutomaticTrigger(run.trigger.kind)
    ? describeTrigger({ ...run.trigger, title: null }).text
    : run.trigger.label;
  return (
    <Link
      role="row"
      to="/workflows/$environmentId/runs/$runId"
      params={{ environmentId: props.environmentId, runId: run.runId }}
      className={`${rowClass(layout)} h-9 border-b text-sm outline-none hover:bg-accent/50 focus-visible:bg-accent/50`}
    >
      <span role="cell" className="min-w-0 text-xs">
        {run.openGates > 0 ? (
          <span className="inline-flex max-w-full items-center gap-1.5 text-warning">
            <HandIcon aria-hidden className="size-3.5 shrink-0" />
            <span className="shrink-0">Needs you</span>
            {run.gate ? (
              <span className="truncate text-muted-foreground">{run.gate.reason}</span>
            ) : null}
          </span>
        ) : (
          <RunStatusLabel status={run.status} />
        )}
      </span>
      {layout.showWorkflow ? (
        <span role="cell" className="truncate font-medium">
          {run.title}
        </span>
      ) : null}
      <span
        role="cell"
        className={
          layout.showWorkflow
            ? "hidden min-w-0 items-center gap-1 text-muted-foreground text-xs lg:flex"
            : "flex min-w-0 items-center gap-1 text-muted-foreground text-xs"
        }
      >
        <TriggerIcon kind={run.trigger.kind} />
        <span className="truncate">{trigger}</span>
      </span>
      <span role="cell" className="text-right text-muted-foreground text-xs tabular-nums">
        {duration === null ? "-" : formatDuration(duration)}
      </span>
      <span role="cell" className="text-right text-muted-foreground text-xs tabular-nums">
        <RunTokens run={run} />
      </span>
      <span role="cell" className="text-right text-muted-foreground text-xs">
        <time dateTime={run.startedAt}>{formatRelativeTimeLabel(run.startedAt, now)}</time>
      </span>
    </Link>
  );
}

/** Billable tokens; a dash when the run spent none, the price and gaps in a tooltip. */
function RunTokens(props: { run: WorkflowRunSummary }) {
  const { cost } = props.run;
  if (cost.billable === 0 && cost.usdEstimate === null) return <>-</>;
  return (
    <Tooltip>
      <TooltipTrigger render={<span />}>
        {formatTokens(cost.billable)}
        {cost.usage === "complete" ? "" : "+"}
      </TooltipTrigger>
      <TooltipPopup>
        {cost.billable.toLocaleString()} billable tokens
        {cost.usdEstimate === null ? "" : ` · about ${formatUsd(cost.usdEstimate)}`}
        {cost.usage === "complete" ? "" : " · some steps did not report usage"}
      </TooltipPopup>
    </Tooltip>
  );
}

export function WorkflowRunsSkeleton() {
  return (
    <div aria-hidden>
      {[0, 1, 2].map((index) => (
        <div key={index} className={`${ROW_WITH_WORKFLOW} ${RUNS_GUTTER} h-9 border-b`}>
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-48" />
          <Skeleton className="hidden h-3 w-32 lg:block" />
          <Skeleton className="ml-auto h-3 w-8" />
          <Skeleton className="ml-auto h-3 w-8" />
          <Skeleton className="ml-auto h-3 w-12" />
        </div>
      ))}
    </div>
  );
}
