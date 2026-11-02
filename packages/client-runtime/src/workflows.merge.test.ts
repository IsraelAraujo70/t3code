import { expect, it } from "vite-plus/test";
import type { WorkflowDefinition } from "@t3tools/contracts";
import { mergeDocuments } from "./workflows.merge.ts";
const base: WorkflowDefinition = {
  schema: "t3.workflow/v1",
  id: "demo",
  title: "Demo",
  home: { project: "demo" },
  budget: { steps: 10, wall: "1h", tokens: 1000 },
  fatigue: { consecutiveFailures: 3 },
  nodes: {
    a: { kind: "output", status: "ready_for_review" as const, value: { text: "a" } },
    b: { kind: "output", status: "ready_for_review" as const, value: { text: "b" } },
  },
  edges: ["a -> b"],
};
it("merges disjoint layout and config changes", () => {
  const mine = { ...base, canvas: { positions: { a: { x: 1, y: 2 } }, annotations: [] } };
  const theirs = {
    ...base,
    nodes: {
      ...base.nodes,
      b: {
        kind: "output" as const,
        status: "ready_for_review" as const,
        value: { text: "changed" },
      },
    },
  };
  const result = mergeDocuments(base, mine, theirs);
  expect(result.conflicts).toEqual([]);
  expect(result.merged.canvas).toEqual(mine.canvas);
  expect(result.merged.nodes.b).toEqual(theirs.nodes.b);
});
it("keeps mine for conflicting edits and deletion", () => {
  const mine = {
    ...base,
    nodes: {
      ...base.nodes,
      a: { kind: "output" as const, status: "ready_for_review" as const, value: { text: "mine" } },
    },
  };
  expect(mergeDocuments(base, mine, { ...base, nodes: { b: base.nodes.b! } })).toMatchObject({
    conflicts: ["nodes.a"],
    merged: { nodes: mine.nodes },
  });
  expect(
    mergeDocuments(base, mine, {
      ...base,
      nodes: {
        ...base.nodes,
        a: { kind: "output", status: "ready_for_review" as const, value: { text: "theirs" } },
      },
    }).conflicts,
  ).toEqual(["nodes.a"]);
});
it("merges edge membership and removes dangling edges", () => {
  expect(
    mergeDocuments(base, { ...base, edges: [] }, { ...base, edges: ["a -> b", "b->a"] }).merged
      .edges,
  ).toEqual(["b -> a"]);
  expect(mergeDocuments(base, base, { ...base, nodes: { a: base.nodes.a! } }).merged.edges).toEqual(
    [],
  );
});
it("reports conflicting positions", () => {
  const doc = (x: number) => ({
    ...base,
    canvas: { positions: { a: { x, y: 0 } }, annotations: [] },
  });
  expect(mergeDocuments(doc(0), doc(1), doc(2)).conflicts).toEqual(["canvas.positions.a"]);
});
it("merges changes inside a map body", () => {
  const map = {
    kind: "map" as const,
    items: "[]",
    maxItems: 2,
    concurrency: 1,
    body: { nodes: base.nodes, edges: base.edges },
  };
  const doc = { ...base, nodes: { each: map }, edges: [] };
  const mine = { ...doc, title: "Mine" };
  const theirs = {
    ...doc,
    nodes: {
      each: {
        ...map,
        body: {
          ...map.body,
          nodes: {
            ...base.nodes,
            b: {
              kind: "output" as const,
              status: "ready_for_review" as const,
              value: { text: "changed" },
            },
          },
        },
      },
    },
  };
  const result = mergeDocuments(doc, mine, theirs);
  expect(result.conflicts).toEqual([]);
  expect(result.merged.title).toBe("Mine");
  expect(result.merged.nodes).toEqual(theirs.nodes);
});
