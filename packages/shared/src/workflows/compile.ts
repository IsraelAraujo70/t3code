/** The workflow compiler: decode, every static check of the design (§1.3), then the semantic hash. */
import * as Cron from "effect/Cron";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

import {
  isWebhookDedupeTemplate,
  WORKFLOW_MAX_RESOURCE_SLOTS,
  WORKFLOW_NODE_ID_PATTERN,
  WORKFLOW_RESOURCE_PATTERN,
  WorkflowDefinition,
  type WorkflowAgentNode,
  type WorkflowCommandSpec,
  type WorkflowDiagnosticCode,
  type WorkflowModelRef,
  type WorkflowModelUse,
  type WorkflowNode,
  type WorkflowOutputShape,
  type WorkflowWorkspaceUse,
} from "@t3tools/contracts";

import { semanticHash } from "./canonical.ts";
import { citesHeavyScript, classifyCommand } from "./command.ts";
import { exprPaths, parseExpr } from "./expr.ts";
import { ancestors, buildGraph, formatEdge, parseEdge } from "./graph.ts";
import {
  isModelAlias,
  modelFamily,
  modelForValue,
  modelParamOf,
  resolveModelUse,
} from "./models.ts";
import { matchesWhole } from "./output.ts";
import { parseTemplate } from "./template.ts";
import { decodeRunParams, isOnDemandTrigger } from "./triggers.ts";
import type {
  CompiledGraph,
  CompiledWorkflow,
  Diagnostic,
  Expr,
  ExprError,
  HostLimits,
  PathExpr,
} from "./types.ts";

const decodeDefinition = Schema.decodeUnknownResult(WorkflowDefinition);
const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

const DURATION_UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000 } as const;
const parseDurationMs = (text: string): number => {
  const unit = text.slice(-1) as keyof typeof DURATION_UNIT_MS;
  return Number(text.slice(0, -1)) * DURATION_UNIT_MS[unit];
};

/** Roots every expression may read, besides the context ones below. */
const BASE_ROOTS = ["params", "trigger", "nodes", "workspaces", "run", "step"] as const;
const BODY_ROOTS = ["item", "iteration"] as const;
const CHECK_ROOTS = ["exit", "out"] as const;
const HILLCLIMB_ROOTS = ["m", "best", "origin", "candidate"] as const;
const RESERVED_ROOTS = new Set<string>([
  ...BASE_ROOTS,
  ...BODY_ROOTS,
  ...CHECK_ROOTS,
  ...HILLCLIMB_ROOTS,
]);
const NODE_FIELDS = new Set(["output", "status", "port", "thread", "error", "answer"]);
const WORKSPACE_FIELDS = new Set(["branch", "head", "path"]);
const RUN_FIELDS = new Set(["id", "dir"]);
const STEP_FIELDS = new Set(["dir"]);
/** The worktree each block exports to the nodes after it, as `<node>.<name>`. */
const BLOCK_EXPORTS: Partial<Record<WorkflowNode["kind"], string>> = {
  hillclimb: "best",
  arena: "graft",
  graph: "integration",
};
/** The option a bot picks on a gate routed to it when it cannot resolve it: Israel gets the gate. */
export const ESCALATE = "escalate";
/** Outputs read by the engine from its own records; every other non-command output may carry model text. */
const TRUSTED_OUTPUT_KINDS = new Set<WorkflowNode["kind"]>([
  "command",
  "hillclimb",
  "graph",
  "gate",
  "branch",
  "output",
]);
/** Names a step may set: upper snake case, minus what changes how programs load or where traffic goes. */
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const ENV_DENIED = new Set([
  "PATH",
  "HOME",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "NODE_OPTIONS",
  "NODE_PATH",
  "BASH_ENV",
  "ENV",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_CONFIG_GLOBAL",
  "GIT_SSH_COMMAND",
  "WF_TOKEN_BUDGET",
  "WF_SLOT",
]);

/** Where an expression or template is evaluated: what it may read. */
interface Scope {
  /** Nodes whose results exist when this runs: the node's ancestors, through enclosing bodies. */
  readonly nodes: ReadonlySet<string>;
  readonly roots: ReadonlySet<string>;
  /** Why each bound map item (`item` and every enclosing `as` name) is untrusted, or null. */
  readonly itemTaint: ReadonlyMap<string, string | null>;
}

/** Sinks where untrusted text is refused: argv, env, git refs and branch names. */
type Sink = "text" | "argv";

const formatPath = (segments: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>): string =>
  segments.reduce<string>((path, entry) => {
    const segment = typeof entry === "object" ? entry.key : entry;
    if (typeof segment === "number") return `${path}[${segment}]`;
    return path === "" ? String(segment) : `${path}.${String(segment)}`;
  }, "");

const describeExprError = (error: ExprError): string => `${error.message} (at ${error.offset})`;

