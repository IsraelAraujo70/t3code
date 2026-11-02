/**
 * The canvas boundary of a workflow (friend fork): a strict graph plus free annotations, the only
 * shape the web canvas and the Android graph draw. Node configuration is edited in the Inspector
 * against the definition, never on the canvas, so the canvas cannot produce configuration the
 * compiler has not seen. Design: docs/friend/workflows-design.md §7.2.
 */
import type {
  WorkflowCanvasLayout,
  WorkflowDefinition,
  WorkflowDiagnostic,
  WorkflowNode,
  WorkflowNodeKind,
  WorkflowStepStatus,
} from "@t3tools/contracts";

export type CanvasPositions = WorkflowCanvasLayout["positions"];
export type CanvasAnnotation = WorkflowCanvasLayout["annotations"][number];
export type CanvasViewport = NonNullable<WorkflowCanvasLayout["viewport"]>;

export interface CanvasNode {
  /** Unique across every level of the definition, so it keys positions too. */
  readonly id: string;
  readonly kind: WorkflowNodeKind;
  /** The node's `title`, else its id. */
  readonly label: string;
  /** Relative to the parent's top-left when `parent` is set (React Flow's sub-flow convention). */
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  /** The `map`/`loop` whose body holds this node; null at the top level. */
  readonly parent: string | null;
  /** `nodePorts` of the node, in that order: one source handle each. */
  readonly ports: ReadonlyArray<string>;
  /** Set only on the run screen. */
  readonly status?: WorkflowStepStatus;
}

export interface CanvasEdge {
  /** `canvasEdgeId(from, port, to)`: stable across round trips. */
  readonly id: string;
  readonly from: string;
  /** The port as written; null leaves through the source's default port (`defaultPort`). */
  readonly port: string | null;
  readonly to: string;
}

export interface CanvasModel {
  /** Parents before their children, so a sub-flow renderer always meets the parent first. */
  readonly nodes: ReadonlyArray<CanvasNode>;
  readonly edges: ReadonlyArray<CanvasEdge>;
  readonly annotations: ReadonlyArray<CanvasAnnotation>;
  readonly viewport?: CanvasViewport;
}

/** A library adapter (React Flow on web): the only code that knows the library's types. */
export interface CanvasAdapter<Native> {
  readonly fromModel: (model: CanvasModel, mode: "edit" | "run") => Native;
  readonly toModel: (native: Native) => CanvasModel;
}

export interface FromCanvasResult {
  readonly definition: WorkflowDefinition;
  readonly canvas: WorkflowCanvasLayout;
  /** `compileWorkflow` against `DEFAULT_HOST_LIMITS`; the server stays authoritative on save. */
  readonly diagnostics: ReadonlyArray<WorkflowDiagnostic>;
}

/**
 * The functions this module exports, by name: `export const toCanvasModel:
 * WorkflowCanvasApi["toCanvasModel"] = …`.
 */
