import type { WorkflowDefinition } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import {
  applyFieldEdit,
  deleteInspectorNode,
  fieldText,
  inspectorNodePath,
  parseFieldText,
} from "./inspectorEdits";

it("round trips argv lines including whitespace and empty arguments", () => {
  const argv = ["node", "a b", "", " tail "];
  expect(parseFieldText(fieldText(argv, "lines"), "lines")).toEqual(argv);
  expect(parseFieldText("node\r\nscript.mjs", "lines")).toEqual(["node", "script.mjs"]);
  expect(parseFieldText("approve, reject, ,retry", "commas")).toEqual([
    "approve",
    "reject",
    "retry",
  ]);
  expect(fieldText(["approve", "reject"], "commas")).toBe("approve, reject");
});

it("removes optional fields and preserves other nested values without mutation", () => {
  const node = {
    kind: "command",
    argv: ["true"],
    timeout: "1m",
    retry: { max: 3, on: ["failed"], backoff: "1s" },
  };
  expect(applyFieldEdit(node, "timeout", "", "text")).toEqual({
    kind: "command",
    argv: ["true"],
    retry: node.retry,
  });
  expect(applyFieldEdit(node, "retry.backoff", "", "text")).toEqual({
    ...node,
    retry: { max: 3, on: ["failed"] },
  });
  expect(node.retry.backoff).toBe("1s");
  expect(applyFieldEdit(node, "retry.max", "4", "number")).toMatchObject({
    retry: { max: 4, on: ["failed"] },
  });
  expect(parseFieldText('{"project":"demo","readOnly":true}', "workspace")).toEqual({
    project: "demo",
    readOnly: true,
  });
  expect(parseFieldText("work", "workspace")).toBe("work");
  expect(() => applyFieldEdit(node, "env", "{", "json")).toThrow();
});

it("deletes nested nodes and incident edges, and removes an entire block's layout", () => {
  const definition: WorkflowDefinition = {
    schema: "t3.workflow/v1",
    id: "demo",
    title: "Demo",
    home: { project: "demo" },
    budget: { steps: 10, wall: "1h", tokens: 1000 },
    fatigue: { consecutiveFailures: 3 },
    nodes: {
      loop: {
        kind: "loop",
        until: "true",
        max: 2,
        body: {
          nodes: {
            inner: { kind: "gate", ask: "Continue?" },
            done: { kind: "output", status: "no_change", value: {} },
          },
          edges: ["inner:approve -> done"],
        },
      },
      end: { kind: "output", status: "no_change", value: {} },
    },
    edges: ["loop -> end"],
    canvas: {
      positions: {
        loop: { x: 0, y: 0 },
        inner: { x: 1, y: 1 },
        done: { x: 2, y: 2 },
        end: { x: 3, y: 3 },
      },
      annotations: [
        { id: "note", kind: "note", text: "hi", x: 0, y: 0, w: 30, h: 30, attachedTo: "inner" },
      ],
    },
  };
  expect(inspectorNodePath(definition, "inner")).toBe("nodes.loop.body.nodes.inner");
  expect(inspectorNodePath(definition, "missing")).toBeNull();
  const nested = deleteInspectorNode(definition, "inner");
  expect(nested.nodes.loop).toMatchObject({
    body: {
      nodes: {
        done: definition.nodes.loop?.kind === "loop" ? definition.nodes.loop.body.nodes.done : null,
      },
      edges: [],
    },
  });
  expect(nested.edges).toEqual(["loop -> end"]);
  const removed = deleteInspectorNode(definition, "loop");
  expect(Object.keys(removed.nodes)).toEqual(["end"]);
  expect(removed.edges).toEqual([]);
  expect(Object.keys(removed.canvas?.positions ?? {})).toEqual(["end"]);
  expect(removed.canvas?.annotations).toEqual([]);
  expect(definition.edges).toEqual(["loop -> end"]);
});
