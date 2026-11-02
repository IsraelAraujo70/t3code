// Throwaway canvas prototype for docs/friend/workflows-design.md; repo lint rules do not apply.
/* oxlint-disable */
import React, { useEffect, useState, useRef } from "react";
import { Excalidraw, convertToExcalidrawElements, exportToSvg } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { colors, canonical } from "../shared/graph";
function scene(g) {
  const boxes = convertToExcalidrawElements(
    g.nodes.map((n) => ({
      id: n.id,
      type: "rectangle",
      x: n.position.x,
      y: n.position.y,
      width: 190,
      height: 75,
      backgroundColor: colors[n.kind],
      customData: { kind: n.kind, label: n.label },
      label: { text: n.kind + "\n" + n.label, fontSize: 16 },
    })),
    { regenerateIds: false },
  );
  const arrows = g.edges
    .filter((e) => g.nodes.some((n) => n.id === e.from) && g.nodes.some((n) => n.id === e.to))
    .flatMap((e) => {
      const a = g.nodes.find((n) => n.id === e.from).position,
        b = g.nodes.find((n) => n.id === e.to).position;
      return convertToExcalidrawElements(
        [
          {
            id: e.id,
            type: "arrow",
            x: a.x + 195,
            y: a.y + 38,
            width: Math.abs(b.x - a.x - 200),
            height: Math.abs(b.y - a.y),
            points: [
              [0, 0],
              [b.x - a.x - 200, b.y - a.y],
            ],
            startBinding: { elementId: e.from, focus: 0, gap: 5 },
            endBinding: { elementId: e.to, focus: 0, gap: 5 },
            customData: { label: e.label },
          },
        ],
        { regenerateIds: false },
      ).map((arrow) => ({
        ...arrow,
        startBinding: { elementId: e.from, focus: 0, gap: 5 },
        endBinding: { elementId: e.to, focus: 0, gap: 5 },
      }));
    });
  for (const box of boxes.filter((e) => e.type === "rectangle"))
    box.boundElements = [
      ...(box.boundElements ?? []),
      ...g.edges
        .filter((e) => e.from === box.id || e.to === box.id)
        .map((e) => ({ id: e.id, type: "arrow" })),
    ];
  return [...boxes, ...arrows];
}

function graph(elements) {
  const live = elements.filter((e) => !e.isDeleted);
  return {
    nodes: live
      .filter((e) => ["rectangle", "diamond", "ellipse"].includes(e.type))
      .map((e) => ({
        id: e.id,
        kind: e.customData?.kind ?? "unknown",
        label: e.customData?.label ?? live.find((t) => t.containerId === e.id)?.text ?? "box",
        position: { x: e.x, y: e.y },
      })),
    edges: live
      .filter((e) => e.type === "arrow")
      .map((e) => ({
        id: e.id,
        from: e.startBinding?.elementId ?? "",
        to: e.endBinding?.elementId ?? "",
        ...(e.customData?.label ? { label: e.customData.label } : {}),
      })),
  };
}
export default function Canvas({ graph: g, onChange, readonly, onRound, onSvg }) {
  const [api, setApi] = useState(null);
  const last = useRef("");
  const emitted = useRef("");
  useEffect(() => {
    if (!api) return;
    const es = scene(g);
    if (!last.current || canonical(g) !== last.current) {
      api.updateScene({ elements: es });
      api.scrollToContent(es, { fitToContent: true });
    }
    onRound(canonical(graph(es)) === canonical(g) ? "roundtrip ok" : "roundtrip differs");
  }, [g, api]);
  return (
    <Excalidraw
      excalidrawAPI={setApi}
      initialData={{ elements: scene(g), appState: { viewModeEnabled: readonly } }}
      viewModeEnabled={readonly}
      onChange={(es, state, files) => {
        const next = graph(es);
        last.current = canonical(next);
        const key = JSON.stringify(next);
        if (key !== emitted.current) {
          emitted.current = key;
          onChange(next);
        }
        if (key !== window.__svgKey) {
          window.__svgKey = key;
          exportToSvg({ elements: es, appState: state, files }).then((s) => onSvg(s.outerHTML));
        }
      }}
    />
  );
}