export interface WorkflowCanvasApi {
  /** Edge ids come from the endpoints and the written port: `a:ok->b`, `a->b`. */
  readonly canvasEdgeId: (from: string, port: string | null, to: string) => string;
  /**
   * The canvas of a definition. Stored positions win; `autoLayout` fills every node without one.
   * `layout` defaults to `definition.canvas`.
   */
  readonly toCanvasModel: (
    definition: WorkflowDefinition,
    layout?: WorkflowCanvasLayout,
  ) => CanvasModel;
  /**
   * The definition the canvas now describes: nodes keep their configuration from `previous` (found
   * by id at any level) or get `defaultNodeConfig(kind)`; nodes missing from the model are dropped;
   * each level's edges are rebuilt from the model's edges in model order (`formatEdge`); positions
   * and annotations become `canvas`, keeping `previous.canvas.viewport` unless the model has one.
   */
  readonly fromCanvasModel: (model: CanvasModel, previous: WorkflowDefinition) => FromCanvasResult;
  /**
   * Deterministic left-to-right layered layout of every node at every level, boxes of
   * `CANVAS_NODE_SIZE` (200×64) and a `map`/`loop` grown to hold its body. `fixed` positions are
   * kept as they are; only nodes without one are placed. The same input always yields the same output.
   */
  readonly autoLayout: (definition: WorkflowDefinition, fixed?: CanvasPositions) => CanvasPositions;
  /** A schema-valid node of `kind` for the palette; the compiler may still report what to fill in. */
  readonly defaultNodeConfig: (kind: WorkflowNodeKind) => WorkflowNode;
  /** `kind`, else `kind_2`, `kind_3`…: the first id no level of the definition uses. */
  readonly nextNodeId: (definition: WorkflowDefinition, kind: WorkflowNodeKind) => string;
  /** A node and the `map`/`loop` holding it (null at the top), or null when no level has `id`. */
  readonly findNode: (
    definition: WorkflowDefinition,
    id: string,
  ) => { readonly node: WorkflowNode; readonly parent: string | null } | null;
  /** Replaces the configuration of node `id` where it lives. */
  readonly updateNode: (
    definition: WorkflowDefinition,
    id: string,
    node: WorkflowNode,
  ) => WorkflowDefinition;
  /**
   * Renames node `from` to `to` in its level's `nodes` and `edges`, in `canvas.positions` and in
   * annotations attached to it. Expressions that read `nodes.<from>` are left for the compiler.
   */
  readonly renameNode: (
    definition: WorkflowDefinition,
    from: string,
    to: string,
  ) => WorkflowDefinition;
  /** The model with each node's run status set from `statuses` (missing ids stay unset). */
  readonly withNodeStatuses: (
    model: CanvasModel,
    statuses: ReadonlyMap<string, WorkflowStepStatus>,
  ) => CanvasModel;
}

import type { WorkflowGraph } from "@t3tools/contracts";
import {
  compileWorkflow,
  DEFAULT_HOST_LIMITS,
  formatEdge,
  nodePorts,
  parseEdge,
} from "@t3tools/shared/workflows";
import * as Result from "effect/Result";

export const CANVAS_NODE_SIZE = { w: 200, h: 64 } as const;
export const canvasEdgeId: WorkflowCanvasApi["canvasEdgeId"] = (from, port, to) =>
  `${from}${port === null ? "" : `:${port}`}->${to}`;
