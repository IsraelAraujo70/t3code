import {
  describeTrigger,
  formatDuration,
  isAutomaticTrigger,
  liveActiveMs,
  runStatusLabel,
} from "@t3tools/client-runtime/workflows";
import type {
  EnvironmentId,
  WorkflowRunSummary,
  WorkflowSummary,
  WorkflowTriggerSummary,
} from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  CircleAlertIcon,
  CirclePauseIcon,
  EllipsisIcon,
  HandIcon,
  PencilIcon,
  PlayIcon,
  Trash2Icon,
} from "lucide-react";

import { cn, randomUUID } from "~/lib/utils";
import { Button } from "../../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../../components/ui/menu";
import { Switch } from "../../components/ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { BotAvatar } from "../BotAvatar";
import { confirmDestructive, reportCommandResult } from "../botsSettingsShared";
import { TriggerIcon } from "./run/TriggerIcon";
import { workflowsEnvironment } from "./state";
import { RunStatusIcon, WorkflowToneBadge } from "./WorkflowStatusBadge";

const LOCAL_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Why a workflow cannot be run by hand right now; null when Run now works. */
export function runBlockedReason(workflow: WorkflowSummary): string | null {
  if (!workflow.valid) return "Fix the workflow's errors before running it.";
  if (workflow.suspended) return "Suspended after repeated failures; it cannot run until resumed.";
  if (!workflow.triggers.some((trigger) => trigger.kind === "manual"))
    return "No Run now trigger. Add one in the editor to run it by hand.";
  return null;
}

/** The later-started of two runs; either may be missing. */
export function newerRun(
  a: WorkflowRunSummary | null | undefined,
  b: WorkflowRunSummary | null | undefined,
): WorkflowRunSummary | null {
  if (!a) return b ?? null;
  if (!b) return a;
  return Date.parse(b.startedAt) > Date.parse(a.startedAt) ? b : a;
}

/** A run's time: active time while it runs or once measured, wall time otherwise. */
export function runDurationMs(run: WorkflowRunSummary, now: number): number | null {
  const active = liveActiveMs(run, now);
  if (active !== null) return active;
  return run.endedAt === null
    ? null
    : Math.max(0, Date.parse(run.endedAt) - Date.parse(run.startedAt));
}

/** `now` for relative labels, ticking once a minute. */
export function useNowMs(): number {
  return Date.parse(`${useNowMinute()}:00Z`);
}

