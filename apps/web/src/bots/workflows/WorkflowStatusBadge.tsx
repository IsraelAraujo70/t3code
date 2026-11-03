import {
  runStatusLabel,
  runStatusTone,
  stepStatusLabel,
  stepStatusTone,
  type WorkflowTone,
} from "@t3tools/client-runtime/workflows";
import type { WorkflowRunStatus, WorkflowStepStatus } from "@t3tools/contracts";
import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleMinusIcon,
  CirclePauseIcon,
  CircleSlashIcon,
  CircleXIcon,
  type LucideIcon,
} from "lucide-react";

import { cn } from "~/lib/utils";
import { Badge } from "../../components/ui/badge";

const TONE_VARIANT = {
  neutral: "outline",
  info: "info",
  success: "success",
  warning: "warning",
  danger: "error",
  muted: "secondary",
} as const satisfies Record<WorkflowTone, string>;

const TONE_TEXT = {
  neutral: "text-foreground",
  info: "text-info",
  success: "text-success",
  warning: "text-warning",
  danger: "text-destructive",
  muted: "text-muted-foreground",
} as const satisfies Record<WorkflowTone, string>;

// A running run gets a still glyph: a spinner here would repaint every frame for as long as it runs.
const RUN_STATUS_ICON = {
  queued: CircleDashedIcon,
  skipped: CircleSlashIcon,
  running: CircleDotIcon,
  paused: CirclePauseIcon,
  succeeded: CircleCheckIcon,
  failed: CircleXIcon,
  cancelled: CircleMinusIcon,
  budget_exhausted: CircleAlertIcon,
} as const satisfies Record<WorkflowRunStatus, LucideIcon>;

export function WorkflowToneBadge(props: { tone: WorkflowTone; children: string }) {
  return (
    <Badge size="sm" variant={TONE_VARIANT[props.tone]}>
      {props.children}
    </Badge>
  );
}

export function RunStatusBadge(props: { status: WorkflowRunStatus }) {
  return (
    <WorkflowToneBadge tone={runStatusTone(props.status)}>
      {runStatusLabel(props.status)}
    </WorkflowToneBadge>
  );
}

/** A run's status as a colored glyph, for dense rows; pair it with the label or a tooltip. */
export function RunStatusIcon(props: { status: WorkflowRunStatus; className?: string }) {
  const Icon = RUN_STATUS_ICON[props.status];
  return (
    <Icon
      aria-hidden
      className={cn("size-3.5 shrink-0", TONE_TEXT[runStatusTone(props.status)], props.className)}
    />
  );
}

/** A run's status as glyph plus label, in the tone's color. */
export function RunStatusLabel(props: { status: WorkflowRunStatus }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <RunStatusIcon status={props.status} />
      <span className="truncate">{runStatusLabel(props.status)}</span>
    </span>
  );
}

export function StepStatusBadge(props: { status: WorkflowStepStatus }) {
  return (
    <WorkflowToneBadge tone={stepStatusTone(props.status)}>
      {stepStatusLabel(props.status)}
    </WorkflowToneBadge>
  );
}
