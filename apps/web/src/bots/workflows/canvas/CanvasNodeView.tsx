/* oxlint-disable shadcn/no-unknown-classes -- Canvas classes are defined in the lazy canvas.css asset. */
/* oxlint-disable t3code/no-manual-memo -- The canvas contract requires rough geometry to depend only on stable drawing inputs. */
/* oxlint-disable t3code/no-native-title-tooltip -- The canvas contract requires a native title on the truncated subtitle. */
import { useMemo, useState, useContext } from "react";
import { Handle, Position, type NodeProps } from "@xyflow/react";
import rough from "roughjs";
import {
  CANVAS_NODE_STYLES,
  CANVAS_HUES,
  CANVAS_ROUGH,
  CANVAS_FRAME_DASH,
  CANVAS_STATUS_MARKS,
  canvasStatusMark,
  canvasShapePath,
  canvasSeed,
} from "@t3tools/client-runtime/workflows";
import type { WorkflowFlowNode } from "./reactFlowAdapter";
import { NoteEdit } from "./CanvasContext";
import { canvasIcons } from "./canvasIcons";
const generator = rough.generator();
const hasInput = (shape: string) => shape !== "entry";
export function Box({ id, data, width = 200, height = 64 }: NodeProps<WorkflowFlowNode>) {
  const edit = useContext(NoteEdit);
  const [editing, setEditing] = useState(false);
  const model = "model" in data ? data.model : null;
  const annotation = "annotation" in data ? data.annotation : null;
  const style = CANVAS_NODE_STYLES[model?.kind ?? "note"];
  const { shape, fill } = style;
  const hue = CANVAS_HUES[style.hue];
  const stroke = `light-dark(${hue.light.stroke}, ${hue.dark.stroke})`;
  const ink =
    fill === "solid"
      ? `light-dark(${hue.light.fill}, color-mix(in srgb, ${hue.dark.fill} 35%, transparent))`
      : `light-dark(${hue.light.fill}, ${hue.dark.fill})`;
  const paths = useMemo(
    () =>
      generator.toPaths(
        generator.path(canvasShapePath(shape, width, height), {
          ...CANVAS_ROUGH,
          seed: canvasSeed(id),
          fillStyle: fill,
          stroke: "S",
          ...(fill === "none" ? {} : { fill: "F" }),
          ...(shape === "frame" ? { strokeLineDash: [...CANVAS_FRAME_DASH] } : {}),
        }),
      ),
    [id, shape, fill, width, height],
  );
  const mark = model?.status ? canvasStatusMark(model.status) : undefined;
  const status = mark ? CANVAS_STATUS_MARKS[mark] : undefined;
  const tone = status
    ? `var(--${status.tone === "danger" ? "destructive" : status.tone === "muted" ? "muted-foreground" : status.tone})`
    : undefined;
  const Icon = canvasIcons[style.icon];
  const Badge = status?.icon ? canvasIcons[status.icon] : null;
  return (
    <div
      style={{
        width,
        height,
        position: "relative",
        color: "var(--foreground)",
        opacity: mark === "dim" ? 0.5 : 1,
      }}
    >
      <svg
        width={width}
        height={height}
        style={{ position: "absolute", pointerEvents: "none", overflow: "visible" }}
      >
        {mark && mark !== "dim" && (
          <path
            d={canvasShapePath(shape, width + 12, height + 12)}
            transform="translate(-6 -6)"
            fill="none"
            stroke={tone}
            strokeWidth={mark === "ok" ? 2 : 3}
          />
        )}
        {mark === "failed" && (
          <path d={canvasShapePath(shape, width, height)} fill={tone} opacity={0.12} />
        )}
        {paths.map((p) => (
          <path
            key={p.d}
            d={p.d}
            fill={p.fill === "F" ? ink : p.fill}
            stroke={p.stroke === "F" ? ink : stroke}
            opacity={p.stroke === "F" ? 0.55 : 1}
            strokeWidth={p.strokeWidth}
          />
        ))}
      </svg>
      <div
        className={`wf-content ${shape === "frame" ? "wf-header" : ""}`}
        onDoubleClick={() => annotation && edit && setEditing(true)}
      >
        {editing && annotation ? (
          <textarea
            onPointerDown={(e) => e.stopPropagation()}
            onWheel={(e) => e.stopPropagation()}
            aria-label="Note text"
            defaultValue={annotation.text}
            onBlur={(e) => {
              edit?.(id, e.target.value);
              setEditing(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") e.currentTarget.blur();
            }}
          />
        ) : model ? (
          <>
            <Icon size={16} color={stroke} />
            <div className="wf-label">
              <div className="wf-name">{model.label}</div>
              <div className="wf-subtitle" title={model.subtitle}>
                {model.subtitle}
              </div>
            </div>
          </>
        ) : (
          <div className="wf-note">{annotation?.text}</div>
        )}
      </div>
      {Badge && (
        <span
          role="img"
          aria-label={status?.label}
          className="wf-badge"
          style={{ background: tone }}
        >
          <Badge size={13} color="white" />
        </span>
      )}
      {model && (
        <>
          {hasInput(shape) && (
            <Handle
              type="target"
              position={Position.Left}
              style={{ background: "var(--background)", borderColor: stroke, width: 8, height: 8 }}
            />
          )}
          {model.ports.map((port, i) => (
            <Handle
              key={port}
              id={port}
              type="source"
              position={Position.Right}
              style={{
                background: "var(--background)",
                borderColor: stroke,
                width: 8,
                height: 8,
                top: `${(100 * (i + 1)) / (model.ports.length + 1)}%`,
              }}
            />
          ))}
        </>
      )}
    </div>
  );
}
