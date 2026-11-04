import { Alert, AlertDescription } from "../../../components/ui/alert";
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
  liveActiveMs,
  formatTokens,
  formatUsd,
  stepRows,
  stepDurationMs,
  stepWaitLine,
  isRunActive,
  openGates,
  toCanvasModel,
  withNodeStatuses,
  nodeStatuses,
  withTriggerStates,
  gateReasonOf,
} from "@t3tools/client-runtime/workflows";
import { Link } from "@tanstack/react-router";
import { useMemo, useState, type ReactNode } from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ExternalLinkIcon,
  BotIcon,
  HandIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  RotateCcwIcon,
} from "lucide-react";
import { useNowMinute } from "../../../hooks/useNowMinute";
import { formatRelativeTimeLabel } from "../../../timestampFormat";
import { randomUUID } from "~/lib/utils";
import { useAtomCommand } from "../../../state/use-atom-command";
import { commandFailureMessage } from "../../botsSettingsShared";
import { Button } from "../../../components/ui/button";
import { useWorkflowRun, useWorkflowsSnapshot, workflowsEnvironment } from "../state";
import {
  WorkflowsBreadcrumb,
  WorkflowsNotice,
  WorkflowsPageFrame,
  WorkflowsSection,
} from "../WorkflowsPageFrame";
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
import { TriggerSheet } from "./TriggerSheet";
import { TriggerIcon } from "./TriggerIcon";
import { GateSheet } from "./GateSheet";
import { GateAsk } from "./GateAsk";
import { gateReason } from "@t3tools/shared/workflows";
import { StepDetailSheet } from "./StepDetailSheet";
import { WorkflowMetricsPanel } from "../metrics/WorkflowMetricsPanel";
import { BlockViews } from "./BlockViews";
/** Subscribed run screen, using the pinned definition and folded deltas. */
// The page ticks once a minute, so a live duration shows whole minutes; seconds would sit frozen.
const liveDuration = (fromIso: string, now: number): string => {
  const minutes = Math.floor(Math.max(0, now - Date.parse(fromIso)) / 60_000);
  return minutes === 0 ? "<1m" : formatDuration(minutes * 60_000);
};

