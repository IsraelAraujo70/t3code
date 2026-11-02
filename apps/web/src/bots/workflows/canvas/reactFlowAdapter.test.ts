import { expect, it } from "vite-plus/test";
import type { CanvasModel } from "@t3tools/client-runtime/workflows";
import { reactFlowAdapter } from "./reactFlowAdapter";

it("preserves nested nodes, written ports, status and annotations", () => {
  const model: CanvasModel = {
    triggers: [
      { id: "manual", kind: "manual", label: "Manual", subtitle: "", x: -200, y: 0, w: 180, h: 56 },
    ],
    entries: [{ id: "manual=>map", from: "manual", to: "map" }],
    nodes: [
      {
        id: "map",
        kind: "map",
        label: "Map",
        subtitle: "",
        x: 0,
        y: 0,
        w: 500,
        h: 200,
        parent: null,
        ports: ["ok"],
        status: "running",
      },
      {
        id: "child",
        kind: "agent",
        label: "Agent",
        subtitle: "",
        x: 24,
        y: 56,
        w: 200,
        h: 64,
        parent: "map",
        ports: ["ok"],
      },
      {
        id: "end",
        kind: "output",
        label: "End",
        subtitle: "",
        x: 560,
        y: 0,
        w: 200,
        h: 64,
        parent: null,
        ports: [],
      },
    ],
    edges: [{ id: "map:ok->end", from: "map", port: "ok", to: "end" }],
    annotations: [
      {
        id: "note",
        kind: "note",
        text: "Keep this",
        x: 10,
        y: 250,
        w: 180,
        h: 100,
        attachedTo: "map",
      },
    ],
  };
  for (const mode of ["edit", "run"] as const) {
    expect(reactFlowAdapter.toModel(reactFlowAdapter.fromModel(model, mode))).toEqual(model);
  }
});
