import { describe, expect, it } from "vite-plus/test";
import * as Result from "effect/Result";
import type { WorkflowNode } from "@t3tools/contracts";
import { ancestors, buildGraph, defaultPort, formatEdge, nodePorts, parseEdge } from "./graph.ts";

const command: WorkflowNode = { kind: "command", argv: ["true"], cwd: "work" };
const build = (edges: string[], nodes: Record<string, WorkflowNode> = { a: command, b: command }) =>
  buildGraph({ nodes, edges, path: "nodes.each.body.", bodyOf: () => null });

describe("workflow graphs", () => {
  it.each(["a -> b", " a:ok->b ", "a : ok -> b"])("parses %s", (text) => {
    const parsed = parseEdge(text);
    expect(Result.isSuccess(parsed)).toBe(true);
    if (Result.isSuccess(parsed))
      expect(formatEdge(parsed.success)).toBe(text.includes(":") ? "a:ok -> b" : "a -> b");
  });
  it.each(["A -> b", "a-b -> c", "a -> b:p", "a", "a -> b -> c"])("rejects %s", (text) => {
    expect(Result.isFailure(parseEdge(text))).toBe(true);
  });
  it.each([
    [{ kind: "command", argv: ["true"], cwd: "work" }, ["ok", "fail"], "ok"],
    [{ kind: "agent", model: "$worker", prompt: "Go", workspace: "work" }, ["ok", "fail"], "ok"],
    [
      {
        kind: "agent",
        model: "$worker",
        prompt: "Go",
        workspace: "work",
        accept: { argv: ["true"], check: "true" },
      },
      ["pass", "fail"],
      "pass",
    ],
    [{ kind: "command", argv: ["true"], cwd: "work", check: "true" }, ["pass", "fail"], "pass"],
    [{ kind: "call", workflow: "child", params: {} }, ["ok", "fail"], "ok"],
    [
      { kind: "map", items: "[]", maxItems: 1, concurrency: 1, body: { nodes: {}, edges: [] } },
      ["ok", "fail"],
      "ok",
    ],
    [{ kind: "loop", until: "true", max: 1, body: { nodes: {}, edges: [] } }, ["ok", "fail"], "ok"],
    [{ kind: "output", status: "blocked", value: {} }, [], null],
    [
      {
        kind: "branch",
        cases: [
          { port: "yes", when: "true" },
          { port: "yes", when: "false" },
        ],
        else: "yes",
      },
      ["yes"],
      null,
    ],
    [
      {
        kind: "hillclimb",
        workspace: { project: "p", base: "main" },
        ledger: "runs",
        generator: { model: "$worker", prompt: "Go", workspace: "work" },
        measure: {},
        objective: { expr: "1", direction: "max" },
        keep: "true",
        target: "true",
        plateau: { rounds: 1 },
        budget: {},
      },
      ["target", "no_gain", "budget", "blocked", "fail"],
      null,
    ],
    [
      {
        kind: "arena",
        task: "Go",
        artifact: "out",
        runners: ["$worker"],
        minCandidates: 1,
        judge: "$judge",
        rubric: ["correct"],
        lead: "$lead",
        maxReruns: 0,
        workspace: { project: "p", base: "main" },
      },
      ["ok", "insufficient", "fail"],
      "ok",
    ],
    [
      {
        kind: "graph",
        goal: "Go",
        lead: "$lead",
        leaf: "$worker",
        workspace: { project: "p", base: "main" },
        finalChecks: [],
        reworkCap: 1,
        maxLeaves: 1,
        maxParallel: 1,
      },
      ["ok", "blocked", "fail"],
      "ok",
    ],
    [
      {
        kind: "interrogate",
        target: { workspace: "work", baseRef: "main" },
        intent: "Go",
        mode: "loop",
        reviewers: ["$worker"],
        lead: "$lead",
        checks: [],
        rounds: 3,
      },
      ["approve", "stuck", "fail"],
      "approve",
    ],
    [{ kind: "gate", ask: "?" }, ["approve", "reject"], null],
    [{ kind: "gate", ask: "?", options: ["yes"] }, ["yes"], null],
    [
      {
        kind: "branch",
        cases: [
          { port: "yes", when: "true" },
          { port: "yes", when: "false" },
        ],
        else: "else",
      },
      ["yes", "else"],
      null,
    ],
  ] satisfies [WorkflowNode, string[], string | null][])(
    "ports for %j",
    (node, ports, fallback) => {
      expect(nodePorts(node)).toEqual(ports);
      expect(defaultPort(node)).toBe(fallback);
    },
  );
  it.each([
    ["bad", "port"],
    ["a -> missing", "unknown-node"],
    ["missing -> b", "unknown-node"],
    ["a:no -> b", "port"],
    ["a -> a", "cycle"],
  ])("excludes invalid edge %s", (edge, code) => {
    const result = build([edge]);
    expect(result.graph.edges).toEqual([]);
    for (const node of result.graph.nodes.values()) {
      expect(node.incoming).toEqual([]);
      expect(node.outgoing).toEqual([]);
    }
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({ path: "nodes.each.body.edges[0]", code }),
    );
  });
  it("resolves defaults and rejects later duplicates", () => {
    const result = build(["a -> b", "a:ok -> b"]);
    expect(result.graph.edges).toEqual([{ from: "a", port: "ok", to: "b" }]);
    expect(result.diagnostics).toEqual([
      { path: "nodes.each.body.edges[1]", code: "port", message: "duplicate edge" },
    ]);
  });
  it("orders a diamond and finds its ancestors", () => {
    const { graph, diagnostics } = build(["a -> c", "a -> b", "b -> d", "c -> d"], {
      a: command,
      b: command,
      c: command,
      d: command,
    });
    expect(diagnostics).toEqual([]);
    expect(graph.order).toEqual(["a", "b", "c", "d"]);
    expect(graph.roots).toEqual(["a"]);
    expect(ancestors(graph, "d")).toEqual(new Set(["a", "b", "c"]));
  });
  it("compiles bodies once only for map and loop nodes", () => {
    const body = build([], { a: command }).graph;
    const calls: string[] = [];
    const result = buildGraph({
      nodes: {
        a: command,
        each: {
          kind: "map",
          items: "[]",
          maxItems: 1,
          concurrency: 1,
          body: { nodes: {}, edges: [] },
        },
        repeat: { kind: "loop", until: "true", max: 1, body: { nodes: {}, edges: [] } },
      },
      edges: [],
      path: "",
      bodyOf: (id) => {
        calls.push(id);
        return body;
      },
    });
    expect(calls).toEqual(["each", "repeat"]);
    expect(result.graph.nodes.get("each")?.body).toBe(body);
    expect(result.graph.nodes.get("repeat")?.body).toBe(body);
    expect(result.graph.nodes.get("a")?.body).toBeNull();
  });
  it("finds ancestors on a chain", () => {
    const { graph } = build(["a -> b", "b -> c"], { a: command, b: command, c: command });
    expect(ancestors(graph, "c")).toEqual(new Set(["a", "b"]));
  });
  it("rejects output and gate edges and lists available ports", () => {
    for (const [node, message] of [
      [{ kind: "output", status: "blocked", value: {} }, "An output ends its path"],
      [{ kind: "gate", ask: "?" }, "Choose a valid port: approve, reject"],
    ] satisfies [WorkflowNode, string][]) {
      const result = build(["a -> b"], { a: node, b: command });
      expect(result.diagnostics).toContainEqual({
        path: "nodes.each.body.edges[0]",
        code: "port",
        message,
      });
      expect(result.graph.edges).toEqual([]);
    }
    expect(build(["a:no -> b"]).diagnostics[0]).toEqual({
      path: "nodes.each.body.edges[0]",
      code: "port",
      message: "Choose a valid port: ok, fail",
    });
    expect(build(["a -> missing"]).diagnostics[0]?.message).toBe("Unknown node missing");
    expect(build(["missing -> b"]).diagnostics[0]?.message).toBe("Unknown node missing");
  });
  it("reports an output without incoming edges", () => {
    expect(
      build([], { a: command, b: { kind: "output", status: "blocked", value: {} } }).diagnostics,
    ).toContainEqual({
      path: "nodes.each.body.nodes.b",
      code: "unreachable",
      message: "b is never reached",
    });
  });
  it("reports one cycle with no order", () => {
    const result = build(["a -> b", "b -> a"]);
    expect(result.graph.order).toEqual([]);
    expect(result.diagnostics).toEqual([
      { path: "nodes.each.body.edges", code: "cycle", message: "Cycle involving a, b" },
    ]);
  });
  it("reports isolated nodes only in multi-node levels", () => {
    expect(build([], { a: command }).diagnostics).toEqual([]);
    expect(build([]).diagnostics.map((d) => d.path)).toEqual([
      "nodes.each.body.nodes.a",
      "nodes.each.body.nodes.b",
    ]);
  });
});