export const defaultNodeConfig: WorkflowCanvasApi["defaultNodeConfig"] = (kind) => {
  const model = { provider: "claude", model: "claude-opus-5-5" } as const;
  const workspace = { project: "{{ params.project }}", readOnly: true } as const;
  const block = { project: "{{ params.project }}", base: "HEAD" };
  const agent = { model, prompt: "Describe the task", workspace };
  const body = { nodes: {}, edges: [] };
  switch (kind) {
    case "agent":
      return { kind, ...agent };
    case "command":
      return { kind, argv: ["echo", "hello"], cwd: workspace };
    case "gate":
      return { kind, ask: "Approve?" };
    case "branch":
      return { kind, cases: [{ port: "yes", when: "true" }], else: "no" };
    case "output":
      return { kind, status: "no_change", value: {} };
    case "call":
      return { kind, workflow: "workflow", params: {} };
    case "map":
      return { kind, items: "[]", maxItems: 1, concurrency: 1, body };
    case "loop":
      return { kind, until: "true", max: 1, body };
    case "hillclimb":
      return {
        kind,
        workspace: block,
        ledger: "experiments",
        generator: agent,
        measure: {},
        objective: { expr: "0", direction: "max" },
        keep: "false",
        target: "false",
        plateau: { rounds: 1 },
        budget: { iterations: 1 },
      };
    case "arena":
      return {
        kind,
        task: "Describe the task",
        artifact: "result",
        runners: [model],
        minCandidates: 1,
        judge: { provider: "codex", model: "gpt-6.1-sol" },
        rubric: ["Correct", "Complete", "Clear"],
        lead: model,
        maxReruns: 0,
        workspace: block,
      };
    case "graph":
      return {
        kind,
        goal: "Describe the task",
        lead: model,
        leaf: model,
        workspace: block,
        finalChecks: [],
        reworkCap: 1,
        maxLeaves: 1,
        maxParallel: 1,
      };
    case "interrogate":
      return {
        kind,
        target: { workspace: "workspace", baseRef: "HEAD" },
        intent: "Review",
        mode: "loop",
        reviewers: [model],
        lead: model,
        checks: [],
        rounds: 3,
      };
  }
};
export const findNode: WorkflowCanvasApi["findNode"] = (definition, id) => {
  const visit = (
    graph: WorkflowGraph,
    parent: string | null,
  ): ReturnType<WorkflowCanvasApi["findNode"]> => {
    for (const [key, node] of Object.entries(graph.nodes)) {
      if (key === id) return { node, parent };
      if (node.kind === "map" || node.kind === "loop") {
        const found = visit(node.body, key);
        if (found) return found;
      }
    }
    return null;
  };
  return visit(definition, null);
};
export const nextNodeId: WorkflowCanvasApi["nextNodeId"] = (definition, kind) => {
  let id: string = kind;
  for (let n = 2; findNode(definition, id); n++) id = `${kind}_${n}`;
  return id;
};
export const autoLayout: WorkflowCanvasApi["autoLayout"] = (definition, fixed = {}) => {
  const positions: Record<string, CanvasPositions[string]> = {};
  const visit = (graph: WorkflowGraph, nested: boolean) => {
    const sizes = new Map<string, { w: number; h: number }>();
    for (const [id, node] of Object.entries(graph.nodes))
      sizes.set(
        id,
        node.kind === "map" || node.kind === "loop" ? visit(node.body, true) : CANVAS_NODE_SIZE,
      );
    const ranks = new Map(Object.keys(graph.nodes).map((id) => [id, 0]));
    const remaining = new Set(ranks.keys());
    const edges = graph.edges.flatMap((text) => {
      const e = parseEdge(text);
      return Result.isSuccess(e) && ranks.has(e.success.from) && ranks.has(e.success.to)
        ? [e.success]
        : [];
    });
    while (remaining.size) {
      const id =
        [...remaining].find((key) => edges.every((e) => e.to !== key || !remaining.has(e.from))) ??
        [...remaining][0];
      if (id === undefined) break;
      remaining.delete(id);
      for (const edge of edges.filter((e) => e.from === id && remaining.has(e.to)))
        ranks.set(edge.to, Math.max(ranks.get(edge.to) ?? 0, (ranks.get(id) ?? 0) + 1));
    }
    let x = 24;
    let width = 48;
    let height = nested ? 80 : 48;
    for (const rank of [...new Set(ranks.values())].sort((a, b) => a - b)) {
      let y = nested ? 56 : 24;
      let columnWidth = 0;
      for (const [id, node] of Object.entries(graph.nodes)) {
        if (ranks.get(id) !== rank) continue;
        const size = sizes.get(id) ?? CANVAS_NODE_SIZE;
        positions[id] = fixed[id] ?? {
          x,
          y,
          ...(node.kind === "map" || node.kind === "loop" ? size : {}),
        };
        y += size.h + 40;
        columnWidth = Math.max(columnWidth, size.w);
      }
      width = x + columnWidth + 24;
      height = Math.max(height, y - 40 + 24);
      x += columnWidth + 80;
    }
    return { w: width, h: height };
  };
  visit(definition, false);
  return positions;
};
export const toCanvasModel: WorkflowCanvasApi["toCanvasModel"] = (
  definition,
  layout = definition.canvas,
) => {
  const positions = autoLayout(definition);
  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];
  const visit = (graph: WorkflowGraph, parent: string | null) => {
    for (const [id, node] of Object.entries(graph.nodes)) {
      const pos = { x: 0, y: 0, ...positions[id], ...layout?.positions[id] };
      nodes.push({
        id,
        kind: node.kind,
        label: node.title ?? id,
        parent,
        ports: nodePorts(node),
        ...pos,
        w: pos.w ?? CANVAS_NODE_SIZE.w,
        h: pos.h ?? CANVAS_NODE_SIZE.h,
      });
      if (node.kind === "map" || node.kind === "loop") visit(node.body, id);
    }
    for (const text of graph.edges) {
      const parsed = parseEdge(text);
      if (Result.isSuccess(parsed))
        edges.push({
          ...parsed.success,
          id: canvasEdgeId(parsed.success.from, parsed.success.port, parsed.success.to),
        });
    }
  };
  visit(definition, null);
  return {
    nodes,
    edges,
    annotations: layout?.annotations ?? [],
    ...(layout?.viewport ? { viewport: layout.viewport } : {}),
  };
};
export const fromCanvasModel: WorkflowCanvasApi["fromCanvasModel"] = (model, previous) => {
  const rebuild = (parent: string | null): WorkflowGraph => {
    const children = model.nodes.filter((n) => n.parent === parent);
    return {
      nodes: Object.fromEntries(
        children.map((n) => {
          const old = findNode(previous, n.id)?.node;
          const config = old?.kind === n.kind ? old : defaultNodeConfig(n.kind);
          return [
            n.id,
            config.kind === "map" || config.kind === "loop"
              ? { ...config, body: rebuild(n.id) }
              : config,
          ];
        }),
      ),
      edges: model.edges
        .filter(
          (e) =>
            children.some((n) => n.id === e.from) &&
            model.nodes.some((n) => n.id === e.to && n.parent === parent),
        )
        .map(formatEdge),
    };
  };
  const viewport = model.viewport ?? previous.canvas?.viewport;
  const canvas = {
    positions: Object.fromEntries(
      model.nodes.map((n) => [
        n.id,
        {
          x: n.x,
          y: n.y,
          ...(n.w !== CANVAS_NODE_SIZE.w ? { w: n.w } : {}),
          ...(n.h !== CANVAS_NODE_SIZE.h ? { h: n.h } : {}),
        },
      ]),
    ),
    annotations: model.annotations,
    ...(viewport ? { viewport } : {}),
  };
  const definition = { ...previous, ...rebuild(null), canvas };
  const compiled = compileWorkflow(definition, DEFAULT_HOST_LIMITS);
  return { definition, canvas, diagnostics: Result.isFailure(compiled) ? compiled.failure : [] };
};
const transformGraph = (
  graph: WorkflowGraph,
  transform: (id: string, node: WorkflowNode) => readonly [string, WorkflowNode],
  edge: (text: string) => string,
): WorkflowGraph => ({
  nodes: Object.fromEntries(
    Object.entries(graph.nodes).map(([id, node]) =>
      transform(
        id,
        node.kind === "map" || node.kind === "loop"
          ? { ...node, body: transformGraph(node.body, transform, edge) }
          : node,
      ),
    ),
  ),
  edges: graph.edges.map(edge),
});
export const updateNode: WorkflowCanvasApi["updateNode"] = (definition, id, node) => ({
  ...definition,
  ...transformGraph(
    definition,
    (key, old) => [key, key === id ? node : old],
    (text) => text,
  ),
});
export const renameNode: WorkflowCanvasApi["renameNode"] = (definition, from, to) => ({
  ...definition,
  ...transformGraph(
    definition,
    (id, node) => [
      id === from ? to : id,
      node.kind === "agent" && node.thread === `continue:${from}`
        ? { ...node, thread: `continue:${to}` }
        : node,
    ],
    (text) => {
      const p = parseEdge(text);
      return Result.isSuccess(p)
        ? formatEdge({
            ...p.success,
            from: p.success.from === from ? to : p.success.from,
            to: p.success.to === from ? to : p.success.to,
          })
        : text;
    },
  ),
  ...(definition.canvas
    ? {
        canvas: {
          ...definition.canvas,
          positions: Object.fromEntries(
            Object.entries(definition.canvas.positions).map(([id, pos]) => [
              id === from ? to : id,
              pos,
            ]),
          ),
          annotations: definition.canvas.annotations.map((a) =>
            a.attachedTo === from ? { ...a, attachedTo: to } : a,
          ),
        },
      }
    : {}),
});
export const withNodeStatuses: WorkflowCanvasApi["withNodeStatuses"] = (model, statuses) => ({
  ...model,
  nodes: model.nodes.map(({ status: _status, ...node }) => {
    const status = statuses.get(node.id);
    return { ...node, ...(status === undefined ? {} : { status }) };
  }),
});
