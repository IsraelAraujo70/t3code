import { type CanvasModel, stepStatusTone } from "@t3tools/client-runtime/workflows";
import { useMemo } from "react";
import { useWorkflowColors } from "./WorkflowStatus";
import { ScrollView, useWindowDimensions } from "react-native";
import Svg, { G, Path, Text } from "react-native-svg";
import rough from "roughjs/bin/rough";
import { useResolveClassNames } from "uniwind";
import { drawingSeed, edgeGeometry, graphGeometry } from "./WorkflowGraph.logic";

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
                {paths(
                  generator.path(edgeLayout.path, {
                    seed: drawingSeed(edge.id),
                    stroke: foreground,
                  }),
                )}
                <Text x={edgeLayout.labelX} y={edgeLayout.labelY} fill={foreground}>
                  {edge.port ?? ""}
                </Text>
              </G>
            );
          })}
          {geometry.nodes.map((node) => (
            <G
              key={node.id}
              onPress={() => onPressNode?.(node.id)}
              accessibilityLabel={`${node.label}, ${node.kind}${node.status ? `, ${stepStatusTone(node.status)}` : ""}`}
            >
              {paths(
                generator.rectangle(node.x, node.y, node.w, node.h, {
                  seed: drawingSeed(node.id),
                  stroke: node.status ? colors[stepStatusTone(node.status)] : foreground,
                  fill: geometry.nodes.some((child) => child.parent === node.id)
                    ? "transparent"
                    : background,
                  fillStyle: "solid",
                }),
              )}
              <Text x={node.x + 12} y={node.y + 24} fill={foreground} fontSize={14}>
                {node.label}
              </Text>
              <Text x={node.x + 12} y={node.y + 44} fill={foreground} fontSize={11}>
                {node.kind}
              </Text>
            </G>
          ))}
        </Svg>
      </ScrollView>
    </ScrollView>
  );
}