/** Pure. The same on the server (authoritative), the canvas and Android. */
export const compileWorkflow = (
  input: unknown,
  host: HostLimits,
): Result.Result<CompiledWorkflow, ReadonlyArray<Diagnostic>> => {
  const decoded = decodeDefinition(input, { errors: "all", onExcessProperty: "error" });
  if (Result.isFailure(decoded)) {
    return Result.fail(
      formatIssues(decoded.failure.issue).issues.map((issue) => ({
        path: formatPath(issue.path ?? []),
        code: "schema" as const,
        message: issue.message,
      })),
    );
  }
  const definition = normalizeEdges(decoded.success);
  const diagnostics: Diagnostic[] = [];
  const report = (path: string, code: WorkflowDiagnosticCode, message: string) => {
    if (!diagnostics.some((d) => d.path === path && d.code === code && d.message === message)) {
      diagnostics.push({ path, code, message });
    }
  };

  // Every node of every level, by id: ids are unique across levels so `nodes.<id>` is never ambiguous.
  const nodeById = new Map<string, WorkflowNode>();
  /** The nearest map whose body holds each node (a loop body keeps its map's item); null at the top. */
  const itemMapById = new Map<string, string | null>();
  const itemMapOf = (id: string) => itemMapById.get(id) ?? null;
  /** The agent that opened the thread `id` runs in, following `continue:` (a cycle stops it). */
  const threadOrigin = (id: string): string => {
    const seen = new Set<string>();
    let current = id;
    for (;;) {
      const node = nodeById.get(current);
      const thread = node?.kind === "agent" ? node.thread : undefined;
      if (typeof thread !== "string" || !thread.startsWith("continue:") || seen.has(current))
        return current;
      seen.add(current);
      current = thread.slice("continue:".length);
    }
  };
  const collectNodes = (
    nodes: { readonly [id: string]: WorkflowNode },
    prefix: string,
    itemMap: string | null = null,
  ) => {
    for (const [id, node] of Object.entries(nodes)) {
      itemMapById.set(id, itemMap);
      const path = `${prefix}nodes.${id}`;
      if (!WORKFLOW_NODE_ID_PATTERN.test(id)) {
        report(path, "schema", `node id "${id}" must match ${WORKFLOW_NODE_ID_PATTERN}`);
      }
      if (nodeById.has(id)) report(path, "schema", `node id "${id}" is used twice`);
      if (id === "accept" || id === "judge") {
        report(path, "schema", `node id "${id}" is reserved for an agent step's acceptance`);
      }
      nodeById.set(id, node);
      if (node.kind === "map" || node.kind === "loop")
        collectNodes(node.body.nodes, `${path}.body.`, node.kind === "map" ? id : itemMap);
    }
  };
  collectNodes(definition.nodes, "");
  for (const [section, record] of [
    ["params", definition.params],
    ["models", definition.models],
    ["workspaces", definition.workspaces],
  ] as const) {
    for (const name of Object.keys(record ?? {})) {
      if (!WORKFLOW_NODE_ID_PATTERN.test(name)) {
        report(`${section}.${name}`, "schema", `"${name}" must match ${WORKFLOW_NODE_ID_PATTERN}`);
      }
    }
  }

  const buildLevel = (
    nodes: { readonly [id: string]: WorkflowNode },
    edges: ReadonlyArray<string>,
    path: string,
  ): CompiledGraph => {
    const built = buildGraph({
      nodes,
      edges,
      path,
      bodyOf: (id, node) =>
        node.kind === "map" || node.kind === "loop"
          ? buildLevel(node.body.nodes, node.body.edges, `${path}nodes.${id}.body.`)
          : null,
    });
    for (const d of built.diagnostics) report(d.path, d.code, d.message);
    return built.graph;
  };
  const root = buildLevel(definition.nodes, definition.edges, "");

  for (const [name, resource] of Object.entries(definition.resources ?? {})) {
    if (!WORKFLOW_RESOURCE_PATTERN.test(name))
      report(`resources.${name}`, "resource", `"${name}" must match ${WORKFLOW_RESOURCE_PATTERN}`);
    if (resource.slots > WORKFLOW_MAX_RESOURCE_SLOTS)
      report(
        `resources.${name}.slots`,
        "resource",
        `a resource has at most ${WORKFLOW_MAX_RESOURCE_SLOTS} slots`,
      );
  }
  /** `uses` names a declared resource; heavy is a resource too, and one step waits for one. */
  const checkUses = (uses: string | undefined, heavy: boolean, path: string) => {
    if (uses === undefined) return;
    if (own(definition.resources, uses) === undefined)
      report(`${path}.uses`, "resource", `"${uses}" is not in resources`);
    if (heavy)
      report(
        `${path}.uses`,
        "resource",
        "heavy is the host's one-slot resource: use heavy or uses, not both",
      );
  };

  // ── Patterns, params and models ─────────────────────────────────────────────────────────────

  const checkPattern = (pattern: string | undefined, path: string) => {
    if (pattern === undefined) return;
    if (safeTest(pattern, "") === null) {
      report(path, "schema", `"${pattern}" is not a valid regular expression`);
    }
  };
  const checkShape = (shape: WorkflowOutputShape | undefined, path: string) => {
    for (const [field, spec] of Object.entries(shape ?? {})) {
      checkPattern(spec.pattern, `${path}.${field}.pattern`);
      // A pattern makes a field trusted, so it must be one checkOutput enforces.
      if (spec.pattern !== undefined && spec.type !== "string" && spec.type !== "string[]") {
        report(
          `${path}.${field}.pattern`,
          "schema",
          `a pattern applies to string and string[] fields, not ${spec.type}`,
        );
      }
    }
  };
  for (const [name, spec] of Object.entries(definition.params ?? {})) {
    const path = `params.${name}`;
    checkPattern(spec.pattern, `${path}.pattern`);
    if (spec.maxItems !== undefined && spec.type !== "string[]")
      report(`${path}.maxItems`, "schema", "maxItems applies to string[] params");
    if (spec.enum !== undefined && spec.type !== "string")
      report(`${path}.enum`, "schema", "enum applies to string params");
    if (spec.enum !== undefined && spec.type === "string" && spec.default !== undefined) {
      const problem = decodeRunParams({ [name]: spec }, {});
      if (!problem.ok) report(`${path}.default`, "schema", problem.errors[0]!.message);
    }
    if (spec.type === "string[]") {
      if (spec.default === undefined) continue;
      const problem = decodeRunParams({ [name]: spec }, {});
      if (!problem.ok) report(`${path}.default`, "schema", problem.errors[0]!.message);
      continue;
    }
    if (spec.default === undefined) continue;
    if (typeof spec.default !== spec.type) {
      report(
        `${path}.default`,
        "schema",
        `the default of a ${spec.type} param must be a ${spec.type}`,
      );
    } else if (
      spec.pattern !== undefined &&
      typeof spec.default === "string" &&
      !matchesWhole(spec.pattern, spec.default)
    ) {
      report(`${path}.default`, "schema", `"${spec.default}" does not match ${spec.pattern}`);
    }
  }

  const models = new Map<string, WorkflowModelRef>(Object.entries(definition.models ?? {}));
  for (const [name, ref] of models) {
    if (isModelAlias(ref.model)) {
      report(`models.${name}.model`, "model-alias", aliasMessage(ref.model));
    }
  }
  /**
   * `$params.<name>` is a model only an agent node may take: a string param with an `enum`, each
   * value naming a `models` entry. It checks as its default (or first) value.
   */
  const modelParamsChecked = new Set<string>();
  const paramModel = (name: string, path: string): WorkflowModelRef | null => {
    const spec = own(definition.params, name);
    if (spec === undefined) {
      report(path, "model-alias", `params.${name} is not a declared param`);
      return null;
    }
    if (spec.type !== "string" || spec.enum === undefined) {
      report(
        path,
        "model-alias",
        `params.${name} picks a model only as a string param with an enum`,
      );
      return null;
    }
    let first: WorkflowModelRef | null = null;
    for (const value of spec.enum) {
      const ref = modelForValue(value, definition.models);
      if (Result.isSuccess(ref)) {
        if (value === (spec.default ?? spec.enum[0])) first = ref.success;
      } else if (!modelParamsChecked.has(name)) {
        report(`params.${name}.enum`, "model-alias", ref.failure);
      }
    }
    modelParamsChecked.add(name);
    return first;
  };
  const resolveModel = (
    use: WorkflowModelUse,
    path: string,
    fromParam = false,
  ): WorkflowModelRef | null => {
    const param = typeof use === "string" ? modelParamOf(use) : null;
    if (param !== null) {
      if (fromParam) return paramModel(param, path);
      report(path, "model-alias", "only an agent node's model may come from a param");
      return null;
    }
    const resolved = resolveModelUse(use, definition.models);
    if (Result.isFailure(resolved)) {
      report(path, "model-alias", resolved.failure);
      return null;
    }
    if (typeof use !== "string" && isModelAlias(resolved.success.model)) {
      report(`${path}.model`, "model-alias", aliasMessage(resolved.success.model));
    }
    return resolved.success;
  };

  // ── Expressions, templates and taint ────────────────────────────────────────────────────────

  const pathTaint = (path: PathExpr, scope: Scope): string | null => {
    const [first, second, third] = path.segments;
    switch (path.root) {
      case "trigger":
        return "trigger data";
      case "params": {
        const spec = typeof first === "string" ? own(definition.params, first) : undefined;
        return (spec?.type === "string" || spec?.type === "string[]") &&
          spec.pattern === undefined &&
          spec.enum === undefined
          ? `param ${String(first)} has no pattern`
          : null;
      }
      case "nodes": {
        // A gate's answer is free text from whoever decided it, a bot included.
        if (typeof first === "string" && second === "answer") return `the answer to ${first}`;
        if (typeof first !== "string" || second !== "output") return null;
        const node = nodeById.get(first);
        if (node === undefined || TRUSTED_OUTPUT_KINDS.has(node.kind)) return null;
        if (node.kind !== "agent") return `the output of ${node.kind} ${first}`;
        return agentOutputTaint(first, node.output, third);
      }
      default:
        return scope.itemTaint.get(path.root) ?? null;
    }
  };

  const exprTaint = (expr: Expr, scope: Scope): string | null => {
    switch (expr.type) {
      case "literal":
        return null;
      case "path":
        return pathTaint(expr, scope);
      case "unary":
        return exprTaint(expr.arg, scope);
      case "binary":
        return exprTaint(expr.left, scope) ?? exprTaint(expr.right, scope);
      case "call":
        if (expr.fn === "ledgerDigest") return "a ledger digest";
        if (expr.fn === "ledgerBest") return null;
        for (const arg of expr.args) {
          const taint = exprTaint(arg, scope);
          if (taint !== null) return taint;
        }
        return null;
    }
  };

  const checkPaths = (expr: Expr, path: string, scope: Scope) => {
    for (const p of exprPaths(expr)) {
      const [first, second] = p.segments;
      if (!scope.roots.has(p.root)) {
        report(path, "template-root", `"${p.root}" cannot be read here`);
        continue;
      }
      switch (p.root) {
        case "params":
          if (typeof first !== "string" || own(definition.params, first) === undefined) {
            report(path, "template-root", `params.${String(first)} is not a declared param`);
          }
          break;
        case "nodes":
          if (typeof first !== "string" || !nodeById.has(first)) {
            report(path, "template-root", `there is no node ${String(first)}`);
          } else if (!scope.nodes.has(first)) {
            report(path, "template-root", `node ${first} has not run when this is evaluated`);
          } else if (typeof second !== "string" || !NODE_FIELDS.has(second)) {
            report(
              path,
              "template-root",
              `nodes.${first} has output, status, port, thread, error and answer`,
            );
          }
          break;
        case "workspaces":
          if (typeof first !== "string" || own(definition.workspaces, first) === undefined) {
            report(
              path,
              "template-root",
              `workspaces.${String(first)} is not a declared workspace`,
            );
          } else if (typeof second !== "string" || !WORKSPACE_FIELDS.has(second)) {
            report(path, "template-root", `workspaces.${first} has branch, head and path`);
          }
          break;
        case "run":
          if (typeof first !== "string" || !RUN_FIELDS.has(first)) {
            report(path, "template-root", "run has id and dir");
          }
          break;
        case "step":
          if (typeof first !== "string" || !STEP_FIELDS.has(first)) {
            report(path, "template-root", "step has dir");
          }
          break;
      }
    }
  };

  const checkSink = (exprs: ReadonlyArray<Expr>, path: string, scope: Scope, sink: Sink) => {
    if (sink !== "argv") return;
    for (const expr of exprs) {
      const taint = exprTaint(expr, scope);
      if (taint !== null) {
        report(
          path,
          "untrusted-in-argv",
          `${taint} may not reach argv, env or a git ref; pass it through a param or output field with a pattern`,
        );
        return;
      }
    }
  };

  const checkExpr = (text: string, path: string, scope: Scope): Expr | null => {
    const parsed = parseExpr(text);
    if (Result.isFailure(parsed)) {
      report(path, "expr", describeExprError(parsed.failure));
      return null;
    }
    checkPaths(parsed.success, path, scope);
    return parsed.success;
  };

  const checkTemplate = (text: string, path: string, scope: Scope, sink: Sink = "text") => {
    const parsed = parseTemplate(text);
    if (Result.isFailure(parsed)) {
      report(path, "expr", describeExprError(parsed.failure));
      return;
    }
    const exprs = parsed.success.parts.flatMap((part) => (part.type === "expr" ? [part.expr] : []));
    for (const expr of exprs) checkPaths(expr, path, scope);
    checkSink(exprs, path, scope, sink);
  };

  const withRoots = (scope: Scope, roots: ReadonlyArray<string>): Scope => ({
    ...scope,
    roots: new Set([...scope.roots, ...roots]),
  });

  // ── Workspaces ──────────────────────────────────────────────────────────────────────────────

  /** Named workspace → the scopes of the nodes that use it, to check its templates against each. */
  const workspaceUsers = new Map<string, Array<{ readonly node: string; readonly scope: Scope }>>();

  interface UseContext {
    readonly node: string;
    readonly scope: Scope;
    /** Inside a hillclimb's specs, where `attempt` names the candidate's worktree. */
    readonly hillclimb: boolean;
  }

  const checkWorkspaceName = (name: string, path: string, ctx: UseContext): boolean => {
    if (own(definition.workspaces, name) !== undefined) {
      const users = workspaceUsers.get(name) ?? [];
      users.push({ node: ctx.node, scope: ctx.scope });
      workspaceUsers.set(name, users);
      return true;
    }
    if (name === "attempt" && ctx.hillclimb) return true;
    const dot = name.indexOf(".");
    if (dot > 0) {
      const owner = name.slice(0, dot);
      const exported = name.slice(dot + 1);
      const node = nodeById.get(owner);
      if (
        node !== undefined &&
        BLOCK_EXPORTS[node.kind] === exported &&
        (owner === ctx.node || ctx.scope.nodes.has(owner))
      ) {
        return true;
      }
    }
    report(
      path,
      "unknown-node",
      `"${name}" is not a declared workspace or the export of a block that ran before`,
    );
    return false;
  };

  const checkWorkspaceUse = (use: WorkflowWorkspaceUse, path: string, ctx: UseContext) => {
    if (typeof use === "string") checkWorkspaceName(use, path, ctx);
    else checkTemplate(use.project, `${path}.project`, ctx.scope);
  };

  // ── Commands ────────────────────────────────────────────────────────────────────────────────

  const checkArgv = (
    argv: ReadonlyArray<string>,
    path: string,
    scope: Scope,
    heavy: boolean,
    selfSerializing: boolean,
  ) => {
    const verdict = classifyCommand(argv);
    if (verdict.kind === "forbidden" || verdict.kind === "inline-shell") {
      report(
        `${path}.argv`,
        "forbidden-command",
        verdict.kind === "inline-shell"
          ? `${verdict.reason}; put the code in a script file in the project`
          : verdict.reason,
      );
    }
    if (heavy && (selfSerializing || citesHeavyScript(argv))) {
      report(
        `${path}.argv`,
        "heavy-nesting",
        "the command already serializes itself through heavy.sh; drop heavy (nesting the lock lets two copies run)",
      );
    }
    argv.forEach((arg, index) => checkTemplate(arg, `${path}.argv[${index}]`, scope, "argv"));
  };

  const checkCommand = (
    spec: WorkflowCommandSpec,
    path: string,
    ctx: UseContext,
    argvRoots: ReadonlyArray<string>,
  ) => {
    checkArgv(
      spec.argv,
      path,
      withRoots(ctx.scope, argvRoots),
      spec.heavy === true,
      spec.selfSerializing === true,
    );
    checkWorkspaceUse(spec.cwd, `${path}.cwd`, ctx);
    for (const [name, value] of Object.entries(spec.env ?? {})) {
      if (!ENV_NAME.test(name) || ENV_DENIED.has(name)) {
        report(`${path}.env.${name}`, "forbidden-command", `a step may not set ${name}`);
      }
      checkTemplate(value, `${path}.env.${name}`, withRoots(ctx.scope, argvRoots), "argv");
    }
    if (spec.check !== undefined)
      checkExpr(spec.check, `${path}.check`, withRoots(ctx.scope, CHECK_ROOTS));
    if (spec.tokensFrom !== undefined && spec.tokenReservation === undefined) {
      report(
        `${path}.tokenReservation`,
        "budget-ceiling",
        "a command with tokensFrom must reserve tokens: set tokenReservation",
      );
    }
    checkReservation(spec.tokenReservation, `${path}.tokenReservation`);
    checkTimeout(spec.timeout, `${path}.timeout`);
    checkShape(spec.output, `${path}.output`);
  };

  // ── Budgets ─────────────────────────────────────────────────────────────────────────────────

  const runWallMs = parseDurationMs(definition.budget.wall);
  if (definition.budget.steps > host.maxSteps) {
    report("budget.steps", "budget-ceiling", `the host allows at most ${host.maxSteps} steps`);
  }
  if (definition.budget.tokens > host.maxTokens) {
    report("budget.tokens", "budget-ceiling", `the host allows at most ${host.maxTokens} tokens`);
  }
  if (runWallMs > host.maxWallMs) {
    report(
      "budget.wall",
      "budget-ceiling",
      `the host allows at most ${host.maxWallMs / 3_600_000}h`,
    );
  }
  function checkTimeout(timeout: string | undefined, path: string) {
    if (timeout !== undefined && parseDurationMs(timeout) > runWallMs) {
      report(
        path,
        "budget-ceiling",
        `longer than the run's wall budget (${definition.budget.wall})`,
      );
    }
  }
  function checkReservation(tokens: number | undefined, path: string) {
    if (tokens !== undefined && tokens > definition.budget.tokens) {
      report(
        path,
        "budget-ceiling",
        `more than the run's token budget (${definition.budget.tokens})`,
      );
    }
  }

  // ── Nodes ───────────────────────────────────────────────────────────────────────────────────

  const checkAgent = (
    spec: {
      readonly model: WorkflowModelUse;
      readonly prompt: string;
      readonly workspace: WorkflowWorkspaceUse;
      readonly thread?: WorkflowAgentNode["thread"];
      readonly access?: "read" | "write" | undefined;
      readonly output?: WorkflowOutputShape | undefined;
      readonly accept?: WorkflowNodeAccept | undefined;
      readonly tokenReservation?: number | undefined;
      readonly timeout?: string | undefined;
    },
    path: string,
    ctx: UseContext,
    modelFromParam = false,
  ) => {
    resolveModel(spec.model, `${path}.model`, modelFromParam);
    checkTemplate(spec.prompt, `${path}.prompt`, ctx.scope);
    checkWorkspaceUse(spec.workspace, `${path}.workspace`, ctx);
    if (typeof spec.workspace !== "string" && spec.access === "write") {
      report(`${path}.access`, "schema", "a read-only checkout cannot take access: write");
    }
    checkThread(spec, path, ctx);
    checkShape(spec.output, `${path}.output`);
    checkReservation(spec.tokenReservation, `${path}.tokenReservation`);
    checkTimeout(spec.timeout, `${path}.timeout`);
    const accept = spec.accept;
    if (accept === undefined) return;
    if ("argv" in accept) {
      checkArgv(accept.argv, `${path}.accept`, ctx.scope, accept.heavy === true, false);
      checkUses(accept.uses, accept.heavy === true, `${path}.accept`);
      checkExpr(accept.check, `${path}.accept.check`, withRoots(ctx.scope, CHECK_ROOTS));
    } else {
      resolveModel(accept.judge, `${path}.accept.judge`);
      checkTemplate(accept.criterion, `${path}.accept.criterion`, ctx.scope);
    }
  };

  function checkThread(
    spec: {
      readonly thread?: WorkflowAgentNode["thread"];
      readonly model: WorkflowModelUse;
      readonly workspace: WorkflowWorkspaceUse;
      readonly access?: "read" | "write" | undefined;
    },
    path: string,
    ctx: UseContext,
  ) {
    if (spec.thread === undefined || spec.thread === "new") return;
    if (typeof spec.thread !== "string") {
      const visible = spec.thread;
      if (visible.kanbanCard !== undefined)
        checkTemplate(visible.kanbanCard, `${path}.thread.kanbanCard`, ctx.scope);
      if (visible.title !== undefined)
        checkTemplate(visible.title, `${path}.thread.title`, ctx.scope);
      if (typeof spec.workspace !== "string" || (spec.access ?? "read") !== "write")
        report(
          `${path}.thread`,
          "thread-continue",
          "a visible thread works in a named workspace with access: write",
        );
      return;
    }
    const target = spec.thread.startsWith("continue:")
      ? spec.thread.slice("continue:".length)
      : null;
    if (target === null) {
      report(
        `${path}.thread`,
        "thread-continue",
        `thread is "new" or "continue:<node>", not "${spec.thread}"`,
      );
      return;
    }
    const continued = nodeById.get(target);
    if (continued?.kind !== "agent" || !ctx.scope.nodes.has(target)) {
      report(
        `${path}.thread`,
        "thread-continue",
        `${target} is not an agent node that ran before this one`,
      );
      return;
    }
    if (
      canonicalUse(continued.workspace) !== canonicalUse(spec.workspace) ||
      (continued.access ?? "read") !== (spec.access ?? "read")
    ) {
      report(
        `${path}.thread`,
        "thread-continue",
        `a thread keeps one workspace and one access: use ${target}'s workspace and access, or a new thread`,
      );
    }
    // A model a param picks is the same model only when both read the same param.
    const fromParam = [spec.model, continued.model].some(
      (use) => typeof use === "string" && modelParamOf(use) !== null,
    );
    if (fromParam && spec.model !== continued.model) {
      report(
        `${path}.thread`,
        "thread-continue",
        `a thread keeps one model: use ${target}'s model, or a new thread`,
      );
      return;
    }
    const mine = resolveModelUse(spec.model, definition.models);
    const theirs = resolveModelUse(continued.model, definition.models);
    if (
      Result.isSuccess(mine) &&
      Result.isSuccess(theirs) &&
      JSON.stringify([mine.success.provider, mine.success.model, mine.success.effort]) !==
        JSON.stringify([theirs.success.provider, theirs.success.model, theirs.success.effort])
    ) {
      report(
        `${path}.thread`,
        "thread-continue",
        `a thread keeps one model: use ${target}'s model, or a new thread`,
      );
    }
  }

  const checkBlockWorkspace = (
    workspace: { readonly project: string; readonly base: string },
    path: string,
    scope: Scope,
  ) => {
    checkTemplate(workspace.project, `${path}.project`, scope);
    checkTemplate(workspace.base, `${path}.base`, scope, "argv");
  };

  const checkNode = (id: string, node: WorkflowNode, path: string, scope: Scope) => {
    const ctx: UseContext = { node: id, scope, hillclimb: false };
    if (node.when !== undefined) checkExpr(node.when, `${path}.when`, scope);
    if (node.once !== undefined) checkTemplate(node.once.key, `${path}.once.key`, scope);
    checkTimeout(node.timeout, `${path}.timeout`);
    switch (node.kind) {
      case "agent":
        checkAgent(node, path, ctx, true);
        checkUses(node.uses, false, path);
        if (node.askBot === true && definition.bot === undefined)
          report(`${path}.askBot`, "bot", "askBot asks the workflow's bot: set bot at the top");
        return;
      case "command":
        checkCommand(node, path, ctx, []);
        checkUses(node.uses, node.heavy === true, path);
        return;
      case "gate": {
        checkTemplate(node.ask, `${path}.ask`, scope);
        const options = node.options ?? ["approve", "reject"];
        if (node.answerBy === "bot") {
          if (definition.bot === undefined)
            report(
              `${path}.answerBy`,
              "bot",
              "answerBy: bot asks the workflow's bot: set bot at the top",
            );
          if (options.includes(ESCALATE))
            report(
              `${path}.options`,
              "port",
              `"${ESCALATE}" is the bot's way to hand the gate to Israel`,
            );
        }
        if (node.expires !== undefined && !options.includes(node.expires.decision)) {
          report(
            `${path}.expires.decision`,
            "port",
            `"${node.expires.decision}" is not one of ${options.join(", ")}`,
          );
        }
        return;
      }
      case "branch":
        node.cases.forEach((c, index) => checkExpr(c.when, `${path}.cases[${index}].when`, scope));
        return;
      case "output":
        for (const [key, value] of Object.entries(node.value)) {
          checkTemplate(value, `${path}.value.${key}`, scope);
        }
        if (node.report !== undefined) checkTemplate(node.report, `${path}.report`, scope);
        if (node.handoff !== undefined) checkTemplate(node.handoff, `${path}.handoff`, scope);
        if (node.promote !== undefined)
          checkTemplate(node.promote.sha, `${path}.promote.sha`, scope);
        if (node.postToBot === true) {
          if (definition.bot === undefined)
            report(
              `${path}.postToBot`,
              "bot",
              "postToBot needs the workflow's bot: set bot at the top",
            );
          if (node.report === undefined)
            report(`${path}.postToBot`, "bot", "postToBot posts the report: add a report");
        }
        if (node.pullRequest !== undefined) {
          const pr = node.pullRequest;
          checkWorkspaceUse(pr.workspace, `${path}.pullRequest.workspace`, ctx);
          checkTemplate(pr.base, `${path}.pullRequest.base`, scope, "argv");
          checkTemplate(pr.title, `${path}.pullRequest.title`, scope);
          checkTemplate(pr.body, `${path}.pullRequest.body`, scope);
        }
        return;
      case "call":
        checkCall(node.workflow, `${path}.workflow`);
        for (const [key, value] of Object.entries(node.params)) {
          checkTemplate(value, `${path}.params.${key}`, scope);
        }
        checkInherit(node, path, ctx);
        return;
      case "map": {
        const itemsExpr = checkExpr(node.items, `${path}.items`, scope);
        if (node.as !== undefined && RESERVED_ROOTS.has(node.as)) {
          report(`${path}.as`, "schema", `"${node.as}" is a reserved name`);
        }
        const taint = itemsExpr === null ? null : exprTaint(itemsExpr, scope);
        const itemTaint = new Map(scope.itemTaint).set("item", taint);
        if (node.as !== undefined) itemTaint.set(node.as, taint);
        const bodyRoots = [...BODY_ROOTS, ...(node.as === undefined ? [] : [node.as])];
        const body = compiledBody(id, path);
        if (body !== null) checkLevel(body, { ...withRoots(scope, bodyRoots), itemTaint });
        const after: Scope = {
          ...withRoots(scope, bodyRoots),
          nodes: new Set([...scope.nodes, ...Object.keys(node.body.nodes)]),
          itemTaint,
        };
        for (const [key, value] of Object.entries(node.collect ?? {})) {
          checkTemplate(value, `${path}.collect.${key}`, after);
        }
        return;
      }
      case "loop": {
        const body = compiledBody(id, path);
        if (body !== null) checkLevel(body, withRoots(scope, ["iteration"]));
        checkExpr(node.until, `${path}.until`, {
          ...withRoots(scope, ["iteration"]),
          nodes: new Set([...scope.nodes, ...Object.keys(node.body.nodes)]),
        });
        return;
      }
      case "hillclimb": {
        checkBlockWorkspace(node.workspace, `${path}.workspace`, scope);
        const specCtx: UseContext = { ...ctx, hillclimb: true };
        checkAgent(node.generator, `${path}.generator`, specCtx);
        if (node.build !== undefined) {
          checkCommand(node.build, `${path}.build`, specCtx, []);
          if (node.build.artifact !== undefined)
            checkTemplate(node.build.artifact, `${path}.build.artifact`, scope, "argv");
        }
        for (const [name, spec] of Object.entries(node.measure)) {
          checkCommand(spec, `${path}.measure.${name}`, specCtx, HILLCLIMB_ROOTS);
        }
        const metricScope = withRoots(scope, HILLCLIMB_ROOTS);
        checkExpr(node.objective.expr, `${path}.objective.expr`, metricScope);
        checkExpr(node.keep, `${path}.keep`, metricScope);
        checkExpr(node.target, `${path}.target`, metricScope);
        if (node.confirmWhen !== undefined)
          checkExpr(node.confirmWhen, `${path}.confirmWhen`, metricScope);
        if (node.budget.tokens !== undefined)
          checkReservation(node.budget.tokens, `${path}.budget.tokens`);
        if (node.budget.wall !== undefined) checkTimeout(node.budget.wall, `${path}.budget.wall`);
        return;
      }
      case "arena": {
        checkBlockWorkspace(node.workspace, `${path}.workspace`, scope);
        checkTemplate(node.task, `${path}.task`, scope);
        checkTemplate(node.artifact, `${path}.artifact`, scope);
        node.runners.forEach((runner, index) => resolveModel(runner, `${path}.runners[${index}]`));
        const judge = resolveModel(node.judge, `${path}.judge`);
        const lead = resolveModel(node.lead, `${path}.lead`);
        if (judge !== null && lead !== null && modelFamily(judge) === modelFamily(lead)) {
          report(
            `${path}.judge`,
            "judge-family",
            `the judge must come from another family than the lead (both are ${modelFamily(lead)})`,
          );
        }
        if (node.minCandidates > node.runners.length) {
          report(`${path}.minCandidates`, "schema", `more than the ${node.runners.length} runners`);
        }
        if (node.verify !== undefined) checkCommand(node.verify, `${path}.verify`, ctx, []);
        return;
      }
      case "graph":
        checkBlockWorkspace(node.workspace, `${path}.workspace`, scope);
        checkTemplate(node.goal, `${path}.goal`, scope);
        resolveModel(node.lead, `${path}.lead`);
        resolveModel(node.leaf, `${path}.leaf`);
        node.finalChecks.forEach((spec, index) =>
          checkCommand(spec, `${path}.finalChecks[${index}]`, ctx, []),
        );
        return;
      case "interrogate":
        checkWorkspaceUse(node.target.workspace, `${path}.target.workspace`, ctx);
        checkTemplate(node.target.baseRef, `${path}.target.baseRef`, scope, "argv");
        checkTemplate(node.intent, `${path}.intent`, scope);
        node.reviewers.forEach((reviewer, index) =>
          resolveModel(reviewer, `${path}.reviewers[${index}]`),
        );
        resolveModel(node.lead, `${path}.lead`);
        node.checks.forEach((spec, index) =>
          checkCommand(spec, `${path}.checks[${index}]`, ctx, []),
        );
        return;
    }
  };

  /** Bodies compiled by buildLevel, keyed by their diagnostic path. */
  const bodies = new Map<string, CompiledGraph>();
  const indexBodies = (graph: CompiledGraph) => {
    for (const compiled of graph.nodes.values()) {
      if (compiled.body !== null) {
        bodies.set(`${graph.path}nodes.${compiled.id}`, compiled.body);
        indexBodies(compiled.body);
      }
    }
  };
  indexBodies(root);
  function compiledBody(_id: string, path: string): CompiledGraph | null {
    return bodies.get(path) ?? null;
  }

  function checkLevel(graph: CompiledGraph, outer: Scope) {
    for (const [id, compiled] of graph.nodes) {
      const upstream = graph.order.length > 0 ? ancestors(graph, id) : new Set<string>();
      checkNode(id, compiled.node, `${graph.path}nodes.${id}`, {
        ...outer,
        nodes: new Set([...outer.nodes, ...upstream]),
      });
    }
  }

  /**
   * A call's `workspaces` and `threads`: each parent name exists here (an agent node that ran
   * before the call, for a thread), and each child name is a shared workspace or a top-level agent
   * node of the callee that opens a new thread, in the workspace and with the access of the thread.
   */
  function checkInherit(
    node: Extract<WorkflowNode, { readonly kind: "call" }>,
    path: string,
    ctx: UseContext,
  ) {
    const callee = host.callTargets?.get(node.workflow)?.definition;
    const workspaces = node.workspaces ?? {};
    const handed = new Set<string>();
    for (const [child, parent] of Object.entries(workspaces)) {
      const at = `${path}.workspaces.${child}`;
      // A block's export would not see the child's commits; two names would report two heads.
      if (own(definition.workspaces, parent) === undefined)
        report(at, "unknown-node", `"${parent}" is not a declared workspace`);
      else checkWorkspaceName(parent, at, ctx);
      if (handed.has(parent))
        report(at, "schema", `${parent} is already handed to ${node.workflow} under another name`);
      handed.add(parent);
      if (callee === undefined) continue;
      const decl = own(callee.workspaces, child);
      if (decl === undefined)
        report(at, "unknown-node", `${node.workflow} declares no workspace ${child}`);
      else if (decl.perItem === true)
        report(
          at,
          "schema",
          `${child} is per item in ${node.workflow}: only a shared workspace is inherited`,
        );
    }
    for (const [child, parent] of Object.entries(node.threads ?? {})) {
      const at = `${path}.threads.${child}`;
      const source = nodeById.get(parent);
      if (source?.kind !== "agent" || !ctx.scope.nodes.has(parent)) {
        report(at, "thread-continue", `${parent} is not an agent node that ran before this call`);
        continue;
      }
      // A per-item worktree is the instance of the nearest map item: the thread must be that item's,
      // from the agent that opened it, through any `continue:` in between.
      const decl =
        typeof source.workspace === "string"
          ? own(definition.workspaces, source.workspace)
          : undefined;
      if (decl?.perItem === true && itemMapOf(ctx.node) !== itemMapOf(threadOrigin(parent)))
        report(
          at,
          "thread-continue",
          `${parent} runs in another map item than this call: its per-item worktree is not this item's`,
        );
      if (callee === undefined) continue;
      const target = own(callee.nodes, child);
      if (target?.kind !== "agent") {
        report(at, "thread-continue", `${node.workflow} has no top-level agent node ${child}`);
        continue;
      }
      if (target.thread !== undefined && target.thread !== "new")
        report(
          at,
          "thread-continue",
          `${child} in ${node.workflow} opens its own thread: give it thread: new`,
        );
      // A read-only agent's thread works in a disposable checkout, not in a worktree to share.
      if ((source.access ?? "read") !== "write")
        report(at, "thread-continue", `only a thread of an agent with access: write is inherited`);
      else if ((target.access ?? "read") !== "write")
        report(at, "thread-continue", `a thread keeps one access: give ${child} access: write`);
      const mapped =
        typeof target.workspace === "string" ? own(workspaces, target.workspace) : undefined;
      if (typeof source.workspace !== "string" || mapped !== source.workspace)
        report(
          at,
          "thread-continue",
          typeof source.workspace === "string" && typeof target.workspace === "string"
            ? `a thread keeps one workspace: add workspaces: { ${target.workspace}: ${source.workspace} }`
            : `a thread keeps one workspace: ${child} and ${parent} need named workspaces passed in workspaces`,
        );
    }
  }

  function checkCall(workflow: string, path: string) {
    if (host.callTargets !== undefined) {
      const target = host.callTargets.get(workflow);
      if (target === undefined) report(path, "trigger", `${workflow} has no call trigger`);
      else if (target.from !== null && !target.from.includes(definition.id))
        report(path, "trigger", `${workflow} is not callable from ${definition.id}`);
    }
    if (workflow === definition.id) {
      report(path, "call-cycle", "a workflow cannot call itself");
      return;
    }
    const callGraph = host.callGraph;
    if (callGraph === undefined) return;
    if (!callGraph.has(workflow)) {
      report(path, "unknown-node", `there is no workflow ${workflow}`);
      return;
    }
    const seen = new Set<string>();
    const stack = [workflow];
    for (let current = stack.pop(); current !== undefined; current = stack.pop()) {
      if (current === definition.id) {
        report(path, "call-cycle", `${workflow} calls back into ${definition.id}`);
        return;
      }
      if (seen.has(current)) continue;
      seen.add(current);
      stack.push(...(callGraph.get(current) ?? []));
    }
  }

  checkLevel(root, {
    nodes: new Set(),
    roots: new Set(BASE_ROOTS),
    itemTaint: new Map(),
  });

  // A workspace's templates render when its first user runs, so they may only read nodes upstream of every user.
  for (const [name, decl] of Object.entries(definition.workspaces ?? {})) {
    const users = workspaceUsers.get(name) ?? [];
    if (decl.base.startsWith("workspace:")) {
      const other = decl.base.slice("workspace:".length);
      if (other === name || own(definition.workspaces, other) === undefined) {
        report(
          `workspaces.${name}.base`,
          "unknown-node",
          `"${other}" is not another declared workspace`,
        );
      }
    }
    const agentBranch = decl.branchPolicy === "agent";
    if (agentBranch && decl.branch !== undefined)
      report(
        `workspaces.${name}.branch`,
        "schema",
        "with branchPolicy: agent the agent names its own branch; remove branch",
      );
    if (!agentBranch && decl.branch === undefined)
      report(`workspaces.${name}.branch`, "schema", "a workspace needs a wf/… branch");
    // A per-item worktree renders once per map item, so its templates may read that item.
    const perItem = decl.perItem === true;
    if (perItem) {
      const outside = users.find((u) => !u.scope.roots.has("item"));
      if (outside !== undefined)
        report(
          `workspaces.${name}.perItem`,
          "template-root",
          `${outside.node} is outside a map body, where there is no item to key the worktree by`,
        );
    }
    for (const [field, text, sink] of [
      ["project", decl.project, "text"],
      ["base", decl.base, "argv"],
      ["branch", decl.branch, "argv"],
    ] as const) {
      if (text === undefined) continue;
      const path = `workspaces.${name}.${field}`;
      if (field === "base" && text.startsWith("workspace:")) continue;
      const scopes =
        users.length > 0
          ? users.map((u) => ({
              ...u.scope,
              roots: new Set<string>([...BASE_ROOTS, ...(perItem ? ["item"] : [])]),
              itemTaint: perItem
                ? new Map([["item", u.scope.itemTaint.get("item") ?? null]])
                : new Map<string, string | null>(),
            }))
          : [emptyScope()];
      for (const scope of scopes) checkTemplate(text, path, scope, sink);
    }
  }

  // ── Triggers and card ───────────────────────────────────────────────────────────────────────

  const onDemandKinds = new Set<string>();
  const nodeIds = new Set<string>();
  function collectIds(nodes: WorkflowDefinition["nodes"]) {
    for (const [id, node] of Object.entries(nodes)) {
      nodeIds.add(id);
      if (node.kind === "map" || node.kind === "loop") collectIds(node.body.nodes);
    }
  }
  collectIds(definition.nodes);
  const triggerScope: Scope = {
    nodes: new Set(),
    roots: new Set(["trigger"]),
    itemTaint: new Map(),
  };
  Object.entries(definition.triggers ?? {}).forEach(([id, trigger]) => {
    const path = `triggers.${id}`;
    if (isOnDemandTrigger(trigger.kind)) {
      if (onDemandKinds.has(trigger.kind))
        report(path, "trigger", `a workflow has at most one ${trigger.kind} trigger`);
      onDemandKinds.add(trigger.kind);
    }
    if (nodeIds.has(id)) report(path, "trigger", `trigger id "${id}" is also a node id`);
    if (trigger.kind === "bot" && !trigger.description.trim())
      report(
        `${path}.description`,
        "trigger",
        "the bot trigger needs a description of when to run it",
      );
    if (!WORKFLOW_NODE_ID_PATTERN.test(id))
      report(path, "schema", `trigger id "${id}" must match ${WORKFLOW_NODE_ID_PATTERN}`);
    for (const [key, value] of Object.entries(
      ("params" in trigger ? trigger.params : undefined) ?? {},
    )) {
      if (own(definition.params, key) === undefined) {
        report(`${path}.params.${key}`, "trigger", `${key} is not a declared param`);
      }
      checkTemplate(value, `${path}.params.${key}`, triggerScope);
    }
    switch (trigger.kind) {
      case "cron": {
        const parsed = Cron.parse(trigger.expr, trigger.tz);
        if (Result.isFailure(parsed)) report(`${path}.expr`, "trigger", parsed.failure.message);
        if (trigger.misfire !== undefined && parseDurationMs(trigger.misfire.grace) > 86_400_000) {
          report(`${path}.misfire.grace`, "trigger", "the grace is at most 24h");
        }
        return;
      }
      case "webhook":
        if (trigger.replayKey !== undefined && !isWebhookDedupeTemplate(trigger.replayKey)) {
          report(
            `${path}.replayKey`,
            "trigger",
            "replayKey is made only of {{body…}}, {{headers…}}, {{query…}} or {{request}}",
          );
        }
        return;
      case "upstreamTag":
        if (safeTest(trigger.pattern, "") === null) {
          report(
            `${path}.pattern`,
            "trigger",
            `"${trigger.pattern}" is not a valid regular expression`,
          );
        }
        if (!/^https:\/\/\S+$/.test(trigger.remote)) {
          report(`${path}.remote`, "trigger", "the remote is an https URL");
        }
        return;
      case "workflowFailed":
        if (trigger.workflow === definition.id) {
          report(`${path}.workflow`, "trigger", "a workflow cannot start on its own failure");
        }
        return;
      case "manual":
      case "bot":
      case "call":
      case "prMerged":
      case "threadSettled":
        return;
    }
  });

  if (definition.card !== undefined && host.linearLinkedProjects?.has(definition.card.project)) {
    report(
      "card.project",
      "card-linear",
      `${definition.card.project} is linked to Linear; a run card there would change Linear. Use a local board`,
    );
  }

  if (diagnostics.length > 0) return Result.fail(diagnostics);
  return Result.succeed({ definition, hash: semanticHash(definition), root, models });
};

