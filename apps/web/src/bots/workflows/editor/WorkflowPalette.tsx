import {
  CANVAS_NODE_SIZE,
  CANVAS_NODE_STYLES,
  CANVAS_HUES,
  defaultNodeConfig,
  nextNodeId,
  toCanvasModel,
} from "@t3tools/client-runtime/workflows";
import type { WorkflowDefinition, WorkflowNode } from "@t3tools/contracts";
import { canvasIcons } from "../canvas/canvasIcons";
import { Button } from "../../../components/ui/button";

const kinds = Object.keys(CANVAS_NODE_STYLES).filter(
  (kind): kind is WorkflowNode["kind"] => kind !== "note",
);

/** Adds typed top-level nodes to the right of the existing graph. */
export function WorkflowPalette(props: {
  definition: WorkflowDefinition;
  disabled: boolean;
  onAdd: (definition: WorkflowDefinition, id: string) => void;
}) {
  const add = (kind: WorkflowNode["kind"]) => {
    const definition = props.definition;
    const id = nextNodeId(definition, kind);
    const boxes = toCanvasModel(definition).nodes.filter((node) => node.parent === null);
    const x = boxes.length === 0 ? 0 : Math.max(...boxes.map((node) => node.x + node.w)) + 80;
    props.onAdd(
      {
        ...definition,
        nodes: { ...definition.nodes, [id]: defaultNodeConfig(kind) },
        canvas: {
          ...definition.canvas,
          annotations: definition.canvas?.annotations ?? [],
          positions: { ...definition.canvas?.positions, [id]: { x, y: 0, ...CANVAS_NODE_SIZE } },
        },
      },
      id,
    );
  };
  return (
    <div role="toolbar" aria-label="Add workflow node" className="flex max-w-full flex-wrap gap-1">
      {kinds.map((kind) => {
        const style = CANVAS_NODE_STYLES[kind];
        const hue = CANVAS_HUES[style.hue];
        const Icon = canvasIcons[style.icon];
        return (
          <Button
            key={kind}
            size="xs"
            variant="outline"
            disabled={props.disabled}
            onClick={() => add(kind)}
            aria-label={`Add ${kind}`}
          >
            <Icon
              size={14}
              style={{ color: `light-dark(${hue.light.stroke}, ${hue.dark.stroke})` }}
            />
            {kind}
          </Button>
        );
      })}
    </div>
  );
}
