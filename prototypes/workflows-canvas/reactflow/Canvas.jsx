// Throwaway canvas prototype for docs/friend/workflows-design.md; repo lint rules do not apply.
/* oxlint-disable */
import React, { useEffect, useState, useRef } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  BaseEdge,
  getBezierPath,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import rough from "roughjs";
import { colors, canonical } from "../shared/graph";
function Box({ data }) {
  const ref = useRef();
  useEffect(() => {
    const s = ref.current;
    s.replaceChildren(
      rough.svg(s).rectangle(3, 3, 184, 64, {
        seed: 12,
        fill: colors[data.kind],
        fillStyle: "solid",
        roughness: 1.4,
      }),
    );
  }, [data.kind]);
  return (
    <div style={{ width: 190, height: 70, position: "relative" }}>
      <svg ref={ref} width="190" height="70" />
      <div style={{ position: "absolute", inset: 12 }}>
        {data.kind}
        <br />
        {data.label}
      </div>
      <Handle type="target" position={Position.Left} />
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
function Edge(p) {
  const [d] = getBezierPath(p);
  const ref = useRef();
  useEffect(() => {
    ref.current.replaceChildren(
      rough
        .svg(ref.current)
        .path(d, { seed: 12, roughness: 1.4, stroke: "#334155", strokeWidth: 2 }),
    );
  }, [d]);
  return (
    <>
      <g ref={ref} style={{ pointerEvents: "none" }} />
      <BaseEdge path={d} id={p.id} interactionWidth={24} style={{ stroke: "transparent" }} />
    </>
  );
}

function Note({ data }) {
  return <div style={{ background: "#fff3a3", padding: 20, width: 150 }}>{data.label}</div>;
}
const nodeTypes = { box: Box, note: Note },
  edgeTypes = { rough: Edge };
function scene(g) {
  return {
    nodes: g.nodes
      .map((n) => ({
        id: n.id,
        type: "box",
        position: n.position,
        data: { kind: n.kind, label: n.label },
      }))
      .concat(
        (g.annotations ?? []).map((n) => ({
          ...n,
          type: "note",
          data: { kind: "note", label: n.label },
        })),
      ),
    edges: g.edges.map((e) => ({
      id: e.id,
      source: e.from,
      target: e.to,
      label: e.label,
      type: "rough",
    })),
  };
}
function graph(s) {
  return {
    annotations: s.nodes
      .filter((n) => n.type === "note")
      .map((n) => ({ id: n.id, kind: "note", label: n.data.label, position: n.position })),
    nodes: s.nodes
      .filter((n) => n.type !== "note")
      .map((n) => ({ id: n.id, kind: n.data.kind, label: n.data.label, position: n.position })),
    edges: s.edges.map((e) => ({
      id: e.id,
      from: e.source,
      to: e.target,
      ...(e.label ? { label: e.label } : {}),
    })),
  };
}
export default function Canvas({ graph: g, onChange, readonly, onRound, onSvg }) {
  const [s, set] = useState(() => scene(g));
  const emitted = useRef("");
  const flow = useRef();
  useEffect(() => {
    if (JSON.stringify(g) !== emitted.current) {
      set(scene(g));
      requestAnimationFrame(() => flow.current?.fitView({ padding: 0.1 }));
    }
    onRound(canonical(graph(scene(g))) === canonical(g) ? "roundtrip ok" : "roundtrip differs");
    onSvg(
      "React Flow has no built-in SVG export. Serialize custom nodes, edge paths and viewport transforms into SVG, including fonts.",
    );
  }, [g]);
  function update(next) {
    set(next);
    emitted.current = JSON.stringify(graph(next));
    onChange(graph(next));
  }
  return (
    <>
      <ReactFlow
        onInit={(instance) => {
          flow.current = instance;
        }}
        deleteKeyCode={["Backspace", "Delete"]}
        nodes={s.nodes}
        edges={s.edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        nodesDraggable={!readonly}
        nodesConnectable={!readonly}
        elementsSelectable={!readonly}
        onNodesChange={(c) => !readonly && update({ ...s, nodes: applyNodeChanges(c, s.nodes) })}
        onEdgesChange={(c) => !readonly && update({ ...s, edges: applyEdgeChanges(c, s.edges) })}
        onConnect={(c) =>
          update({
            ...s,
            edges: addEdge({ ...c, id: crypto.randomUUID(), type: "rough" }, s.edges),
          })
        }
      >
        <Background />
        <Controls />
      </ReactFlow>
      {!readonly && (
        <button
          style={{ position: "absolute", top: 10, left: 10 }}
          onClick={() =>
            update({
              ...s,
              nodes: [
                ...s.nodes,
                {
                  id: crypto.randomUUID(),
                  type: "box",
                  position: { x: 300, y: 300 },
                  data: { kind: "agent", label: "new agent" },
                },
              ],
            })
          }
        >
          Add agent
        </button>
      )}
      {!readonly && (
        <button
          style={{ position: "absolute", top: 10, left: 110 }}
          onClick={() =>
            update({
              ...s,
              nodes: [
                ...s.nodes,
                {
                  id: crypto.randomUUID(),
                  type: "note",
                  position: { x: 500, y: 400 },
                  data: { kind: "note", label: "Free note" },
                },
              ],
            })
          }
        >
          Add note
        </button>
      )}
      {!readonly && (
        <button
          style={{ position: "absolute", top: 10, left: 210 }}
          onClick={() => update(scene(JSON.parse(JSON.stringify(graph(s)))))}
        >
          Round trip
        </button>
      )}
    </>
  );
}
