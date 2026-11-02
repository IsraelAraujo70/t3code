/**
 * Shapes shared by the workflow compiler's modules. Pure data: no Effect services, no I/O, so the
 * server, the canvas and Android validate exactly alike.
 */
import type {
  WorkflowDefinition,
  WorkflowDiagnostic,
  WorkflowHash,
  WorkflowModelRef,
  WorkflowNode,
} from "@t3tools/contracts";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<JsonValue>
  | { readonly [key: string]: JsonValue };

// ── Expressions ───────────────────────────────────────────────────────────────────────────────

export const EXPR_FUNCTIONS = [
  "len",
  "any",
  "all",
  "contains",
  "startsWith",
  "min",
  "max",
  "coalesce",
  "ledgerDigest",
  "ledgerBest",
] as const;
export type ExprFunction = (typeof EXPR_FUNCTIONS)[number];

export type BinaryOp = "||" | "&&" | "==" | "!=" | "<" | "<=" | ">" | ">=" | "+" | "-" | "*" | "/";

/** A dotted path: `nodes.select.output.tag` is root `nodes`, segments `["select", "output", "tag"]`. */
export interface PathExpr {
  readonly type: "path";
  readonly root: string;
  readonly segments: ReadonlyArray<string | number>;
}

export type Expr =
  | { readonly type: "literal"; readonly value: JsonValue }
  | PathExpr
  | { readonly type: "call"; readonly fn: ExprFunction; readonly args: ReadonlyArray<Expr> }
  | { readonly type: "unary"; readonly op: "!" | "-"; readonly arg: Expr }
  | {
      readonly type: "binary";
      readonly op: BinaryOp;
      readonly left: Expr;
      readonly right: Expr;
    };

export interface ExprError {
  readonly message: string;
  /** Character offset in the source text (the whole template, for a template). */
  readonly offset: number;
}

export type TemplatePart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "expr"; readonly expr: Expr; readonly source: string };

export interface ParsedTemplate {
  readonly parts: ReadonlyArray<TemplatePart>;
}

/** What an expression reads. A path whose root is absent from `roots` evaluates to null. */
export interface EvalEnv {
  readonly roots: { readonly [root: string]: JsonValue };
  /** Summary of a ledger for prompts; absent → evaluation error. */
  readonly ledgerDigest?: (ledgerId: string) => string;
  /** Sha of the best `validated` entry, or null; absent → evaluation error. */
  readonly ledgerBest?: (ledgerId: string) => string | null;
}

export interface EvalError {
  readonly message: string;
}

// ── Graph ─────────────────────────────────────────────────────────────────────────────────────

export interface ParsedEdge {
  readonly from: string;
  /** null for `a -> b`: the source's default port. */
  readonly port: string | null;
  readonly to: string;
}

export interface CompiledEdge {
  readonly from: string;
  /** Always resolved: an unlabeled edge carries the source's default port. */
  readonly port: string;
  readonly to: string;
}

export interface CompiledNode {
  readonly id: string;
  readonly node: WorkflowNode;
  readonly ports: ReadonlyArray<string>;
  readonly incoming: ReadonlyArray<CompiledEdge>;
  readonly outgoing: ReadonlyArray<CompiledEdge>;
  /** The body of a `map` or `loop`; null for every other kind. */
  readonly body: CompiledGraph | null;
}

/** One level: the top of a definition or a `map`/`loop` body. */
export interface CompiledGraph {
  /** Diagnostic path prefix of this level's `nodes`/`edges`: `""` at the top, `"nodes.each.body."` in a body. */
  readonly path: string;
  /** In declaration order. */
  readonly nodes: ReadonlyMap<string, CompiledNode>;
  readonly edges: ReadonlyArray<CompiledEdge>;
  /** Topological order (stable: declaration order among ready nodes). Empty when the level has a cycle. */
  readonly order: ReadonlyArray<string>;
  /** Nodes with no incoming edge, in declaration order. */
  readonly roots: ReadonlyArray<string>;
}

// ── Commands and models ───────────────────────────────────────────────────────────────────────

/** Actions a command may take only after Israel approves an owner-only gate the engine opens. */
const PROTECTED_ACTIONS = ["deploy", "restart", "merge", "force-push", "settings"] as const;
export type ProtectedAction = (typeof PROTECTED_ACTIONS)[number];

export type CommandClass =
  | { readonly kind: "allowed" }
  /** Runs after an owner-only approval gate. */
  | { readonly kind: "protected"; readonly action: ProtectedAction; readonly reason: string }
  /** Refused when saved: the engine could not tell what it runs, or it escalates privileges. */
  | { readonly kind: "forbidden"; readonly reason: string }
  | { readonly kind: "inline-shell"; readonly reason: string };

export type ModelFamily = "claude" | "gpt";

// ── Compiler ──────────────────────────────────────────────────────────────────────────────────

/** Ceilings and facts of the bots host the compiler checks against. */
export interface HostLimits {
  readonly maxSteps: number;
  readonly maxWallMs: number;
  readonly maxTokens: number;
  /** Billable tokens of all runs in one workflow day (default 40M). */
  readonly workflowTokensPerDay: number;
  /** Optional USD cap per workflow day; null is off (the default). */
  readonly workflowUsdPerDay: number | null;
  /** Local hour, in the host's time zone, at which the workflow day turns (default 12). */
  readonly dayStartsAtHour: number;
  /** A cron trigger's misfire policy when the definition gives none (default latest, 1h). */
  readonly misfire: { readonly mode: "latest" | "skip"; readonly graceMs: number };
  /** Projects linked to a Linear team; `card.project` may not be one. */
  readonly linearLinkedProjects?: ReadonlySet<string>;
  /** Saved workflows by id → the workflows each one calls. Absent → only self-calls are caught. */
  readonly callGraph?: ReadonlyMap<string, ReadonlyArray<string>>;
}

export const DEFAULT_HOST_LIMITS: HostLimits = {
  maxSteps: 500,
  maxWallMs: 24 * 3_600_000,
  maxTokens: 30_000_000,
  workflowTokensPerDay: 40_000_000,
  workflowUsdPerDay: null,
  dayStartsAtHour: 12,
  misfire: { mode: "latest", graceMs: 3_600_000 },
};

export interface CompiledWorkflow {
  /** Decoded and normalized (edges respaced to `a -> b` / `a:p -> b`). */
  readonly definition: WorkflowDefinition;
  readonly hash: WorkflowHash;
  readonly root: CompiledGraph;
  /** `models`, plus nothing else: every `$name` a node uses resolves here. */
  readonly models: ReadonlyMap<string, WorkflowModelRef>;
}

export type Diagnostic = WorkflowDiagnostic;