/** One workflow as a two-line list row: state, title and description, triggers, last run, controls. */
export function WorkflowListRow(props: {
  environmentId: EnvironmentId;
  workflow: WorkflowSummary;
  /** The newest run known to the page, which may be fresher than `workflow.lastRun`. */
  lastRun: WorkflowRunSummary | null;
  onRun: () => void;
}) {
  const { environmentId, workflow } = props;
  const navigate = useNavigate();
  const setEnabled = useAtomCommand(workflowsEnvironment.setEnabled, {
    label: "workflow enable",
  });
  const remove = useAtomCommand(workflowsEnvironment.remove, { label: "workflow delete" });
  const blocked = runBlockedReason(workflow);
  const openGates = props.lastRun?.openGates ?? 0;
  const editor = {
    to: "/workflows/$environmentId/$workflowId",
    params: { environmentId, workflowId: workflow.workflowId },
  } as const;

  const deleteWorkflow = async () => {
    if (
      !(await confirmDestructive(
        `Delete "${workflow.title}"?\nIts file leaves the definitions repository. You can restore it from Deleted.`,
      ))
    )
      return;
    reportCommandResult(
      "Could not delete the workflow",
      await remove({ environmentId, input: { workflowId: workflow.workflowId } }),
    );
  };

  return (
    <div
      className="group/row flex min-h-14 items-center gap-3 border-b py-2 pr-(--workspace-gutter-end) pl-(--workspace-gutter-start) hover:bg-accent/30"
      data-testid="workflow-row"
    >
      <WorkflowStateGlyph workflow={workflow} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <Link {...editor} className="min-w-0 shrink truncate font-medium text-sm hover:underline">
            {workflow.title}
          </Link>
          {workflow.bot ? <WorkflowBot bot={workflow.bot} /> : null}
          {!workflow.valid ? (
            <WorkflowToneBadge tone="danger">
              {`${workflow.diagnostics} error${workflow.diagnostics === 1 ? "" : "s"}`}
            </WorkflowToneBadge>
          ) : null}
          {workflow.suspended ? (
            <WorkflowToneBadge tone="warning">Suspended</WorkflowToneBadge>
          ) : null}
          {workflow.dirty ? (
            <WorkflowToneBadge tone="warning">Edited by hand</WorkflowToneBadge>
          ) : null}
          {workflow.description ? (
            <span className="hidden min-w-0 flex-1 truncate text-muted-foreground text-xs md:block">
              {workflow.description}
            </span>
          ) : null}
        </div>
        <TriggerLine triggers={workflow.triggers} dimmed={!workflow.enabled} />
      </div>
      <LastRun environmentId={environmentId} run={props.lastRun} openGates={openGates} />
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" />}>
          <Switch
            aria-label={workflow.enabled ? "Turn workflow off" : "Turn workflow on"}
            checked={workflow.enabled}
            onCheckedChange={(enabled) =>
              void setEnabled({
                environmentId,
                input: {
                  workflowId: workflow.workflowId,
                  enabled,
                  clientRequestId: randomUUID(),
                },
              }).then((result) => reportCommandResult("Could not change the workflow", result))
            }
          />
        </TooltipTrigger>
        <TooltipPopup>
          {workflow.enabled
            ? "On: its triggers start runs"
            : "Off: only Run now starts it, triggers wait"}
        </TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger render={<span className="inline-flex" />}>
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Run now"
            disabled={blocked !== null}
            onClick={props.onRun}
          >
            <PlayIcon />
          </Button>
        </TooltipTrigger>
        <TooltipPopup>{blocked ?? "Run now…"}</TooltipPopup>
      </Tooltip>
      <span className="opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100 has-data-popup-open:opacity-100 pointer-coarse:opacity-100">
        <Menu>
          <MenuTrigger
            render={
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={`More actions for ${workflow.title}`}
              />
            }
          >
            <EllipsisIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            <MenuItem onClick={() => void navigate(editor)}>
              <PencilIcon />
              Open editor
            </MenuItem>
            <MenuItem disabled={blocked !== null} onClick={props.onRun}>
              <PlayIcon />
              Run now…
            </MenuItem>
            <MenuSeparator />
            <MenuItem variant="destructive" onClick={() => void deleteWorkflow()}>
              <Trash2Icon />
              Delete…
            </MenuItem>
          </MenuPopup>
        </Menu>
      </span>
    </div>
  );
}

/** The bot the workflow works for: its face and name, or a warning when the bot is gone. */
function WorkflowBot(props: { bot: NonNullable<WorkflowSummary["bot"]> }) {
  const { bot } = props;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1 text-xs",
              bot.name === null ? "text-warning" : "text-muted-foreground",
            )}
          />
        }
      >
        <BotAvatar botId={bot.id} size={14} />
        <span className="max-w-32 truncate">{bot.name ?? bot.id}</span>
      </TooltipTrigger>
      <TooltipPopup>
        {bot.name === null
          ? `Bot ${bot.id} no longer exists; its steps run without its tools`
          : `Works for ${bot.name}: its agent steps get the bot's tools`}
      </TooltipPopup>
    </Tooltip>
  );
}

