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
