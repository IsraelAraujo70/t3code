import {
  runStatusLabel,
  runStatusTone,
  stepStatusLabel,
  stepStatusTone,
  type WorkflowTone,
} from "@t3tools/client-runtime/workflows";
import type { WorkflowRunStatus, WorkflowStepStatus } from "@t3tools/contracts";

import { Badge } from "../../components/ui/badge";

const TONE_VARIANT = {
  neutral: "outline",
  info: "info",
  success: "success",
  warning: "warning",
  danger: "error",
  muted: "secondary",
} as const satisfies Record<WorkflowTone, string>;

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

export function StepStatusBadge(props: { status: WorkflowStepStatus }) {
  return (
    <WorkflowToneBadge tone={stepStatusTone(props.status)}>
      {stepStatusLabel(props.status)}
    </WorkflowToneBadge>
  );
}
