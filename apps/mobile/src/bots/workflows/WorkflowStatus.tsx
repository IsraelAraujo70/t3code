import type { WorkflowTone } from "@t3tools/client-runtime/workflows";
import { View } from "react-native";
import { useResolveClassNames } from "uniwind";
import { Chip } from "../../components/ui/Chip";

const toneClasses = {
  neutral: "text-foreground",
  muted: "text-foreground-muted",
  info: "text-primary",
  success: "text-primary",
  warning: "text-warning-foreground",
  danger: "text-danger-foreground",
} satisfies Record<WorkflowTone, string>;

/** Resolve workflow tones against the active mobile theme, including SVG strokes. */
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

/** A theme-colored status marker alongside the app's compact chip. */
export function WorkflowStatus({ label, tone }: { label: string; tone: WorkflowTone }) {
  const colors = useWorkflowColors();
  return (
    <View className="flex-row items-center gap-2">
      <View style={{ backgroundColor: colors[tone], width: 8, height: 8, borderRadius: 4 }} />
      <Chip label={label} size="small" />
    </View>
  );
}
