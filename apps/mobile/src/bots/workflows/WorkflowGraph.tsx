import {
  type CanvasModel,
  CANVAS_NODE_STYLES,
  CANVAS_HUES,
  CANVAS_ROUGH,
  CANVAS_FRAME_DASH,
  CANVAS_STATUS_MARKS,
  canvasStatusMark,
  canvasShapePath,
  canvasSeed,
} from "@t3tools/client-runtime/workflows";
import { useMemo } from "react";
import { useWorkflowColors } from "./WorkflowStatus";
import { ScrollView, useWindowDimensions } from "react-native";
import Svg, { G, Path, Text, Rect, Circle } from "react-native-svg";
import rough from "roughjs/bin/rough";
import { useResolveClassNames } from "uniwind";
import { edgePillSize, edgeGeometry, fitText, graphGeometry } from "./WorkflowGraph.logic";

import { useAppearancePreferences } from "../../features/settings/appearance/AppearancePreferencesProvider";

/** Read-only graph shared by workflow definitions and run views. */
export function WorkflowGraph({
  model,
  onPressNode,
}: {
  model: CanvasModel;
  onPressNode?: (id: string) => void;
}) {
  const { width } = useWindowDimensions();
  const geometry = graphGeometry(model, width - 32);
  const generator = useMemo(() => rough.generator(), []);
  const colors = useWorkflowColors();
  const color = useResolveClassNames("text-foreground").color;
  const foreground = typeof color === "string" ? color : colors.neutral;
  const fill = useResolveClassNames("bg-screen").backgroundColor;
  const background = typeof fill === "string" ? fill : "transparent";
  const { themeAppearance } = useAppearancePreferences();
  const dark = themeAppearance === "dark";
  const drawingKey = JSON.stringify(model.nodes.map(({ id, kind, w, h }) => ({ id, kind, w, h })));
  const drawings = useMemo(() => {
    const nodes: Pick<CanvasModel["nodes"][number], "id" | "kind" | "w" | "h">[] =
      JSON.parse(drawingKey);
    return new Map(
      nodes.map((node) => {
        const style = CANVAS_NODE_STYLES[node.kind];
        const hue = CANVAS_HUES[style.hue][dark ? "dark" : "light"];
        return [
          node.id,
          generator.toPaths(
            generator.path(canvasShapePath(style.shape, node.w, node.h), {
              ...CANVAS_ROUGH,
              seed: canvasSeed(node.id),
              fillStyle: style.fill,
              stroke: hue.stroke,
              ...(style.fill === "none" ? {} : { fill: hue.fill }),
            }),
          ),
        ];
      }),
    );
  }, [drawingKey, dark, generator]);
  const paths = (drawable: ReturnType<typeof generator.rectangle>) =>
    generator
      .toPaths(drawable)
      .map((path) => (
        <Path
          key={path.d}
          d={path.d}
          stroke={path.stroke}
          strokeWidth={path.strokeWidth}
          fill={path.fill ?? "none"}
        />
      ));
  return (
    <ScrollView horizontal>
      <ScrollView style={{ maxHeight: 500 }}>
        <Svg
          width={geometry.w * geometry.scale}
          height={geometry.h * geometry.scale}
          viewBox={`0 0 ${geometry.w} ${geometry.h}`}
        >
          {model.edges.map((edge) => {
            const from = geometry.nodes.find((node) => node.id === edge.from);
            const to = geometry.nodes.find((node) => node.id === edge.to);
            if (!from || !to) return null;
            const edgeLayout = edgeGeometry(from, to);
            return (
              <G key={edge.id}>
                <G opacity={0.65}>
                  {paths(
                    generator.path(edgeLayout.path, {
                      seed: canvasSeed(edge.id),
                      stroke: foreground,
                    }),
                  )}
                  {paths(
                    generator.linearPath(
                      [
                        [to.x - 11, to.y + to.h / 2 - 6],
                        [to.x, to.y + to.h / 2],
                        [to.x - 11, to.y + to.h / 2 + 6],
                      ],
                      { seed: canvasSeed(edge.id), stroke: foreground },
                    ),
                  )}
                </G>
                {edge.port && (
                  <Rect
                    x={edgeLayout.labelX - edgePillSize(edge.port).width / 2}
                    y={edgeLayout.labelY - 13}
                    {...edgePillSize(edge.port)}
                    rx={9}
                    fill={background}
                    stroke={foreground}
                    strokeWidth={0.5}
                  />
                )}
                <Text
                  textAnchor="middle"
                  fontSize={11}
                  x={edgeLayout.labelX}
                  y={edgeLayout.labelY}
                  fill={foreground}
                >
                  {edge.port ?? ""}
                </Text>
              </G>
            );
          })}
          {geometry.nodes.map((node) => {
            const style = CANVAS_NODE_STYLES[node.kind];
            const mark = node.status ? canvasStatusMark(node.status) : undefined;
            const tone = mark ? colors[CANVAS_STATUS_MARKS[mark].tone] : foreground;
            return (
              <G
                key={node.id}
                transform={`translate(${node.x} ${node.y})`}
                opacity={mark === "dim" ? 0.5 : 1}
                onPress={() => onPressNode?.(node.id)}
                accessibilityLabel={`${node.label}, ${style.label}${mark ? `, ${CANVAS_STATUS_MARKS[mark].label}` : ""}`}
              >
                {mark && mark !== "dim" && (
                  <Path
                    d={canvasShapePath(style.shape, node.w + 12, node.h + 12)}
                    transform="translate(-6 -6)"
                    stroke={tone}
                    strokeWidth={mark === "ok" ? 2 : 3}
                    fill="none"
                  />
                )}
                {drawings.get(node.id)?.map((path) => (
                  <Path
                    key={path.d}
                    d={path.d}
                    stroke={path.stroke}
                    strokeWidth={path.strokeWidth}
                    // roughjs `toPaths` drops `strokeLineDash`, so the frame dash is applied here.
                    strokeDasharray={
                      style.shape === "frame" &&
                      path.stroke !== CANVAS_HUES[style.hue][dark ? "dark" : "light"].fill
                        ? CANVAS_FRAME_DASH.join(" ")
                        : undefined
                    }
                    fill={path.fill ?? "none"}
                    opacity={
                      path.fill && path.fill !== "none"
                        ? dark && style.fill === "solid"
                          ? 0.35
                          : 1
                        : path.stroke === CANVAS_HUES[style.hue][dark ? "dark" : "light"].fill
                          ? 0.55
                          : 1
                    }
                  />
                ))}
                <Text x={12} y={24} fill={foreground} fontSize={14}>
                  {fitText(node.label, node.w - 24, 8)}
                </Text>
                <Text x={12} y={44} fill={colors.muted} fontSize={11}>
                  {fitText(node.subtitle, node.w - 24, 6)}
                </Text>
                {mark && mark !== "dim" && (
                  <G>
                    <Circle cx={node.w} cy={0} r={9} fill={tone} />
                    <Text x={node.w} y={4} textAnchor="middle" fill="white" fontSize={12}>
                      {{ running: "●", waiting: "!", failed: "✕", ok: "✓" }[mark]}
                    </Text>
                  </G>
                )}
              </G>
            );
          })}
        </Svg>
      </ScrollView>
    </ScrollView>
  );
}
