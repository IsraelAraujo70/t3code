import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  WorkflowRunId,
  WorkflowRunControl,
  WorkflowRunView,
  WorkflowStepAttemptView,
  WorkflowGateView,
  WorkflowPauseReason,
  WorkflowSkipReason,
} from "@t3tools/contracts";
import {
  formatDuration,
  formatTokens,
  formatUsd,
  stepRows,
  stepDurationMs,
  isRunActive,
  openGates,
  toCanvasModel,
  withNodeStatuses,
  nodeStatuses,
} from "@t3tools/client-runtime/workflows";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useNowMinute } from "../../../hooks/useNowMinute";
import { randomUUID } from "~/lib/utils";
import { useAtomCommand } from "../../../state/use-atom-command";
import { commandFailureMessage } from "../../botsSettingsShared";
import { Button } from "../../../components/ui/button";
import { useWorkflowRun, workflowsEnvironment } from "../state";
import { WorkflowsNotice, WorkflowsPageFrame } from "../WorkflowsPageFrame";
import { RunStatusBadge, StepStatusBadge } from "../WorkflowStatusBadge";
import { LazyWorkflowCanvas } from "../canvas/LazyWorkflowCanvas";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "../../../components/ui/table";
import { GateSheet } from "./GateSheet";
import { StepDetailSheet } from "./StepDetailSheet";
import { WorkflowMetricsPanel } from "../metrics/WorkflowMetricsPanel";
import { BlockViews } from "./BlockViews";
/** Subscribed run screen, using the pinned definition and folded deltas. */
export function WorkflowRunPage(props: { environmentId: EnvironmentId; runId: WorkflowRunId }) {
  const run = useWorkflowRun(props.environmentId, props.runId);
  return run.data ? (
    <RunContent environmentId={props.environmentId} view={run.data} queryError={run.error} />
  ) : (
    <WorkflowsPageFrame title="Workflow run">
      <WorkflowsNotice>{run.error ?? "Loading…"}</WorkflowsNotice>
    </WorkflowsPageFrame>
  );
}
const pauseReasons = {
  fatigue: "too many failures in a row",
  ambiguous: "a step's outcome needs review",
  user: "at your request",
  daily_cap: "the host's daily token limit was reached",
} satisfies Record<WorkflowPauseReason, string>;
const skipReasons = {
  busy: "the workflow was busy",
  disabled: "the workflow was disabled",
  suspended: "the workflow was suspended",
  invalid: "the workflow definition was invalid",
} satisfies Record<WorkflowSkipReason, string>;

