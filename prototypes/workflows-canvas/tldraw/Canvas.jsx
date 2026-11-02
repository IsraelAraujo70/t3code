// Throwaway canvas prototype for docs/friend/workflows-design.md; repo lint rules do not apply.
/* oxlint-disable */
import React, { useEffect, useState } from "react";
import { Tldraw, createShapeId, createBindingId } from "tldraw";
import "tldraw/tldraw.css";
import { canonical } from "../shared/graph";
const color = {
  agent: "blue",
  check: "green",
  gate: "yellow",
  hillclimb: "violet",
  arena: "light-violet",
  trigger: "light-blue",
  output: "orange",
};
function read(ed) {
  const shapes = ed.getCurrentPageShapes();
  return {
    nodes: shapes
      .filter((s) => s.type === "geo")
      .map((s) => ({
        id: s.meta.graphId ?? s.id,
        kind: s.meta.kind ?? "unknown",
        label: s.meta.label ?? "box",
        position: { x: s.x, y: s.y },
      })),
    edges: shapes
      .filter((s) => s.type === "arrow")
      .map((s) => {
        const bs = ed.getBindingsFromShape(s, "arrow");
        const node = (t) =>
          shapes.find((n) => n.id === bs.find((b) => b.props.terminal === t)?.toId)?.meta.graphId ??
          "";
        return {
          id: s.meta.graphId ?? s.id,
          from: node("start"),
          to: node("end"),
          ...(s.props.richText?.content?.[0]?.content?.[0]?.text
            ? { label: s.props.richText.content[0].content[0].text }
            : {}),
        };
      }),
  };
}
function write(ed, g) {
  ed.deleteShapes([...ed.getCurrentPageShapeIds()]);
  ed.createShapes(
    g.nodes.map((n) => ({
      id: createShapeId(n.id),
      type: "geo",
      x: n.position.x,
      y: n.position.y,
      meta: { graphId: n.id, kind: n.kind, label: n.label },
      props: {
        w: 190,
        h: 85,
        color: color[n.kind],
        fill: "semi",
        font: "draw",
        richText: {
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: n.kind + "\n" + n.label }] },
          ],
        },
      },
    })),
  );
  for (const e of g.edges) {
    const id = createShapeId(e.id);
    ed.createShape({
      id,
      type: "arrow",
      meta: { graphId: e.id },
      props: {
        start: { x: 0, y: 0 },
        end: { x: 200, y: 0 },
        font: "draw",
        richText: {
          type: "doc",
          content: [
            { type: "paragraph", content: e.label ? [{ type: "text", text: e.label }] : [] },
          ],
        },
      },
    });
    for (const [terminal, node] of [
      ["start", e.from],
      ["end", e.to],
    ])
      ed.createBinding({
        id: createBindingId(),
        type: "arrow",
        fromId: id,
        toId: createShapeId(node),
        props: {
          terminal,
          normalizedAnchor: { x: terminal === "start" ? 1 : 0, y: 0.5 },
          isExact: false,
          isPrecise: true,
        },
      });
  }
  ed.zoomToFit();
}
export default function Canvas({ graph: g, onChange, readonly, onRound, onSvg }) {
  const [ed, setEd] = useState();
  const lock = React.useRef(false);
  const last = React.useRef("");
  useEffect(() => {
    if (!ed) return;
    if (canonical(g) !== last.current) {
      lock.current = true;
      write(ed, g);
      lock.current = false;
    }
    onRound(canonical(read(ed)) === canonical(g) ? "roundtrip ok" : "roundtrip differs");
  }, [ed, g]);
  return (
    <Tldraw
      onMount={(editor) => {
        setEd(editor);
        editor.updateInstanceState({ isReadonly: readonly });
        return editor.store.listen(
          () => {
            if (lock.current) return;
            const next = read(editor);
            last.current = canonical(next);
            onChange(next);
            editor
              .getSvgString([...editor.getCurrentPageShapeIds()])
              .then((s) => onSvg(s?.svg ?? ""));
          },
          { source: "user", scope: "document" },
        );
      }}
    />
  );
}
