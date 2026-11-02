import { useEnvironmentQuery } from "../../../state/query";
import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  WorkflowRunId,
  WorkflowRunControl,
  WorkflowRunView,
  WorkflowStepAttemptView,
  WorkflowGateView,
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
import { GateSheet } from "./GateSheet";
import { StepDetailSheet } from "./StepDetailSheet";
import { WorkflowMetricsPanel } from "../metrics/WorkflowMetricsPanel";
import { BlockViews } from "./BlockViews";
/** Subscribed run screen, using the pinned definition and folded deltas. */
export function WorkflowRunPage(props: { environmentId: EnvironmentId; runId: WorkflowRunId }) {
  const run = useWorkflowRun(props.environmentId, props.runId);
  return (
    <WorkflowsPageFrame title={run.data?.summary.title ?? "Workflow run"}>
      {run.data && run.error ? <p role="alert">{run.error}</p> : null}
      {run.data ? (
        <RunContent environmentId={props.environmentId} view={run.data} />
      ) : (
        <WorkflowsNotice>{run.error ?? "Loading…"}</WorkflowsNotice>
      )}
    </WorkflowsPageFrame>
  );
}
function RunContent({
  environmentId,
  view,
}: {
  environmentId: EnvironmentId;
  view: WorkflowRunView;
}) {
  const canOperate = useAtomValue(workflowsEnvironment.runControl.permissionAtom(environmentId));
  const now = Date.parse(useNowMinute());
  const summary = view.summary;
  const metrics = useEnvironmentQuery(
    workflowsEnvironment.metrics({ environmentId, input: { workflowId: summary.workflowId } }),
  );
  const activeMs = metrics.data?.runs.find((run) => run.runId === summary.runId)?.activeMs;
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
    <div className="space-y-5 p-6">
      <nav className="flex gap-4">
        <Link to="/workflows/$environmentId" params={{ environmentId }}>
          Workflows
        </Link>
        <Link
          to="/workflows/$environmentId/$workflowId"
          params={{ environmentId, workflowId: summary.workflowId }}
        >
          Edit workflow
        </Link>
      </nav>
      <RunStatusBadge status={summary.status} />
      <p>
        {summary.pausedFor ?? summary.skipReason} · {summary.trigger.label} · started{" "}
        {formatDuration(Math.max(0, now - Date.parse(summary.startedAt)))} ago · active{" "}
        {activeMs == null ? "unknown" : formatDuration(activeMs)} · elapsed{" "}
        {formatDuration(
          Math.max(
            0,
            (summary.endedAt ? Date.parse(summary.endedAt) : now) - Date.parse(summary.startedAt),
          ),
        )}{" "}
        · {summary.stepsUsed} steps · {formatTokens(summary.cost.billable)} tokens ·{" "}
        {formatUsd(summary.cost.usdEstimate)} · {summary.openGates} open gates ·{" "}
        {summary.outputStatus}
      </p>
      {summary.cost.usage !== "complete" ? <p>partial usage ({summary.cost.usage})</p> : null}
      {summary.pullRequest ? (
        <a href={summary.pullRequest} target="_blank" rel="noreferrer">
          Pull request
        </a>
      ) : null}
      <div className="flex gap-2">
        {summary.status === "running" ? (
          <Button disabled={pending || !canOperate} onClick={() => void submit({ _tag: "pause" })}>
            Pause
          </Button>
        ) : null}
        {summary.status === "paused" ? (
          <Button disabled={pending || !canOperate} onClick={() => void submit({ _tag: "resume" })}>
            Resume
          </Button>
        ) : null}
        {isRunActive(summary.status) ? (
          <Button disabled={pending || !canOperate} onClick={() => void submit({ _tag: "cancel" })}>
            Cancel
          </Button>
        ) : null}
      </div>
      {error ? <p role="alert">{error}</p> : null}
      {openGates(view.gates).map((g) => (
        <Button key={g.key} onClick={() => setGate(g)}>
          Needs you: {g.ask}
        </Button>
      ))}
      {view.gates
        .filter((g) => g.decision)
        .map((g) => (
          <p key={g.key}>
            {g.ask}: {g.decision?.option} · {g.decision?.note} · {g.decision?.at}
          </p>
        ))}
      {model ? (
        <div className="h-96">
          <LazyWorkflowCanvas
            mode="run"
            model={model}
            onSelectNode={(id) => {
              setSelected(id);
              if (id)
                document.getElementById(`workflow-node-${id}`)?.scrollIntoView({ block: "center" });
            }}
          />
        </div>
      ) : (
        <p>No pinned definition while this run is queued or skipped.</p>
      )}
      <table className="w-full text-left text-sm">
        <thead>
          <tr>
            <th>Step</th>
            <th>Status</th>
            <th>Attempts</th>
            <th>Duration / queue</th>
            <th>Usage</th>
            <th>Summary</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {stepRows(view.steps).map((row) => (
            <tr
              key={row.key}
              id={`workflow-node-${row.node}`}
              className={selected === row.node ? "bg-muted" : ""}
            >
              <td>
                {row.node}
                <br />
                {row.key}
              </td>
              <td>
                <StepStatusBadge status={row.latest.status} />
              </td>
              <td>{row.attempts.length}</td>
              <td>
                {row.latest.startedAt
                  ? formatDuration(stepDurationMs(row.latest, now) ?? 0)
                  : "Not started"}
                {row.latest.queuedMs !== null
                  ? ` / queued ${formatDuration(row.latest.queuedMs)}`
                  : ""}
              </td>
              <td>
                {row.latest.cost
                  ? `${formatTokens(row.latest.cost.billable)} · ${formatUsd(row.latest.cost.usdEstimate)} · ${row.latest.cost.usage}`
                  : "unavailable"}
              </td>
              <td>{row.latest.summary}</td>
              <td>
                {row.latest.threadId ? (
                  <Link
                    to="/$environmentId/$threadId"
                    params={{ environmentId, threadId: row.latest.threadId }}
                  >
                    Open thread
                  </Link>
                ) : null}
                <Button variant="outline" size="sm" onClick={() => setDetail(row.latest)}>
                  Details
                </Button>
                {["failed", "lost", "timed_out", "ambiguous"].includes(row.latest.status) ? (
                  <Button
                    disabled={pending || !canOperate}
                    size="sm"
                    onClick={() => void submit({ _tag: "retry", step: row.key })}
                  >
                    Retry
                  </Button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {view.nextStepsCursor ? <p>Additional steps are available on the host.</p> : null}
      <BlockViews blocks={view.blocks} />
      <Button variant="outline" onClick={() => setShowMetrics((value) => !value)}>
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
  );
}
