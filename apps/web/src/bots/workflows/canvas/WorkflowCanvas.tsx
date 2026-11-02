/* oxlint-disable shadcn/no-unknown-classes -- Canvas classes are defined in the lazy canvas.css asset. */
import { useState, type ReactNode } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  applyNodeChanges,
  applyEdgeChanges,
  useReactFlow,
} from "@xyflow/react";
import { canvasEdgeId, type CanvasModel } from "@t3tools/client-runtime/workflows";
import { reactFlowAdapter, type WorkflowFlowNode, type ReactFlowScene } from "./reactFlowAdapter";
import "@xyflow/react/dist/style.css";
import "./canvas.css";
import { NoteEdit } from "./CanvasContext";
import { Box } from "./CanvasNodeView";
import { RoughEdge } from "./RoughEdge";

export interface WorkflowCanvasProps {
  model: CanvasModel;
  mode: "edit" | "run";
  onChange?: (model: CanvasModel) => void;
  onSelectNode?: (id: string | null) => void;
  toolbar?: ReactNode;
  className?: string;
}

/** A parent re-render hands over a new model; what the user selected stays selected. */
function keepSelection(next: ReactFlowScene, previous: ReactFlowScene): ReactFlowScene {
  const nodes = new Set(previous.nodes.filter((n) => n.selected).map((n) => n.id));
  const edges = new Set(previous.edges.filter((e) => e.selected).map((e) => e.id));
  if (nodes.size === 0 && edges.size === 0) return next;
  return {
    ...next,
    nodes: next.nodes.map((n) => (nodes.has(n.id) ? { ...n, selected: true } : n)),
    edges: next.edges.map((e) => (edges.has(e.id) ? { ...e, selected: true } : e)),
  };
}
const nodeTypes = { workflow: Box, note: Box, frame: Box };
const edgeTypes = { rough: RoughEdge };
function Canvas({ model, mode, onChange, onSelectNode, toolbar, className }: WorkflowCanvasProps) {
  const flow = useReactFlow<WorkflowFlowNode>();
  const [state, setState] = useState(() => ({
    model,
    mode,
    scene: reactFlowAdapter.fromModel(model, mode),
  }));
  if (state.model !== model || state.mode !== mode)
    setState({
      model,
      mode,
      scene: keepSelection(reactFlowAdapter.fromModel(model, mode), state.scene),
    });
  const scene = state.scene;
  const [menu, setMenu] = useState<{ x: number; y: number; edge?: string } | null>(null);
  const editable = mode === "edit";
  const update = (next: ReactFlowScene, emit = true) => {
    setState({ model, mode, scene: next });
    if (emit)
      onChange?.({
        ...reactFlowAdapter.toModel(next),
        ...(model.viewport ? { viewport: model.viewport } : {}),
      });
  };
  return (
    <div
      className={`wf-canvas ${className ?? ""}`}
      style={{ height: "100%", minHeight: 320, position: "relative" }}
    >
      <NoteEdit
        value={
          editable
            ? (id, text) =>
                update({
                  ...scene,
                  nodes: scene.nodes.map((n) =>
                    n.id === id && "annotation" in n.data
                      ? { ...n, data: { annotation: { ...n.data.annotation, text } } }
                      : n,
                  ),
                })
            : undefined
        }
      >
        <ReactFlow
          nodes={scene.nodes}
          edges={scene.edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          // A workflow with no saved viewport opens framed, like a run.
          fitView={mode === "run" || model.viewport === undefined}
          // Wide workflows (ten columns and more) only fit below React Flow's default 0.5.
          minZoom={0.15}
          {...(model.viewport ? { defaultViewport: model.viewport } : {})}
          nodesDraggable={editable}
          nodesConnectable={editable}
          deleteKeyCode={editable ? ["Delete", "Backspace"] : null}
          // Removals arrive split across both change handlers; `onDelete` applies them at once.
          onNodesChange={(changes) => {
            const kept = changes.filter((c) => c.type !== "remove");
            if (!editable || kept.length === 0) return;
            update(
              { ...scene, nodes: applyNodeChanges(kept, scene.nodes) },
              // A drag reports every pointer move; only its end is an edit.
              kept.some((c) =>
                c.type === "position"
                  ? c.dragging === false
                  : c.type !== "dimensions" && c.type !== "select",
              ),
            );
          }}
          onEdgesChange={(changes) => {
            const kept = changes.filter((c) => c.type !== "remove");
            if (!editable || kept.length === 0) return;
            update({ ...scene, edges: applyEdgeChanges(kept, scene.edges) }, false);
          }}
          onDelete={({ nodes, edges }) => {
            if (!editable) return;
            const gone = new Set(nodes.map((n) => n.id));
            const goneEdges = new Set(edges.map((e) => e.id));
            update({
              ...scene,
              nodes: scene.nodes.filter(
                (n) => !gone.has(n.id) && !(n.parentId && gone.has(n.parentId)),
              ),
              edges: scene.edges.filter(
                (e) => !goneEdges.has(e.id) && !gone.has(e.source) && !gone.has(e.target),
              ),
            });
          }}
          onNodeClick={(_, node) => onSelectNode?.("model" in node.data ? node.id : null)}
          onPaneClick={() => {
            setMenu(null);
            onSelectNode?.(null);
          }}
          // A null event is a programmatic move (fitView), not an edit.
          onMoveEnd={(event, viewport) =>
            editable && event !== null && onChange?.({ ...model, viewport })
          }
          isValidConnection={(c) =>
            c.source !== c.target &&
            !scene.edges.some(
              (e) =>
                e.source === c.source && e.target === c.target && e.sourceHandle === c.sourceHandle,
            )
          }
          onConnect={(c) =>
            editable &&
            update({
              ...scene,
              edges: [
                ...scene.edges,
                {
                  ...c,
                  id: canvasEdgeId(c.source, c.sourceHandle, c.target),
                  type: "rough",
                  label: c.sourceHandle ?? undefined,
                },
              ],
            })
          }
          onEdgeContextMenu={(e, edge) => {
            e.preventDefault();
            if (editable) setMenu({ x: e.clientX, y: e.clientY, edge: edge.id });
          }}
          onPaneContextMenu={(e) => {
            e.preventDefault();
            if (editable) setMenu({ x: e.clientX, y: e.clientY });
          }}
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={20}
            size={1.2}
            color="color-mix(in srgb, var(--foreground) 22%, transparent)"
          />
          <Controls showInteractive={false} />
        </ReactFlow>
      </NoteEdit>
      {toolbar}
      {menu && (
        <div
          role="menu"
          className="fixed z-50 min-w-36 rounded-md border border-border bg-popover p-1 text-popover-foreground text-sm shadow-md"
          style={{ left: menu.x, top: menu.y }}
        >
          <button
            type="button"
            role="menuitem"
            className="w-full cursor-pointer rounded px-2 py-1 text-left hover:bg-accent"
            onClick={() => {
              if (menu.edge)
                update({ ...scene, edges: scene.edges.filter((e) => e.id !== menu.edge) });
              else {
                const p = flow.screenToFlowPosition(menu);
                let index = model.annotations.length;
                while (model.annotations.some((a) => a.id === `note_${index}`)) index += 1;
                const id = `note_${index}`;
                update(
                  reactFlowAdapter.fromModel(
                    {
                      ...model,
                      annotations: [
                        ...model.annotations,
                        { id, kind: "note", text: "Note", ...p, w: 180, h: 100 },
                      ],
                    },
                    mode,
                  ),
                );
              }
              setMenu(null);
            }}
          >
            {menu.edge ? "Delete connection" : "Add note"}
          </button>
        </div>
      )}
    </div>
  );
}
/** Isolates each workflow's React Flow store. */
export default function WorkflowCanvas(props: WorkflowCanvasProps) {
  return (
    <ReactFlowProvider>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
