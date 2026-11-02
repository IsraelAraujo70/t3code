/**
 * How the workflow canvas draws each node type (friend fork), shared by the web canvas and the
 * Android graph. A new node type is one row in `CANVAS_NODE_STYLES`: renderers switch on `shape`
 * and look icons up by `icon`, never by type.
 */
import type { WorkflowNodeKind, WorkflowStepStatus } from "@t3tools/contracts";

import type { WorkflowTone } from "./workflows.run.ts";

/** Every type the canvas draws: the workflow node kinds plus free notes. */
type CanvasNodeType = WorkflowNodeKind | "note";
/** `entry` has no input handle (a workflow's starting point); `pill` is a terminal output. */
type CanvasShape = "box" | "octagon" | "hexagon" | "pill" | "frame" | "note" | "entry";
/** roughjs `fillStyle`; `none` draws the outline only. */
type CanvasFillStyle = "hachure" | "cross-hatch" | "zigzag" | "dots" | "solid" | "none";
/** Semantic icon keys; each client maps every key to its own icon set. */
export type CanvasIcon =
  | "agent"
  | "command"
  | "gate"
  | "branch"
  | "output"
  | "call"
  | "map"
  | "loop"
  | "hillclimb"
  | "arena"
  | "graph"
  | "interrogate"
  | "note"
  | "running"
  | "waiting"
  | "failed"
  | "ok";

interface CanvasInk {
  readonly stroke: string;
  readonly fill: string;
}
/** Open Color shades: stroke 8 / fill 2 on light, stroke 3 / fill 7 on dark. */
export const CANVAS_HUES = {
  gray: {
    light: { stroke: "#343a40", fill: "#e9ecef" },
    dark: { stroke: "#dee2e6", fill: "#495057" },
  },
  violet: {
    light: { stroke: "#6741d9", fill: "#d0bfff" },
    dark: { stroke: "#b197fc", fill: "#7048e8" },
  },
  orange: {
    light: { stroke: "#e8590c", fill: "#ffd8a8" },
    dark: { stroke: "#ffc078", fill: "#f76707" },
  },
  lime: {
    light: { stroke: "#66a80f", fill: "#d8f5a2" },
    dark: { stroke: "#c0eb75", fill: "#74b816" },
  },
  green: {
    light: { stroke: "#2f9e44", fill: "#b2f2bb" },
    dark: { stroke: "#8ce99a", fill: "#37b24d" },
  },
  cyan: {
    light: { stroke: "#0c8599", fill: "#99e9f2" },
    dark: { stroke: "#66d9e8", fill: "#1098ad" },
  },
  blue: {
    light: { stroke: "#1971c2", fill: "#a5d8ff" },
    dark: { stroke: "#74c0fc", fill: "#1c7ed6" },
  },
  teal: {
    light: { stroke: "#099268", fill: "#96f2d7" },
    dark: { stroke: "#63e6be", fill: "#0ca678" },
  },
  grape: {
    light: { stroke: "#9c36b5", fill: "#eebefa" },
    dark: { stroke: "#e599f7", fill: "#ae3ec9" },
  },
  indigo: {
    light: { stroke: "#3b5bdb", fill: "#bac8ff" },
    dark: { stroke: "#91a7ff", fill: "#4263eb" },
  },
  pink: {
    light: { stroke: "#c2255c", fill: "#fcc2d7" },
    dark: { stroke: "#faa2c1", fill: "#d6336c" },
  },
  yellow: {
    light: { stroke: "#f08c00", fill: "#ffec99" },
    dark: { stroke: "#ffe066", fill: "#f59f00" },
  },
} as const satisfies Record<string, { readonly light: CanvasInk; readonly dark: CanvasInk }>;
type CanvasHue = keyof typeof CANVAS_HUES;

interface CanvasNodeStyle {
  /** Lowercase type name, the first word of the subtitle. */
  readonly label: string;
  readonly hue: CanvasHue;
  readonly shape: CanvasShape;
  readonly fill: CanvasFillStyle;
  readonly icon: CanvasIcon;
}

