import type { WorkflowRunStatus, WorkflowStepStatus } from "@t3tools/contracts";
import type { WorkflowTone } from "@t3tools/client-runtime/workflows";
import { View } from "react-native";
import { useResolveClassNames } from "uniwind";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { cn } from "../../lib/cn";

const toneClasses = {
  neutral: "text-foreground",
  muted: "text-foreground-muted",
  info: "text-primary",
  success: "text-primary",
  warning: "text-warning-foreground",
  danger: "text-danger-foreground",
} satisfies Record<WorkflowTone, string>;

const toneTints = {
  neutral: "accent-foreground",
  muted: "accent-foreground-muted",
  info: "accent-primary",
  success: "accent-primary",
  warning: "accent-warning-foreground",
  danger: "accent-danger-foreground",
} satisfies Record<WorkflowTone, string>;

/** Resolve workflow tones against the active mobile theme, for SVG strokes. */
export function useWorkflowColors() {
  const neutral = useResolveClassNames(toneClasses.neutral).color;
  const muted = useResolveClassNames(toneClasses.muted).color;
  const info = useResolveClassNames(toneClasses.info).color;
  const success = useResolveClassNames(toneClasses.success).color;
  const warning = useResolveClassNames(toneClasses.warning).color;
  const danger = useResolveClassNames(toneClasses.danger).color;
  const color = (value: typeof neutral) => (typeof value === "string" ? value : "currentColor");
  return {
    neutral: color(neutral),
    muted: color(muted),
    info: color(info),
    success: color(success),
    warning: color(warning),
    danger: color(danger),
  };
}

const RUN_ICONS = {
  queued: "clock",
  skipped: "slash.circle",
  running: "circle.dashed",
  paused: "pause",
  succeeded: "checkmark.circle.fill",
  failed: "xmark.circle.fill",
  cancelled: "slash.circle",
  budget_exhausted: "exclamationmark.triangle",
} satisfies Record<WorkflowRunStatus, AppSymbolName>;

const STEP_ICONS = {
  pending: "circle",
  dispatched: "circle.dashed",
  running: "circle.dashed",
  waiting_gate: "exclamationmark.circle",
  succeeded: "checkmark.circle.fill",
  failed: "xmark.circle.fill",
  skipped: "slash.circle",
  cancelled: "slash.circle",
  lost: "exclamationmark.triangle",
  timed_out: "clock",
  ambiguous: "exclamationmark.triangle",
} satisfies Record<WorkflowStepStatus, AppSymbolName>;

/** The glyph a run shows: a run that waits for the user reads as that, whatever its status. */
export const runIcon = (status: WorkflowRunStatus, needsYou: boolean): AppSymbolName =>
  needsYou ? "exclamationmark.circle" : RUN_ICONS[status];

export const stepIcon = (status: WorkflowStepStatus): AppSymbolName => STEP_ICONS[status];

/** A status glyph tinted by its tone. */
export function StatusGlyph(props: {
  readonly icon: AppSymbolName;
  readonly tone: WorkflowTone;
  readonly size?: number;
}) {
  return (
    <SymbolView
      name={props.icon}
      size={props.size ?? 18}
      tintColorClassName={toneTints[props.tone]}
      type="monochrome"
    />
  );
}

/** A status in words, colored by tone, with its glyph. */
export function StatusLabel(props: {
  readonly icon: AppSymbolName;
  readonly label: string;
  readonly tone: WorkflowTone;
  readonly large?: boolean;
}) {
  return (
    <View className="flex-row items-center gap-1.5">
      <StatusGlyph icon={props.icon} tone={props.tone} size={props.large ? 20 : 13} />
      <Text
        className={cn(
          props.large ? "text-base font-t3-bold" : "text-2xs font-t3-medium",
          toneClasses[props.tone],
        )}
        numberOfLines={1}
      >
        {props.label}
      </Text>
    </View>
  );
}