export function WorkflowRunPage(props: { environmentId: EnvironmentId; runId: WorkflowRunId }) {
  const run = useWorkflowRun(props.environmentId, props.runId);
  return run.data ? (
    <RunContent environmentId={props.environmentId} view={run.data} queryError={run.error} />
  ) : (
    <WorkflowsPageFrame
      title={<WorkflowsBreadcrumb environmentId={props.environmentId}>Run</WorkflowsBreadcrumb>}
    >
      <WorkflowsNotice tone={run.error ? "error" : "muted"}>
        {run.error ?? "Loading run…"}
      </WorkflowsNotice>
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
  const now = Date.parse(`${useNowMinute()}:00Z`);
  const summary = view.summary;
  const activeMs = liveActiveMs(summary, now);
  // oxlint-disable-next-line t3code/no-manual-memo -- Keep canvas identity stable across clock ticks as required by the run view.
  const model = useMemo(
    () =>
      view.definition
        ? withTriggerStates(
            withNodeStatuses(toCanvasModel(view.definition), nodeStatuses(view.steps)),
            { fired: view.trigger.id },
          )
        : null,
    [view.definition, view.steps, view.trigger.id],
  );
  const control = useAtomCommand(workflowsEnvironment.runControl, { label: "run control" });
  const [triggerOpen, setTriggerOpen] = useState(false);
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
  const elapsed = summary.endedAt
    ? formatDuration(Math.max(0, Date.parse(summary.endedAt) - Date.parse(summary.startedAt)))
    : liveDuration(summary.startedAt, now);
  const waitingGates = openGates(view.gates);
  // A gate routed to the workflow's bot waits for it; Israel may still answer it.
  const workflow = useWorkflowsSnapshot(environmentId).data?.workflows.find(
    (w) => w.workflowId === summary.workflowId,
  );
  const botName = workflow?.bot?.name ?? "the bot";
  const forYou = waitingGates.filter((g) => g.bot === undefined);
  const forBot = waitingGates.filter((g) => g.bot !== undefined);
  return (
    <WorkflowsPageFrame
      title={
        <WorkflowsBreadcrumb environmentId={environmentId}>
          <Link
            to="/workflows/$environmentId/$workflowId"
            params={{ environmentId, workflowId: summary.workflowId }}
            className="truncate hover:underline"
          >
            {summary.title}
          </Link>
          <RunStatusBadge status={summary.status} />
        </WorkflowsBreadcrumb>
      }
      actions={
        <div className="flex items-center gap-1.5">
          {summary.status === "running" ? (
            <Button
              size="xs"
              variant="outline"
              disabled={pending || !canOperate}
              onClick={() => void submit({ _tag: "pause" })}
            >
              <PauseIcon />
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
              <PlayIcon />
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
              Cancel run
            </Button>
          ) : null}
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
            <PencilIcon />
            Edit workflow
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-6 pt-1 pb-10">
        <div className="flex flex-col gap-3 px-(--workspace-gutter-start) pr-(--workspace-gutter-end)">
          {view.warnings?.length ? (
            <Alert variant="warning">
              <AlertDescription>
                {[...new Set(view.warnings)].map((warning) => (
                  <p key={warning}>{warning}</p>
                ))}
              </AlertDescription>
            </Alert>
          ) : null}
          {queryError || error ? (
            <p role="alert" className="text-destructive text-sm">
              {queryError ?? error}
            </p>
          ) : null}
          <dl className="flex flex-wrap gap-x-8 gap-y-3 text-sm">
            <Fact label="Trigger">
              <button
                type="button"
                className="inline-flex max-w-72 cursor-pointer items-center gap-1.5 truncate hover:underline"
                onClick={() => setTriggerOpen(true)}
              >
                <TriggerIcon kind={view.trigger.kind} />
                <span className="truncate">{summary.trigger.label}</span>
                {view.trigger.test ? (
                  <span className="text-muted-foreground text-xs">test event</span>
                ) : null}
              </button>
            </Fact>
            <Fact label="Started">
              <time dateTime={summary.startedAt}>
                {formatRelativeTimeLabel(summary.startedAt, now)}
              </time>
            </Fact>
            <Fact label={summary.endedAt ? "Took" : "Running for"}>
              {elapsed}
              {activeMs !== null && formatDuration(activeMs) !== elapsed ? (
                <span className="ml-1 text-muted-foreground text-xs">
                  {formatDuration(activeMs)} active
                </span>
              ) : null}
            </Fact>
            <Fact label="Steps">{summary.stepsUsed}</Fact>
            <Fact label="Tokens">
              {summary.cost.billable === 0 && summary.cost.usage === "unavailable"
                ? "-"
                : formatTokens(summary.cost.billable)}
              {summary.cost.usdEstimate === null ? null : (
                <span className="ml-1 text-muted-foreground text-xs">
                  {formatUsd(summary.cost.usdEstimate)}
                </span>
              )}
              {summary.cost.usage === "partial" ? (
                <span className="ml-1 text-muted-foreground text-xs">partial</span>
              ) : null}
            </Fact>
            {summary.outputStatus ? <Fact label="Output">{summary.outputStatus}</Fact> : null}
            {summary.pullRequest ? (
              <Fact label="Pull request">
                <a
                  className="inline-flex items-center gap-1 hover:underline"
                  href={summary.pullRequest}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open PR
                  <ExternalLinkIcon aria-hidden className="size-3" />
                </a>
              </Fact>
            ) : null}
          </dl>
          {summary.pausedFor ? (
            <p className="text-muted-foreground text-sm">
              Paused: {pauseReasons[summary.pausedFor]}.
            </p>
          ) : null}
          {summary.skipReason ? (
            <p className="text-muted-foreground text-sm">
              Skipped: {skipReasons[summary.skipReason]}.
            </p>
          ) : null}
          {forBot.length > 0 ? (
            <section className="flex flex-col gap-2 rounded-lg border p-3">
              {forBot.map((g) => (
                <div key={g.key} className="flex items-start justify-between gap-4">
                  <div className="flex min-w-0 flex-col gap-1">
                    <h2 className="flex items-center gap-1.5 font-medium text-muted-foreground text-sm">
                      <BotIcon aria-hidden className="size-3.5" />
                      Waiting for {botName}
                    </h2>
                    <GateAsk environmentId={environmentId} gate={g} />
                  </div>
                  <Button size="xs" variant="outline" onClick={() => setGate(g)}>
                    Answer
                  </Button>
                </div>
              ))}
            </section>
          ) : null}
          {forYou.length > 0 ? (
            <section className="flex flex-col gap-2 rounded-lg border border-warning/30 bg-warning/8 p-3">
              <h2 className="flex items-center gap-1.5 font-medium text-sm text-warning-foreground">
                <HandIcon aria-hidden className="size-3.5" />
                Needs you
              </h2>
              {forYou.map((g) => (
                <div key={g.key} className="flex items-start justify-between gap-4">
                  <GateAsk environmentId={environmentId} gate={g} />
                  <Button size="xs" onClick={() => setGate(g)}>
                    Answer
                  </Button>
                </div>
              ))}
            </section>
          ) : null}
          {model ? (
            <div className="h-[420px] overflow-hidden rounded-lg border">
              <LazyWorkflowCanvas
                mode="run"
                model={model}
                onSelectNode={(id) => {
                  if (id === view.trigger.id) setTriggerOpen(true);
                  setSelected(id);
                  if (id)
                    document
                      .getElementById(`workflow-node-${id}`)
                      ?.scrollIntoView({ block: "center" });
                }}
              />
            </div>
          ) : (
            <p className="text-muted-foreground text-sm">
              No pinned definition while this run is queued or skipped.
            </p>
          )}
        </div>
        <WorkflowsSection title="Steps" count={stepRows(view.steps).length}>
          {view.steps.length === 0 ? (
            <p className="px-(--workspace-gutter-start) py-3 text-muted-foreground text-sm">
              No steps yet.
            </p>
          ) : (
            <div className="px-(--workspace-gutter-start) pr-(--workspace-gutter-end) tabular-nums">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Step</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="text-right">Attempts</TableHead>
                    <TableHead className="text-right">Time</TableHead>
                    <TableHead className="text-right">Tokens</TableHead>
                    <TableHead>Summary</TableHead>
                    <TableHead className="text-right">
                      <span className="sr-only">Actions</span>
                    </TableHead>
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
                        <p className="font-medium text-sm">
                          {view.definition?.nodes[row.node]?.title ?? row.node}
                        </p>
                        {row.key !== row.node ? (
                          <p className="text-muted-foreground">{row.key}</p>
                        ) : null}
                      </TableCell>
                      <TableCell>
                        <StepStatusBadge status={row.latest.status} />
                      </TableCell>
                      <TableCell className="text-right">{row.attempts.length}</TableCell>
                      <TableCell className="text-right">
                        {row.latest.startedAt === null
                          ? "-"
                          : row.latest.endedAt === null
                            ? liveDuration(row.latest.startedAt, now)
                            : formatDuration(stepDurationMs(row.latest, now) ?? 0)}
                        {stepWaitLine(row.latest) !== null ? (
                          <p className="text-muted-foreground">{stepWaitLine(row.latest)}</p>
                        ) : null}
                      </TableCell>
                      <TableCell className="text-right">
                        {row.latest.cost && row.latest.cost.usage !== "unavailable" ? (
                          <>
                            {formatTokens(row.latest.cost.billable)}
                            {row.latest.cost.usdEstimate === null ? null : (
                              <p className="text-muted-foreground">
                                {formatUsd(row.latest.cost.usdEstimate)}
                              </p>
                            )}
                          </>
                        ) : (
                          <span className="text-muted-foreground">-</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {/* oxlint-disable t3code/no-native-title-tooltip -- The leaf brief requires the full step summary in title. */}
                        <p
                          className="line-clamp-2 max-w-80 whitespace-normal text-muted-foreground"
                          title={row.latest.summary ?? undefined}
                        >
                          {row.latest.status === "waiting_gate" && row.latest.summary !== null
                            ? gateReason(row.latest.summary)
                            : row.latest.summary}
                        </p>
                        {/* oxlint-enable t3code/no-native-title-tooltip */}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center justify-end gap-1">
                          {["failed", "lost", "timed_out", "ambiguous"].includes(
                            row.latest.status,
                          ) ? (
                            <Button
                              disabled={pending || !canOperate}
                              size="xs"
                              variant="outline"
                              onClick={() => void submit({ _tag: "retry", step: row.key })}
                            >
                              <RotateCcwIcon />
                              Retry
                            </Button>
                          ) : null}
                          {row.latest.threadId ? (
                            <Button
                              size="xs"
                              variant="ghost-muted"
                              render={
                                <Link
                                  to="/$environmentId/$threadId"
                                  params={{ environmentId, threadId: row.latest.threadId }}
                                />
                              }
                            >
                              Thread
                            </Button>
                          ) : null}
                          <Button
                            variant="ghost-muted"
                            size="xs"
                            onClick={() => setDetail(row.latest)}
                          >
                            Details
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </WorkflowsSection>
        {view.gates.some((g) => g.decision) ? (
          <WorkflowsSection title="Decided gates">
            <div className="flex flex-col gap-2 px-(--workspace-gutter-start) py-3 pr-(--workspace-gutter-end)">
              {view.gates.map((g) =>
                g.decision ? (
                  <div key={g.key} className="text-muted-foreground text-xs">
                    <p>
                      {gateReasonOf(g)}:{" "}
                      <span className="text-foreground">{g.decision.option}</span>
                      {" · "}
                      <time dateTime={g.decision.at}>
                        {formatRelativeTimeLabel(g.decision.at, now)}
                      </time>
                    </p>
                    {g.decision.note ? (
                      <p className="mt-1 whitespace-pre-wrap">{g.decision.note}</p>
                    ) : null}
                  </div>
                ) : null,
              )}
            </div>
          </WorkflowsSection>
        ) : null}
        {view.blocks.length > 0 ? (
          <div className="px-(--workspace-gutter-start) pr-(--workspace-gutter-end)">
            <BlockViews blocks={view.blocks} />
          </div>
        ) : null}
        <WorkflowsSection
          title={
            <button
              type="button"
              aria-expanded={showMetrics}
              className="flex cursor-pointer items-center gap-2"
              onClick={() => setShowMetrics((value) => !value)}
            >
              {showMetrics ? (
                <ChevronDownIcon aria-hidden className="size-3.5 text-muted-foreground" />
              ) : (
                <ChevronRightIcon aria-hidden className="size-3.5 text-muted-foreground" />
              )}
              Workflow metrics
            </button>
          }
        >
          {showMetrics ? (
            <div className="px-(--workspace-gutter-start) py-3 pr-(--workspace-gutter-end)">
              <WorkflowMetricsPanel environmentId={environmentId} workflowId={summary.workflowId} />
            </div>
          ) : null}
        </WorkflowsSection>
        {triggerOpen ? (
          <TriggerSheet
            environmentId={environmentId}
            runId={summary.runId}
            trigger={view.trigger}
            onClose={() => setTriggerOpen(false)}
          />
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
              .filter((s) => s.key === gate.step && s.status !== "waiting_gate")
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

/** One labelled fact in the run's header strip. */
function Fact(props: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-muted-foreground text-xs">{props.label}</dt>
      <dd className="min-w-0">{props.children}</dd>
    </div>
  );
}
