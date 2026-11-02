import { CANVAS_NODE_STYLES, canvasTriggerType } from "@t3tools/client-runtime/workflows";
import { canvasIcons } from "../canvas/canvasIcons";

/** Resolves persisted trigger kinds, including kinds unknown to this client. */
export function TriggerIcon({ kind }: { kind: string }) {
  const known =
    kind === "bot" ||
    kind === "call" ||
    kind === "cron" ||
    kind === "manual" ||
    kind === "prMerged" ||
    kind === "threadSettled" ||
    kind === "upstreamTag" ||
    kind === "webhook" ||
    kind === "workflowFailed";
  const Icon = canvasIcons[CANVAS_NODE_STYLES[canvasTriggerType(known ? kind : "manual")].icon];
  return <Icon className="size-3.5" />;
}
