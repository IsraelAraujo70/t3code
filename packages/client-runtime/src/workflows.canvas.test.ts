import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import * as Result from "effect/Result";
import { WorkflowNode, type WorkflowDefinition, type WorkflowNodeKind } from "@t3tools/contracts";
import { compileWorkflow, DEFAULT_HOST_LIMITS } from "@t3tools/shared/workflows";
import {
  autoLayout,
  canvasEdgeId,
  defaultNodeConfig,
  findNode,
  fromCanvasModel,
  nextNodeId,
  renameNode,
  toCanvasModel,
  updateNode,
  withNodeStatuses,
  CANVAS_NODE_SIZE,
} from "./workflows.canvas.ts";
const decodeNode = Schema.decodeSync(WorkflowNode);
const kinds: WorkflowNodeKind[] = [
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
];
const fixture = (): WorkflowDefinition => {
  const base: WorkflowDefinition = {
    schema: "t3.workflow/v1",
    id: "demo",
    title: "Demo",
    home: { project: "t3code" },
    budget: { steps: 30, wall: "2h", tokens: 100000 },
    fatigue: { consecutiveFailures: 2 },
    nodes: {
      command: {
        kind: "command",
        argv: ["echo", "hello"],
        cwd: { project: "t3code", readOnly: true },
      },
      agent: {
        kind: "agent",
        model: { provider: "claude", model: "claude-opus-5-5" },
        prompt: "Plan",
        workspace: { project: "t3code", readOnly: true },
      },
      gate: defaultNodeConfig("gate"),
      branch: defaultNodeConfig("branch"),
      each: {
        kind: "map",
        items: "nodes.command.output.items",
        maxItems: 1,
        concurrency: 1,
        body: {
          nodes: {
            inner: { kind: "command", argv: ["echo"], cwd: { project: "t3code", readOnly: true } },
            end: defaultNodeConfig("output"),
          },
          edges: ["inner -> end"],
        },
      },
      done: defaultNodeConfig("output"),
    },
    edges: [
      "command -> agent",
      "agent -> gate",
      "gate:approve -> branch",
      "gate:reject -> done",
      "branch:yes -> each",
      "branch:no -> done",
      "each -> done",
    ],
  };
  return {
    ...base,
    canvas: {
      positions: autoLayout(base),
      annotations: [
        {
          id: "note",
          kind: "note",
          text: "Review",
          attachedTo: "agent",
          x: 0,
          y: 0,
          w: 100,
          h: 40,
        },
      ],
    },
  };
};
describe("canvas conversion", () => {
  it("round trips a compiled graph and annotation", () => {
    const def = fixture();
    const compiled = compileWorkflow(def, DEFAULT_HOST_LIMITS);
    expect(Result.isFailure(compiled) ? compiled.failure : []).toEqual([]);
    const result = fromCanvasModel(toCanvasModel(def), def);
    expect(result.definition).toEqual(def);
    expect(result.diagnostics).toEqual([]);
  });
  it("rebuilds removed and added nodes and body edges", () => {
    const def = fixture();
    const model = toCanvasModel(def);
    const gate = {
      id: "new_gate",
      kind: "gate",
      label: "new_gate",
      parent: "each",
      x: 0,
      y: 0,
      ...CANVAS_NODE_SIZE,
      ports: ["approve", "reject"],
    } as const;
    const result = fromCanvasModel(
      {
        ...model,
        nodes: [...model.nodes.filter((n) => n.id !== "agent"), gate],
        edges: [
          ...model.edges,
          {
            id: canvasEdgeId("inner", "ok", "new_gate"),
            from: "inner",
            port: "ok",
            to: "new_gate",
          },
        ],
      },
      def,
    );
    expect(findNode(result.definition, "agent")).toBeNull();
    expect(result.definition.edges.some((e) => e.includes("agent"))).toBe(false);
    expect(findNode(result.definition, "new_gate")?.node).toEqual(defaultNodeConfig("gate"));
    const each = result.definition.nodes.each;
    expect(each?.kind === "map" ? each.body.edges : []).toContain("inner:ok -> new_gate");
  });
});
describe("layout and configuration", () => {
  it("lays out all levels deterministically and preserves fixed positions", () => {
    const def = fixture();
    const fixed = { command: { x: 9, y: 8, w: 7, h: 6 } };
    expect(autoLayout(def)).toEqual(autoLayout(def));
    expect(autoLayout(def, fixed).command).toEqual(fixed.command);
    expect(Object.keys(autoLayout(def))).toHaveLength(8);
    expect(autoLayout(def).agent?.x).toBeGreaterThan(autoLayout(def).command?.x ?? 0);
  });
  it.each(kinds)("decodes %s defaults", (kind) => {
    expect(decodeNode(defaultNodeConfig(kind)).kind).toBe(kind);
  });
});
describe("node edits", () => {
  it("renames references and preserves immutable updates and statuses", () => {
    const def = fixture();
    const renamed = renameNode(def, "agent", "planner");
    expect(renamed.edges).toContain("command -> planner");
    expect(renamed.canvas?.positions.planner).toEqual(def.canvas?.positions.agent);
    expect(renamed.canvas?.annotations[0]?.attachedTo).toBe("planner");
    expect(findNode(def, "planner")).toBeNull();
    expect(nextNodeId(def, "agent")).toBe("agent_2");
    expect(findNode(updateNode(def, "inner", defaultNodeConfig("gate")), "inner")?.node.kind).toBe(
      "gate",
    );
    expect(
      withNodeStatuses(toCanvasModel(def), new Map()).nodes.every((n) => n.status === undefined),
    ).toBe(true);
  });
});
