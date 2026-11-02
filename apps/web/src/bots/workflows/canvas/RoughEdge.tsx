/* oxlint-disable shadcn/no-unknown-classes -- Canvas classes are defined in the lazy canvas.css asset. */
/* oxlint-disable t3code/no-manual-memo -- The canvas contract requires rough geometry to depend only on stable drawing inputs. */
import { useMemo } from "react";
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from "@xyflow/react";
import rough from "roughjs";
import { CANVAS_FRAME_DASH, canvasSeed } from "@t3tools/client-runtime/workflows";
const generator = rough.generator();
export function RoughEdge(props: EdgeProps) {
  const entry = props.data?.entry === true;
  const [path, labelX, labelY] = getBezierPath(props);
  const paths = useMemo(
    () =>
      generator.toPaths(
        generator.path(path, { seed: canvasSeed(props.id), roughness: 1.1, strokeWidth: 1.4 }),
      ),
    [props.id, path],
  );
  const arrow = `M ${props.targetX - 11} ${props.targetY - 6} L ${props.targetX} ${props.targetY} L ${props.targetX - 11} ${props.targetY + 6}`;
  const arrows = useMemo(
    () =>
      generator.toPaths(
        generator.path(arrow, { seed: canvasSeed(props.id), roughness: 1.1, strokeWidth: 1.4 }),
      ),
    [props.id, arrow],
  );
  return (
    <>
      <g pointerEvents="none" data-entry={entry ? "true" : undefined}>
        {paths.map((p) => (
          <path
            key={p.d}
            d={p.d}
            fill="none"
            stroke={
              props.selected
                ? "var(--ring)"
                : "color-mix(in srgb, var(--foreground) 65%, transparent)"
            }
            strokeDasharray={entry ? CANVAS_FRAME_DASH.join(" ") : undefined}
            strokeWidth={p.strokeWidth}
          />
        ))}
      </g>
      {!entry && props.label && (
        <EdgeLabelRenderer>
          <div
            className="wf-edge-label"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {props.label}
          </div>
        </EdgeLabelRenderer>
      )}
      {arrows.map((p) => (
        <path
          key={p.d}
          d={p.d}
          fill="none"
          stroke={
            props.selected
              ? "var(--ring)"
              : "color-mix(in srgb, var(--foreground) 65%, transparent)"
          }
          strokeWidth={p.strokeWidth}
        />
      ))}
      {!entry && (
        <BaseEdge
          id={props.id}
          path={path}
          interactionWidth={24}
          style={{ stroke: "transparent" }}
        />
      )}
    </>
  );
}
