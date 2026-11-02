import { describe, expect, it } from "vite-plus/test";
import { edgePillSize, fitText, edgeGeometry, graphGeometry } from "./WorkflowGraph.logic";

describe("mobile graph geometry", () => {
  it("resolves body coordinates before fitting the graph", () => {
    const result = graphGeometry(
      {
        triggers: [],
        entries: [],
        nodes: [
          {
            id: "parent",
            kind: "map",
            label: "Parent",
            subtitle: "",
            x: 100,
            y: 50,
            w: 400,
            h: 200,
            parent: null,
            ports: [],
          },
          {
            id: "child",
            kind: "gate",
            label: "Child",
            subtitle: "",
            x: 20,
            y: 30,
            w: 200,
            h: 64,
            parent: "parent",
            ports: [],
          },
        ],
        edges: [],
        annotations: [],
      },
      262,
    );
    expect(result.nodes[1]).toMatchObject({ x: 120, y: 80 });
    expect(result.scale).toBe(0.5);
    expect(edgeGeometry({ x: 0, y: 0, w: 200, h: 64 }, { x: 300, y: 100, h: 64 })).toEqual({
      path: "M 200 32 C 250 32, 250 132, 300 132",
      labelX: 250,
      labelY: 77,
    });
    expect(edgePillSize("yes")).toEqual({ width: 37, height: 18 });
    expect(edgePillSize("")).toEqual({ width: 16, height: 18 });
    expect(fitText("ls -la", 196, 6)).toBe("ls -la");
    expect(fitText("gate · Continue to the second step?", 60, 6)).toBe("gate · Co…");
  });
});