function RunContent({
  environmentId,
  view,
  queryError,
}: {
  environmentId: EnvironmentId;
  view: WorkflowRunView;
  queryError: string | null;
}) {
  const canOperate = useAtomValue(workflowsEnvironment.runControl.permissionAtom(environmentId));
  const now = Date.parse(useNowMinute());
  const summary = view.summary;
  // oxlint-disable-next-line t3code/no-manual-memo -- Keep canvas identity stable across clock ticks as required by the run view.
  const model = useMemo(
    () =>
      view.definition
        ? withNodeStatuses(toCanvasModel(view.definition), nodeStatuses(view.steps))
        : null,
    [view.definition, view.steps],
  );
  const control = useAtomCommand(workflowsEnvironment.runControl, { label: "run control" });
  const [showMetrics, setShowMetrics] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<WorkflowStepAttemptView | null>(null);
  const [gate, setGate] = useState<WorkflowGateView | null>(null);
  const submit = async (value: WorkflowRunControl) => {
    setPending(true);
    setError(null);
    const result = await control({
      environmentId,
      input: { runId: summary.runId, control: value, clientRequestId: randomUUID() },
    });
    setPending(false);
    if (result._tag === "Failure") setError(commandFailureMessage(result));
  };
  return (
    <WorkflowsPageFrame
      title={summary.title}
      actions={
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="xs"
            variant="ghost-muted"
            render={<Link to="/workflows/$environmentId" params={{ environmentId }} />}
          >
            Workflows
          </Button>
          <Button
            size="xs"
            variant="ghost-muted"
            render={
              <Link
                to="/workflows/$environmentId/$workflowId"
                params={{ environmentId, workflowId: summary.workflowId }}
              />
            }
          >
            Edit workflow
          </Button>
          {summary.status === "running" ? (
            <Button
              size="xs"
              variant="outline"
              disabled={pending || !canOperate}
              onClick={() => void submit({ _tag: "pause" })}
            >
              Pause
            </Button>
          ) : null}
          {summary.status === "paused" ? (
            <Button
              size="xs"
              variant="outline"
              disabled={pending || !canOperate}
              onClick={() => void submit({ _tag: "resume" })}
            >
              Resume
            </Button>
          ) : null}
          {isRunActive(summary.status) ? (
            <Button
              size="xs"
              variant="destructive-outline"
              disabled={pending || !canOperate}
              onClick={() => void submit({ _tag: "cancel" })}
            >
              Cancel
            </Button>
          ) : null}
        </div>
      }
    >
      <div className="space-y-6 p-6">
        {queryError ? (
          <p role="alert" className="text-sm text-destructive-foreground">
            {queryError}
          </p>
        ) : null}
        <section className="space-y-4 rounded-lg border p-4">
          <RunStatusBadge status={summary.status} />
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 text-sm sm:grid-cols-4 lg:grid-cols-8">
            <div className="col-span-2">
              <dt className="text-xs text-muted-foreground">Trigger</dt>
              <dd className="mt-1">{summary.trigger.label}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Started</dt>
              <dd className="mt-1">
                {formatDuration(Math.max(0, now - Date.parse(summary.startedAt)))} ago
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Elapsed</dt>
              <dd className="mt-1">
                {formatDuration(
                  Math.max(
                    0,
                    (summary.endedAt ? Date.parse(summary.endedAt) : now) -
                      Date.parse(summary.startedAt),
                  ),
                )}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Active time</dt>
              <dd className="mt-1">
                {summary.activeMs === null ? "unknown" : formatDuration(summary.activeMs)}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Steps used</dt>
              <dd className="mt-1">{summary.stepsUsed}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Tokens</dt>
              <dd className="mt-1">
                {formatTokens(summary.cost.billable)}
                {summary.cost.usage !== "complete" ? (
                  <span className="ml-1 text-xs text-muted-foreground">
                    partial ({summary.cost.usage})
                  </span>
                ) : null}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">USD</dt>
              <dd className="mt-1">{formatUsd(summary.cost.usdEstimate)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Open gates</dt>
              <dd className="mt-1">{summary.openGates}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Output</dt>
              <dd className="mt-1">{summary.outputStatus ?? "Pending"}</dd>
            </div>
            {summary.pullRequest ? (
              <div>
                <dt className="text-xs text-muted-foreground">Pull request</dt>
                <dd className="mt-1">
                  <a
                    className="underline underline-offset-4"
                    href={summary.pullRequest}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open PR
                  </a>
                </dd>
              </div>
            ) : null}
          </dl>
          {summary.pausedFor ? (
            <p className="text-sm text-muted-foreground">
              Paused: {pauseReasons[summary.pausedFor]}.
            </p>
          ) : null}
          {summary.skipReason ? (
            <p className="text-sm text-muted-foreground">
              Skipped: {skipReasons[summary.skipReason]}.
            </p>
          ) : null}
        </section>
        {error ? <p role="alert">{error}</p> : null}
        {openGates(view.gates).length > 0 ? (
          <section className="space-y-3 rounded-lg border border-warning/30 bg-warning/8 p-4 text-warning-foreground">
            <h2 className="text-sm font-medium">Needs you</h2>
            {openGates(view.gates).map((g) => (
              <div key={g.key} className="flex items-center justify-between gap-4">
                <p className="text-sm">{g.ask}</p>
                <Button size="xs" variant="outline" onClick={() => setGate(g)}>
                  Answer
                </Button>
              </div>
            ))}
          </section>
        ) : null}
        {view.gates.some((g) => g.decision) ? (
          <section className="space-y-2">
            <h2 className="text-xs font-medium text-muted-foreground">Decided gates</h2>
            {view.gates.map((g) =>
              g.decision ? (
                <div key={g.key} className="text-xs text-muted-foreground">
                  <p>
                    {g.ask}: <span className="text-foreground">{g.decision.option}</span>
                    {" · "}
                    <time dateTime={g.decision.at}>
                      {formatDuration(Math.max(0, now - Date.parse(g.decision.at)))} ago
                    </time>
                  </p>
                  {g.decision.note ? (
                    <p className="mt-1 whitespace-pre-wrap">{g.decision.note}</p>
                  ) : null}
                </div>
              ) : null,
            )}
          </section>
        ) : null}
        {model ? (
          <div className="h-[420px] overflow-hidden rounded-lg border">
            <LazyWorkflowCanvas
              mode="run"
              model={model}
              onSelectNode={(id) => {
                setSelected(id);
                if (id)
                  document
                    .getElementById(`workflow-node-${id}`)
                    ?.scrollIntoView({ block: "center" });
              }}
            />
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No pinned definition while this run is queued or skipped.
          </p>
        )}
        <section className="space-y-2">
          <h2 className="text-xs font-medium text-muted-foreground">Steps</h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Step</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Attempts</TableHead>
                <TableHead>Time</TableHead>
                <TableHead>Usage</TableHead>
                <TableHead>Summary</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {stepRows(view.steps).map((row) => (
                <TableRow
                  key={row.key}
                  id={`workflow-node-${row.node}`}
                  data-state={selected === row.node ? "selected" : undefined}
                >
                  <TableCell>
                    <p>{view.definition?.nodes[row.node]?.title ?? row.node}</p>
                    {row.key !== row.node ? (
                      <p className="mt-1 text-xs text-muted-foreground">{row.key}</p>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <StepStatusBadge status={row.latest.status} />
                  </TableCell>
                  <TableCell>{row.attempts.length}</TableCell>
                  <TableCell>
                    {row.latest.startedAt
                      ? formatDuration(stepDurationMs(row.latest, now) ?? 0)
                      : "Not started"}
                    {row.latest.queuedMs !== null ? (
                      <p className="mt-1 text-muted-foreground">
                        queued {formatDuration(row.latest.queuedMs)}
                      </p>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    {row.latest.cost ? (
                      <>
                        {formatTokens(row.latest.cost.billable)} ·{" "}
                        {formatUsd(row.latest.cost.usdEstimate)}
                        {row.latest.cost.usage !== "complete" ? (
                          <p className="mt-1 text-muted-foreground">partial</p>
                        ) : null}
                      </>
                    ) : (
                      <span className="text-muted-foreground">unavailable</span>
                    )}
                  </TableCell>
                  <TableCell>
                    {/* oxlint-disable t3code/no-native-title-tooltip -- The leaf brief requires the full step summary in title. */}
                    <p
                      className="line-clamp-2 max-w-64 whitespace-normal"
                      title={row.latest.summary ?? undefined}
                    >
                      {row.latest.summary}
                    </p>
                    {/* oxlint-enable t3code/no-native-title-tooltip */}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {row.latest.threadId ? (
                        <Button
                          size="xs"
                          variant="outline"
                          render={
                            <Link
                              to="/$environmentId/$threadId"
                              params={{ environmentId, threadId: row.latest.threadId }}
                            />
                          }
                        >
                          Open thread
                        </Button>
                      ) : null}
                      <Button variant="outline" size="xs" onClick={() => setDetail(row.latest)}>
                        Details
                      </Button>
                      {["failed", "lost", "timed_out", "ambiguous"].includes(row.latest.status) ? (
                        <Button
                          disabled={pending || !canOperate}
                          size="xs"
                          onClick={() => void submit({ _tag: "retry", step: row.key })}
                        >
                          Retry
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {view.steps.length === 0 ? (
            <p className="text-sm text-muted-foreground">No steps yet.</p>
          ) : null}
        </section>
        <BlockViews blocks={view.blocks} />
        <Button size="xs" variant="outline" onClick={() => setShowMetrics((value) => !value)}>
          {showMetrics ? "Hide metrics" : "Show workflow metrics"}
        </Button>
        {showMetrics ? (
          <WorkflowMetricsPanel environmentId={environmentId} workflowId={summary.workflowId} />
        ) : null}
        {detail ? (
          <StepDetailSheet
            environmentId={environmentId}
            runId={summary.runId}
            step={detail}
            onClose={() => setDetail(null)}
          />
        ) : null}
        {gate ? (
          <GateSheet
            environmentId={environmentId}
            runId={summary.runId}
            gate={gate}
            evidence={view.steps
              .filter((s) => s.key === gate.step)
              .map((s) => [s.summary, s.evidence].filter(Boolean).join("\n"))
              .join("\n")}
            pullRequest={summary.pullRequest}
            onClose={() => setGate(null)}
          />
        ) : null}
      </div>
    </WorkflowsPageFrame>
  );
}
