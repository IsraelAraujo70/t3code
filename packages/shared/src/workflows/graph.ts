/** Edges, ports and the per-level graph of a workflow definition. */
import * as Result from "effect/Result";

import type { WorkflowNode } from "@t3tools/contracts";

import type { CompiledEdge, CompiledGraph, CompiledNode, Diagnostic, ParsedEdge } from "./types.ts";

/** `"a -> b"` or `"a:port -> b"`, any spacing around the arrow and colon-free names. */
export const parseEdge = (text: string): Result.Result<ParsedEdge, string> => {
  const match =
    /^\s*([a-z][a-z0-9_]*)\s*(?::\s*([a-z][a-z0-9_]*))?\s*->\s*([a-z][a-z0-9_]*)\s*$/.exec(text);
  return match && match[1] !== undefined && match[3] !== undefined
    ? Result.succeed({ from: match[1], port: match[2] ?? null, to: match[3] })
    : Result.fail("Expected a -> b or a:port -> b");
};

/** Canonical spelling: `a -> b` or `a:port -> b`. */
export const formatEdge = (edge: ParsedEdge): string => {
  return `${edge.from}${edge.port === null ? "" : `:${edge.port}`} -> ${edge.to}`;
};

/** The ports a node can resolve through, in a stable order. */
export const nodePorts = (node: WorkflowNode): ReadonlyArray<string> => {
  switch (node.kind) {
    case "agent":
      return node.accept !== undefined ? ["pass", "fail"] : ["ok", "fail"];
    case "command":
      return node.check !== undefined ? ["pass", "fail"] : ["ok", "fail"];
    case "call":
    case "map":
    case "loop":
      return ["ok", "fail"];
    case "gate":
      return node.options ?? ["approve", "reject"];
    case "branch":
      return [
        ...new Set([
          ...node.cases.map((c) => c.port),
          ...(node.else === undefined ? [] : [node.else]),
        ]),
      ];
    case "output":
      return [];
    case "hillclimb":
      return ["target", "no_gain", "budget", "blocked", "fail"];
    case "arena":
      return ["ok", "insufficient", "fail"];
    case "graph":
      return ["ok", "blocked", "fail"];
    case "interrogate":
      return ["approve", "stuck", "fail"];
  }
};

/** The port an unlabeled edge leaves from; null when the node has no default (gate, branch, hillclimb, output). */
export const defaultPort = (node: WorkflowNode): string | null => {
  switch (node.kind) {
    case "agent":
      return node.accept !== undefined ? "pass" : "ok";
    case "command":
      return node.check !== undefined ? "pass" : "ok";
    case "call":
    case "map":
    case "loop":
    case "arena":
    case "graph":
      return "ok";
    case "interrogate":
      return "approve";
    case "gate":
    case "branch":
    case "output":
    case "hillclimb":
      return null;
  }
};

export interface BuildGraphInput {
  readonly nodes: { readonly [id: string]: WorkflowNode };
  readonly edges: ReadonlyArray<string>;
  /** Prefix for diagnostic paths: `""` at the top, `"nodes.each.body."` in a body. */
  readonly path: string;
  /** Called once per `map`/`loop` node for its compiled body. */
  readonly bodyOf: (id: string, node: WorkflowNode) => CompiledGraph | null;
}

/** One level: resolves edges and ports, orders the nodes and reports unknown-node, port, cycle and unreachable. */
export const buildGraph = (
  input: BuildGraphInput,
): { readonly graph: CompiledGraph; readonly diagnostics: ReadonlyArray<Diagnostic> } => {
  const diagnostics: Diagnostic[] = [];
  const edges: CompiledEdge[] = [];
  const ids = Object.keys(input.nodes);
  const report = (path: string, code: Diagnostic["code"], message: string) =>
    diagnostics.push({ path, code, message });
  input.edges.forEach((text, i) => {
    const path = `${input.path}edges[${i}]`;
    const parsed = parseEdge(text);
    if (Result.isFailure(parsed)) {
      report(path, "port", parsed.failure);
      return;
    }
    const { from, to, port } = parsed.success;
    const source = Object.hasOwn(input.nodes, from) ? input.nodes[from] : undefined;
    if (!source || !Object.hasOwn(input.nodes, to)) {
      report(path, "unknown-node", `Unknown node ${!source ? from : to}`);
      return;
    }
    if (source.kind === "output") {
      report(path, "port", "An output ends its path");
      return;
    }
    const ports = nodePorts(source);
    const resolved = port ?? defaultPort(source);
    if (resolved === null || !ports.includes(resolved)) {
      report(path, "port", `Choose a valid port: ${ports.join(", ")}`);
      return;
    }
    if (from === to) {
      report(path, "cycle", `Self-cycle at ${from}`);
      return;
    }
    if (edges.some((e) => e.from === from && e.port === resolved && e.to === to)) {
      report(path, "port", "duplicate edge");
      return;
    }
    edges.push({ from, port: resolved, to });
  });
  const nodes = new Map<string, CompiledNode>();
  for (const [id, node] of Object.entries(input.nodes)) {
    const incoming = edges.filter((e) => e.to === id);
    const outgoing = edges.filter((e) => e.from === id);
    nodes.set(id, {
      id,
      node,
      ports: nodePorts(node),
      incoming,
      outgoing,
      body: node.kind === "map" || node.kind === "loop" ? input.bodyOf(id, node) : null,
    });
    if (
      ids.length > 1 &&
      incoming.length === 0 &&
      (outgoing.length === 0 || node.kind === "output")
    )
      report(
        `${input.path}nodes.${id}`,
        "unreachable",
        node.kind === "output" ? `${id} is never reached` : `${id} has no edges`,
      );
  }
  const compiledNodes = [...nodes.values()];
  const roots = compiledNodes.filter((node) => node.incoming.length === 0).map((node) => node.id);
  const remaining = new Set(ids);
  const order: string[] = [];
  while (remaining.size > 0) {
    const ready = compiledNodes.find(
      (node) => remaining.has(node.id) && node.incoming.every((e) => !remaining.has(e.from)),
    )?.id;
    if (ready === undefined) {
      report(
        `${input.path}edges`,
        "cycle",
        `Cycle involving ${ids.filter((id) => remaining.has(id)).join(", ")}`,
      );
      order.length = 0;
      break;
    }
    remaining.delete(ready);
    order.push(ready);
  }
  return { graph: { path: input.path, nodes, edges, order, roots }, diagnostics };
};

/** Every node with a path to `id` in this level, `id` excluded. */
export const ancestors = (graph: CompiledGraph, id: string): ReadonlySet<string> => {
  const found = new Set<string>();
  const pending = [id];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    for (const edge of graph.nodes.get(current)?.incoming ?? []) {
      if (edge.from !== id && !found.has(edge.from)) {
        found.add(edge.from);
        pending.push(edge.from);
      }
    }
  }
  return found;
};
