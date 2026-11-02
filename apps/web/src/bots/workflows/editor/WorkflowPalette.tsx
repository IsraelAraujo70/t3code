import {
  CANVAS_NODE_SIZE,
  defaultNodeConfig,
  nextNodeId,
  toCanvasModel,
} from "@t3tools/client-runtime/workflows";
import type { WorkflowDefinition, WorkflowNode } from "@t3tools/contracts";
import { Button } from "../../../components/ui/button";

const kinds = [
  "agent",
  "command",
  "gate",
  "branch",
  "output",
  "call",
  "map",
  "loop",
  "hillclimb",
  "arena",
  "graph",
  "interrogate",
] as const satisfies ReadonlyArray<WorkflowNode["kind"]>;

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
      {kinds.map((kind) => (
        <Button
          key={kind}
          size="xs"
          variant="outline"
          disabled={props.disabled}
          onClick={() => add(kind)}
          aria-label={`Add ${kind}`}
        >
          {kind}
        </Button>
      ))}
    </div>
  );
}
