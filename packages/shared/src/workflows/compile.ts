/** The workflow compiler: decode, every static check of the design (§1.3), then the semantic hash. */
import * as Cron from "effect/Cron";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

import {
  isWebhookDedupeTemplate,
  WORKFLOW_NODE_ID_PATTERN,
  WorkflowDefinition,
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
import { isModelAlias, modelFamily, resolveModelUse } from "./models.ts";
import { matchesWhole } from "./output.ts";
import { parseTemplate } from "./template.ts";
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
const NODE_FIELDS = new Set(["output", "status", "port", "thread"]);
const WORKSPACE_FIELDS = new Set(["branch", "head", "path"]);
const RUN_FIELDS = new Set(["id", "dir"]);
const STEP_FIELDS = new Set(["dir"]);
/** The worktree each block exports to the nodes after it, as `<node>.<name>`. */
const BLOCK_EXPORTS: Partial<Record<WorkflowNode["kind"], string>> = {
  hillclimb: "best",
  arena: "graft",
  graph: "integration",
};
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
  const collectNodes = (nodes: { readonly [id: string]: WorkflowNode }, prefix: string) => {
    for (const [id, node] of Object.entries(nodes)) {
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
        collectNodes(node.body.nodes, `${path}.body.`);
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
  const resolveModel = (use: WorkflowModelUse, path: string): WorkflowModelRef | null => {
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
        return spec?.type === "string" && spec.pattern === undefined
          ? `param ${String(first)} has no pattern`
          : null;
      }
      case "nodes": {
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
            report(path, "template-root", `nodes.${first} has output, status, port and thread`);
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
      readonly thread?: string | undefined;
      readonly access?: "read" | "write" | undefined;
      readonly output?: WorkflowOutputShape | undefined;
      readonly accept?: WorkflowNodeAccept | undefined;
      readonly tokenReservation?: number | undefined;
      readonly timeout?: string | undefined;
    },
    path: string,
    ctx: UseContext,
  ) => {
    resolveModel(spec.model, `${path}.model`);
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
      checkExpr(accept.check, `${path}.accept.check`, withRoots(ctx.scope, CHECK_ROOTS));
    } else {
      resolveModel(accept.judge, `${path}.accept.judge`);
      checkTemplate(accept.criterion, `${path}.accept.criterion`, ctx.scope);
    }
  };

  function checkThread(
    spec: {
      readonly thread?: string | undefined;
      readonly model: WorkflowModelUse;
      readonly workspace: WorkflowWorkspaceUse;
      readonly access?: "read" | "write" | undefined;
    },
    path: string,
    ctx: UseContext,
  ) {
    if (spec.thread === undefined || spec.thread === "new") return;
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
        checkAgent(node, path, ctx);
        return;
      case "command":
        checkCommand(node, path, ctx, []);
        return;
      case "gate": {
        checkTemplate(node.ask, `${path}.ask`, scope);
        const options = node.options ?? ["approve", "reject"];
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

  function checkCall(workflow: string, path: string) {
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
    for (const [field, text, sink] of [
      ["project", decl.project, "text"],
      ["base", decl.base, "argv"],
      ["branch", decl.branch, "argv"],
    ] as const) {
      const path = `workspaces.${name}.${field}`;
      if (field === "base" && text.startsWith("workspace:")) continue;
      const scopes =
        users.length > 0
          ? users.map((u) => ({
              ...u.scope,
              roots: new Set<string>(BASE_ROOTS),
              itemTaint: new Map(),
            }))
          : [emptyScope()];
      for (const scope of scopes) checkTemplate(text, path, scope, sink);
    }
  }

  // ── Triggers and card ───────────────────────────────────────────────────────────────────────

  const triggerScope: Scope = {
    nodes: new Set(),
    roots: new Set(["trigger"]),
    itemTaint: new Map(),
  };
  const triggerIds = new Set<string>();
  (definition.triggers ?? []).forEach((trigger, index) => {
    const path = `triggers[${index}]`;
    if (triggerIds.has(trigger.id))
      report(`${path}.id`, "trigger", `trigger id "${trigger.id}" is used twice`);
    triggerIds.add(trigger.id);
    for (const [key, value] of Object.entries(trigger.params ?? {})) {
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