// Red stays out of the node hues: it belongs to the failed status.
export const CANVAS_NODE_STYLES = {
  agent: { label: "agent", hue: "violet", shape: "box", fill: "hachure", icon: "agent" },
  command: { label: "command", hue: "gray", shape: "box", fill: "hachure", icon: "command" },
  gate: { label: "gate", hue: "orange", shape: "octagon", fill: "cross-hatch", icon: "gate" },
  branch: { label: "branch", hue: "lime", shape: "hexagon", fill: "cross-hatch", icon: "branch" },
  output: { label: "output", hue: "green", shape: "pill", fill: "solid", icon: "output" },
  call: { label: "call", hue: "cyan", shape: "box", fill: "hachure", icon: "call" },
  map: { label: "map", hue: "blue", shape: "frame", fill: "none", icon: "map" },
  loop: { label: "loop", hue: "blue", shape: "frame", fill: "none", icon: "loop" },
  hillclimb: { label: "hillclimb", hue: "teal", shape: "box", fill: "zigzag", icon: "hillclimb" },
  arena: { label: "arena", hue: "grape", shape: "box", fill: "zigzag", icon: "arena" },
  graph: { label: "graph", hue: "indigo", shape: "box", fill: "zigzag", icon: "graph" },
  interrogate: {
    label: "interrogate",
    hue: "pink",
    shape: "box",
    fill: "zigzag",
    icon: "interrogate",
  },
  note: { label: "note", hue: "yellow", shape: "note", fill: "solid", icon: "note" },
} as const satisfies Record<CanvasNodeType, CanvasNodeStyle>;

/** How a step status shows on its node. */
type CanvasStatusMark = "running" | "waiting" | "failed" | "ok" | "dim";
export const CANVAS_STATUS_MARKS = {
  running: { tone: "info", icon: "running", label: "Running" },
  waiting: { tone: "warning", icon: "waiting", label: "Waiting for you" },
  failed: { tone: "danger", icon: "failed", label: "Failed" },
  ok: { tone: "success", icon: "ok", label: "Succeeded" },
  dim: { tone: "muted", icon: null, label: "Not run" },
} as const satisfies Record<
  CanvasStatusMark,
  { readonly tone: WorkflowTone; readonly icon: CanvasIcon | null; readonly label: string }
>;

const STATUS_MARKS = {
  pending: "dim",
  dispatched: "running",
  running: "running",
  waiting_gate: "waiting",
  succeeded: "ok",
  failed: "failed",
  skipped: "dim",
  cancelled: "dim",
  lost: "failed",
  timed_out: "failed",
  ambiguous: "waiting",
} as const satisfies Record<WorkflowStepStatus, CanvasStatusMark>;
export const canvasStatusMark = (status: WorkflowStepStatus): CanvasStatusMark =>
  STATUS_MARKS[status];

/** roughjs options every client draws node outlines with; `seed`, colors and `fillStyle` come per node. */
export const CANVAS_ROUGH = {
  roughness: 1.1,
  bowing: 0.8,
  strokeWidth: 1.6,
  fillWeight: 1,
  hachureGap: 7,
  hachureAngle: -41,
} as const;
/** Dash of a `frame` outline. */
export const CANVAS_FRAME_DASH = [8, 6] as const;

/** A stable nonzero roughjs seed, so a node or edge draws the same strokes on every render. */
export const canvasSeed = (id: string): number =>
  [...id].reduce((seed, char) => (seed * 31 + char.charCodeAt(0)) >>> 0, 1) || 1;

/**
 * The outline of `shape` as an SVG path inside the box (0,0)–(w,h). roughjs draws it with
 * `generator.path`; a status halo is the same outline of a box grown on every side.
 */
export const canvasShapePath = (shape: CanvasShape, w: number, h: number): string => {
  const rounded = (r: number) =>
    `M ${r} 0 H ${w - r} A ${r} ${r} 0 0 1 ${w} ${r} V ${h - r} A ${r} ${r} 0 0 1 ${w - r} ${h}` +
    ` H ${r} A ${r} ${r} 0 0 1 0 ${h - r} V ${r} A ${r} ${r} 0 0 1 ${r} 0 Z`;
  switch (shape) {
    case "box":
      return rounded(Math.min(12, h / 4));
    case "frame":
      return rounded(Math.min(18, h / 4));
    case "pill":
      return rounded(h / 2);
    case "octagon": {
      const c = Math.min(18, h / 3);
      return `M ${c} 0 H ${w - c} L ${w} ${c} V ${h - c} L ${w - c} ${h} H ${c} L 0 ${h - c} V ${c} Z`;
    }
    case "hexagon": {
      const t = Math.min(22, w / 6);
      return `M ${t} 0 H ${w - t} L ${w} ${h / 2} L ${w - t} ${h} H ${t} L 0 ${h / 2} Z`;
    }
    case "note": {
      const f = Math.min(18, h / 4);
      return `M 0 0 H ${w - f} L ${w} ${f} V ${h} H 0 Z`;
    }
    case "entry": {
      const r = h / 2;
      return `M ${r} 0 H ${w} V ${h} H ${r} A ${r} ${r} 0 0 1 ${r} 0 Z`;
    }
  }
};