type WorkflowNodeAccept = Extract<WorkflowNode, { readonly kind: "agent" }>["accept"];

const emptyScope = (): Scope => ({
  nodes: new Set(),
  roots: new Set(BASE_ROOTS),
  itemTaint: new Map(),
});

const aliasMessage = (model: string) =>
  `"${model}" is a family alias; name the exact model id (claude-opus-5-5, gpt-6.1-sol, …)`;

/** The untrusted part of an agent's output: fields without a pattern, unless numbers or booleans. */
const agentOutputTaint = (
  id: string,
  shape: WorkflowOutputShape | undefined,
  field: string | number | undefined,
): string | null => {
  if (shape === undefined) return `the output of agent ${id}`;
  const fields =
    typeof field === "string" ? [[field, own(shape, field)] as const] : Object.entries(shape);
  for (const [name, spec] of fields) {
    const trusted =
      spec !== undefined &&
      (spec.pattern !== undefined ||
        spec.type === "number" ||
        spec.type === "boolean" ||
        spec.type === "number[]");
    if (!trusted) return `nodes.${id}.output.${String(name)} (no pattern)`;
  }
  return null;
};

const canonicalUse = (use: WorkflowWorkspaceUse): string =>
  typeof use === "string" ? use : `${use.project}\u0000readOnly`;

/** A record member by own key only, so `params.constructor` is not a declared param. */
const own = <V>(record: { readonly [key: string]: V } | undefined, key: string): V | undefined =>
  record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;

/** null when the pattern does not compile. */
const safeTest = (pattern: string, value: string): boolean | null => {
  try {
    return new RegExp(pattern).test(value);
  } catch {
    return null;
  }
};

const normalizeEdges = (definition: WorkflowDefinition): WorkflowDefinition => {
  const respace = (edges: ReadonlyArray<string>) =>
    edges.map((edge) => {
      const parsed = parseEdge(edge);
      return Result.isSuccess(parsed) ? formatEdge(parsed.success) : edge;
    });
  const respaceNodes = (nodes: {
    readonly [id: string]: WorkflowNode;
  }): { readonly [id: string]: WorkflowNode } =>
    Object.fromEntries(
      Object.entries(nodes).map(([id, node]) => [
        id,
        node.kind === "map" || node.kind === "loop"
          ? {
              ...node,
              body: { nodes: respaceNodes(node.body.nodes), edges: respace(node.body.edges) },
            }
          : node,
      ]),
    );
  return { ...definition, nodes: respaceNodes(definition.nodes), edges: respace(definition.edges) };
};
