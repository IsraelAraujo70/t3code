import { useState, createContext, useContext, type ReactNode } from "react";
import {
  ReactFlow,
  ReactFlowProvider,
  Handle,
  Position,
  BaseEdge,
  getBezierPath,
  applyNodeChanges,
  applyEdgeChanges,
  useReactFlow,
  type NodeProps,
  type EdgeProps,
} from "@xyflow/react";
import rough from "roughjs";
import { canvasEdgeId, stepStatusTone, type CanvasModel } from "@t3tools/client-runtime/workflows";
import { reactFlowAdapter, type WorkflowFlowNode, type ReactFlowScene } from "./reactFlowAdapter";
import "@xyflow/react/dist/style.css";

export interface WorkflowCanvasProps {
  model: CanvasModel;
  mode: "edit" | "run";
  onChange?: (model: CanvasModel) => void;
  onSelectNode?: (id: string | null) => void;
  toolbar?: ReactNode;
  className?: string;
}
const NoteEdit = createContext<((id: string, text: string) => void) | undefined>(undefined);
const generator = rough.generator();
function seed(id: string) {
  return Array.from(id).reduce((n, c) => (n * 31 + c.charCodeAt(0)) | 0, 1) >>> 0 || 1;
}
function Box({ id, data, width = 200, height = 64 }: NodeProps<WorkflowFlowNode>) {
  const paths = generator.toPaths(
    generator.rectangle(3, 3, width - 6, height - 6, { seed: seed(id), roughness: 1.2 }),
  );
  const edit = useContext(NoteEdit);
  const [editing, setEditing] = useState(false);
  const model = "model" in data ? data.model : null;
  const annotation = "annotation" in data ? data.annotation : null;
  const tone = model?.status ? stepStatusTone(model.status) : "muted";
  return (
    <div
      style={{
        width,
        height,
        position: "relative",
        color: `var(--${tone === "muted" ? "foreground" : tone})`,
      }}
    >
      <svg width={width} height={height} style={{ position: "absolute", pointerEvents: "none" }}>
        {paths.map((p) => (
          <path key={p.d} d={p.d} fill="none" stroke="currentColor" strokeWidth={p.strokeWidth} />
        ))}
      </svg>
      <div style={{ padding: 12 }} onDoubleClick={() => annotation && edit && setEditing(true)}>
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
        ) : (
          (model?.label ?? annotation?.text)
        )}
      </div>
      {model && (
        <>
          <Handle type="target" position={Position.Left} />
          {model.ports.map((port, i) => (
            <Handle
              key={port}
              id={port}
              type="source"
              position={Position.Right}
              style={{ top: `${(100 * (i + 1)) / (model.ports.length + 1)}%` }}
            />
          ))}
        </>
      )}
    </div>
  );
}
function RoughEdge(props: EdgeProps) {
  const [path] = getBezierPath(props);
  const paths = generator.toPaths(generator.path(path, { seed: seed(props.id), roughness: 1.2 }));
  return (
    <>
      <g pointerEvents="none">
        {paths.map((p) => (
          <path
            key={p.d}
            d={p.d}
            fill="none"
            stroke="var(--foreground)"
            strokeWidth={p.strokeWidth}
          />
        ))}
      </g>
      <BaseEdge
        id={props.id}
        path={path}
        interactionWidth={24}
        label={props.label}
        style={{ stroke: "transparent" }}
      />
    </>
  );
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
    setState({ model, mode, scene: reactFlowAdapter.fromModel(model, mode) });
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
    <div className={className} style={{ height: "100%", minHeight: 320, position: "relative" }}>
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
          fitView={mode === "run"}
          {...(model.viewport ? { defaultViewport: model.viewport } : {})}
          nodesDraggable={editable}
          nodesConnectable={editable}
          deleteKeyCode={editable ? ["Delete", "Backspace"] : null}
          onNodesChange={(changes) =>
            editable &&
            update(
              { ...scene, nodes: applyNodeChanges(changes, scene.nodes) },
              changes.some((c) => c.type !== "dimensions" && c.type !== "select"),
            )
          }
          onEdgesChange={(changes) =>
            editable &&
            update(
              { ...scene, edges: applyEdgeChanges(changes, scene.edges) },
              changes.some((c) => c.type !== "select"),
            )
          }
          onNodeClick={(_, node) => onSelectNode?.("model" in node.data ? node.id : null)}
          onPaneClick={() => {
            setMenu(null);
            onSelectNode?.(null);
          }}
          onMoveEnd={(_, viewport) => editable && onChange?.({ ...model, viewport })}
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
        />
      </NoteEdit>
      {toolbar}
      {menu && (
        <div
          role="menu"
          style={{
            position: "fixed",
            left: menu.x,
            top: menu.y,
            background: "var(--background)",
            zIndex: 100,
          }}
        >
          <button
            role="menuitem"
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