/** Left-edge glyph: a problem when there is one, else a dot for on or off. */
function WorkflowStateGlyph(props: { workflow: WorkflowSummary }) {
  const { workflow } = props;
  const label = !workflow.valid
    ? "Does not compile; its triggers are paused"
    : workflow.suspended
      ? "Suspended after repeated failures"
      : workflow.enabled
        ? "On"
        : "Off";
  return (
    <Tooltip>
      <TooltipTrigger
        render={<span className="flex size-3.5 shrink-0 items-center justify-center" />}
      >
        {!workflow.valid ? (
          <CircleAlertIcon aria-hidden className="size-3.5 text-destructive" />
        ) : workflow.suspended ? (
          <CirclePauseIcon aria-hidden className="size-3.5 text-warning" />
        ) : workflow.enabled ? (
          <span aria-hidden className="size-2 rounded-full bg-success" />
        ) : (
          <span aria-hidden className="size-2 rounded-full border border-muted-foreground/60" />
        )}
        <span className="sr-only">{label}</span>
      </TooltipTrigger>
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}

/** What starts the workflow, in words; Run now is the row's own button, so it is left out. */
function TriggerLine(props: { triggers: ReadonlyArray<WorkflowTriggerSummary>; dimmed: boolean }) {
  const shown = props.triggers
    .filter((trigger) => trigger.kind !== "manual")
    .toSorted((a, b) => Number(isAutomaticTrigger(b.kind)) - Number(isAutomaticTrigger(a.kind)));
  if (shown.length === 0) {
    return (
      <span className="text-muted-foreground/70 text-xs">
        {props.triggers.length === 0 ? "No triggers" : "Runs only when started by hand"}
      </span>
    );
  }
  return (
    <div
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-muted-foreground text-xs",
        props.dimmed && "opacity-70",
      )}
    >
      {shown.map((trigger) => (
        <TriggerItem key={trigger.id} trigger={trigger} />
      ))}
    </div>
  );
}

function TriggerItem(props: { trigger: WorkflowTriggerSummary }) {
  const { trigger } = props;
  const { text, detail } = describeTrigger(trigger, LOCAL_TIME_ZONE);
  const off = !trigger.enabled;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "inline-flex min-w-0 max-w-full items-center gap-1",
              off && "line-through decoration-muted-foreground/50 opacity-50",
            )}
          />
        }
      >
        <TriggerIcon kind={trigger.kind} />
        <span className="truncate">{text}</span>
      </TooltipTrigger>
      <TooltipPopup>
        <div className="flex max-w-80 flex-col gap-0.5">
          <span>
            {off ? "Off · " : ""}
            {isAutomaticTrigger(trigger.kind)
              ? "Starts a run on its own"
              : "Starts a run on request"}
          </span>
          {detail === "" ? null : (
            <span className="break-all font-mono text-muted-foreground text-xs">{detail}</span>
          )}
          {trigger.lastFiredAt === null ? null : (
            <span className="text-muted-foreground text-xs">
              Last fired {formatRelativeTimeLabel(trigger.lastFiredAt)}
            </span>
          )}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

/** The latest run: a link with its status glyph and age, or "Needs you" while a gate waits. */
function LastRun(props: {
  environmentId: EnvironmentId;
  run: WorkflowRunSummary | null;
  openGates: number;
}) {
  const now = useNowMs();
  const { run } = props;
  if (run === null) {
    return (
      <span className="hidden w-32 shrink-0 text-muted-foreground/70 text-xs sm:block">
        Never run
      </span>
    );
  }
  const duration = runDurationMs(run, now);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Link
            to="/workflows/$environmentId/runs/$runId"
            params={{ environmentId: props.environmentId, runId: run.runId }}
            className="hidden w-32 shrink-0 items-center gap-1.5 truncate rounded text-muted-foreground text-xs hover:text-foreground sm:flex"
          />
        }
      >
        {props.openGates > 0 ? (
          <>
            <HandIcon aria-hidden className="size-3.5 shrink-0 text-warning" />
            <span className="truncate text-warning">Needs you</span>
          </>
        ) : (
          <>
            <RunStatusIcon status={run.status} />
            <span className="truncate">{formatRelativeTimeLabel(run.startedAt, now)}</span>
          </>
        )}
      </TooltipTrigger>
      <TooltipPopup>
        {props.openGates > 0 && run.gate ? (
          <span className="block max-w-72">Needs you: {run.gate.reason}</span>
        ) : (
          <>
            Last run: {runStatusLabel(run.status)}
            {duration === null ? "" : ` in ${formatDuration(duration)}`}
          </>
        )}
      </TooltipPopup>
    </Tooltip>
  );
}
