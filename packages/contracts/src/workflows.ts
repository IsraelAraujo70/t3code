/**
 * Workflows (friend fork): the decoded `<id>.workflow.yaml`, its diagnostics and the run views.
 * Definition ids are plain pattern-checked strings (Type equals Encoded, so the recursive bodies fit
 * `Schema.suspend`). Record keys stay plain strings: a refined key schema silently drops failing keys.
 */
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  MAX_WEBHOOK_FILTERS,
  ScheduledTaskWebhookFilter,
  ScheduledTaskWebhookSignature,
} from "./scheduledTask.ts";

// ── Identities ────────────────────────────────────────────────────────────────────────────────

const WORKFLOW_ID_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
export const WORKFLOW_NODE_ID_PATTERN = /^[a-z][a-z0-9_]{0,40}$/;
export const WORKFLOW_LEDGER_ID_PATTERN = /^[a-z][a-z0-9\-/]{0,80}$/;

/** A workflow id inside a definition (file name, `call.workflow`, `workflowFailed.workflow`). */
export const WorkflowKey = Schema.String.check(Schema.isPattern(WORKFLOW_ID_PATTERN));
/** A node, trigger, port or map variable name inside a definition. */
export const WorkflowNodeKey = Schema.String.check(Schema.isPattern(WORKFLOW_NODE_ID_PATTERN));
export const WorkflowLedgerKey = Schema.String.check(Schema.isPattern(WORKFLOW_LEDGER_ID_PATTERN));

export const WorkflowId = WorkflowKey.pipe(Schema.brand("WorkflowId"));
export type WorkflowId = typeof WorkflowId.Type;
export const WorkflowNodeId = WorkflowNodeKey.pipe(Schema.brand("WorkflowNodeId"));
export type WorkflowNodeId = typeof WorkflowNodeId.Type;
export const WorkflowRunId = Schema.String.check(Schema.isPattern(/^wfr_[a-f0-9]{20}$/)).pipe(
  Schema.brand("WorkflowRunId"),
);
export type WorkflowRunId = typeof WorkflowRunId.Type;
/** sha256 of the canonical JSON of the definition without `canvas`: what decides if a run changes. */
export const WorkflowHash = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)).pipe(
  Schema.brand("WorkflowHash"),
);
export type WorkflowHash = typeof WorkflowHash.Type;
/** Git blob sha of the whole file on disk, layout included: the precondition of every save. */
export const WorkflowDocRevision = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40,64}$/)).pipe(
  Schema.brand("WorkflowDocRevision"),
);
export type WorkflowDocRevision = typeof WorkflowDocRevision.Type;
/** Path of one step instance: `merge`, `each[2]/design`, `climb/r4/generate`. Part of every idempotency key. */
export const WorkflowStepKey = Schema.String.check(Schema.isPattern(/^[a-z0-9_[\]/]{1,200}$/)).pipe(
  Schema.brand("WorkflowStepKey"),
);
export type WorkflowStepKey = typeof WorkflowStepKey.Type;
/** The engine only creates or moves `wf/…` branches; `friend/main` does not decode. */
export const WfBranch = Schema.String.check(Schema.isPattern(/^wf\/[A-Za-z0-9._/-]{1,120}$/)).pipe(
  Schema.brand("WfBranch"),
);
export type WfBranch = typeof WfBranch.Type;
export const WorkflowLedgerId = WorkflowLedgerKey.pipe(Schema.brand("WorkflowLedgerId"));
export type WorkflowLedgerId = typeof WorkflowLedgerId.Type;

const WORKFLOW_DURATION_PATTERN = /^\d+(s|m|h)$/;
export const WorkflowDuration = Schema.String.check(Schema.isPattern(WORKFLOW_DURATION_PATTERN));
/** Text with `{{ expr }}` holes, compiled to an AST and never `eval`ed. */
export const WorkflowTemplate = Schema.String.check(Schema.isMaxLength(40_000));
export const WorkflowExpr = Schema.String.check(Schema.isMaxLength(2_000));
/** `"a -> b"` or `"a:port -> b"`. */
export const WorkflowEdge = Schema.String.check(Schema.isMaxLength(200));

// ── Definition ────────────────────────────────────────────────────────────────────────────────

const WORKFLOW_PROVIDERS = ["codex", "claude"] as const;
const WORKFLOW_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

/** Provider and model, never a provider instance: the bots host resolves the instance it runs bots on. */
export const WorkflowModelRef = Schema.Struct({
  provider: Schema.Literals(WORKFLOW_PROVIDERS),
  /** Exact id: gpt-6.1-sol, claude-opus-5-5, claude-haiku-5-5. Aliases are refused. */
  model: TrimmedNonEmptyString,
  effort: Schema.optional(Schema.Literals(WORKFLOW_EFFORTS)),
});
export type WorkflowModelRef = typeof WorkflowModelRef.Type;
/** A model, or `$name` for `models.name`. */
export const WorkflowModelUse = Schema.Union([
  WorkflowModelRef,
  Schema.String.check(Schema.isPattern(/^\$[a-z_]+$/)),
]);
export type WorkflowModelUse = typeof WorkflowModelUse.Type;

const WORKFLOW_FIELD_TYPES = [
  "string",
  "number",
  "boolean",
  "string[]",
  "number[]",
  "json",
] as const;
export const WorkflowFieldSpec = Schema.Struct({
  type: Schema.Literals(WORKFLOW_FIELD_TYPES),
  /** A field with a pattern is trusted in argv, env and branch names. */
  pattern: Schema.optional(Schema.String),
  optional: Schema.optional(Schema.Boolean),
});
export type WorkflowFieldSpec = typeof WorkflowFieldSpec.Type;
/** Structured output: an agent ends with a ```json block; a command prints JSON. */
export const WorkflowOutputShape = Schema.Record(Schema.String, WorkflowFieldSpec);
export type WorkflowOutputShape = typeof WorkflowOutputShape.Type;

export const WorkflowParamSpec = Schema.Struct({
  type: Schema.Literals(["string", "number", "boolean"]),
  default: Schema.optional(Schema.Union([Schema.String, Schema.Number, Schema.Boolean])),
  /** A string param is trusted in argv, env and branch names only with a pattern. */
  pattern: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
});
export type WorkflowParamSpec = typeof WorkflowParamSpec.Type;

/**
 * A git worktree the engine creates on the host (the only way to get one); the branch renders to
 * `wf/…`. What stays after the run follows `retain` (default `on_failure`).
 */
export const WorkflowWorkspaceDecl = Schema.Struct({
  project: WorkflowTemplate,
  /** A ref, or `workspace:<name>` to start from another workspace's HEAD. */
  base: WorkflowTemplate,
  branch: WorkflowTemplate,
  retain: Schema.optional(Schema.Literals(["always", "on_failure", "never"])),
});
export type WorkflowWorkspaceDecl = typeof WorkflowWorkspaceDecl.Type;
export const WorkflowWorkspaceUse = Schema.Union([
  /** A name in `workspaces`, a block export (`climb.best`, `build.integration`), or `attempt` inside a hillclimb. */
  Schema.String,
  /** A detached, disposable worktree at the project's sha pinned when the run started. */
  Schema.Struct({ project: WorkflowTemplate, readOnly: Schema.Literal(true) }),
]);
export type WorkflowWorkspaceUse = typeof WorkflowWorkspaceUse.Type;

/**
 * Acceptance check of an agent step, run by the engine, never by the agent: a command on the
 * step's worktree, or a judge turn (new thread, read-only) answering `{ pass: boolean, reason: string }`.
 */
export const WorkflowAcceptSpec = Schema.Union([
  Schema.Struct({
    argv: Schema.NonEmptyArray(WorkflowTemplate),
    check: WorkflowExpr,
    heavy: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({ judge: WorkflowModelUse, criterion: WorkflowTemplate }),
]);
export type WorkflowAcceptSpec = typeof WorkflowAcceptSpec.Type;

export const WorkflowRetryPolicy = Schema.Struct({
  max: NonNegativeInt,
  on: Schema.Array(Schema.Literals(["failed", "lost", "timed_out"])),
  backoff: Schema.optional(WorkflowDuration),
});
export type WorkflowRetryPolicy = typeof WorkflowRetryPolicy.Type;
/** Dedupe across runs: the step is skipped when `key` is already in the ledger. */
export const WorkflowOnceSpec = Schema.Struct({ ledger: WorkflowLedgerKey, key: WorkflowTemplate });
export type WorkflowOnceSpec = typeof WorkflowOnceSpec.Type;

/** Fields every step has, graph or block child. */
const StepFields = {
  title: Schema.optional(Schema.String),
  timeout: Schema.optional(WorkflowDuration),
  retry: Schema.optional(WorkflowRetryPolicy),
};
/** Fields only a graph node has. */
const GraphFields = {
  /** Fan-in; default `all`. */
  join: Schema.optional(Schema.Literals(["all", "any"])),
  /** Guard; false → skipped. */
  when: Schema.optional(WorkflowExpr),
  once: Schema.optional(WorkflowOnceSpec),
  continueOnFail: Schema.optional(Schema.Boolean),
};

const AgentFields = {
  model: WorkflowModelUse,
  prompt: WorkflowTemplate,
  workspace: WorkflowWorkspaceUse,
  /**
   * `new` (default) or `continue:<nodeId>`. A thread keeps one access and one worktree for life,
   * so the compiler accepts a continuation only with the continued node's workspace and access.
   */
  thread: Schema.optional(Schema.String),
  /** `read` = disposable worktree; default `read`. */
  access: Schema.optional(Schema.Literals(["read", "write"])),
  output: Schema.optional(WorkflowOutputShape),
  /** pass/fail ports; the evidence is what the engine ran. */
  accept: Schema.optional(WorkflowAcceptSpec),
  tokenReservation: Schema.optional(PositiveInt),
  /** A question from the agent becomes a gate; otherwise it is declined with an instruction. */
  askIsrael: Schema.optional(Schema.Boolean),
};

const CommandFields = {
  /** No shell. */
  argv: Schema.NonEmptyArray(WorkflowTemplate),
  cwd: WorkflowWorkspaceUse,
  /** Wrapped in heavy.sh. */
  heavy: Schema.optional(Schema.Boolean),
  /** The command calls heavy.sh by itself (the bench's run.py). */
  selfSerializing: Schema.optional(Schema.Boolean),
  /** Default `never`: a lost command with a start receipt becomes `ambiguous`. */
  replay: Schema.optional(Schema.Literals(["safe", "never"])),
  parse: Schema.optional(Schema.Literals(["none", "json", "json-last-line"])),
  output: Schema.optional(WorkflowOutputShape),
  /** Turns the ports into pass/fail by a predicate over `{ exit, out }`. */
  check: Schema.optional(WorkflowExpr),
  /** JSON path in `out` charged to the budget (paid evals). Requires `tokenReservation`. */
  tokensFrom: Schema.optional(Schema.String),
  /** Passed as WF_TOKEN_BUDGET. */
  tokenReservation: Schema.optional(PositiveInt),
  /** Allowed names only. */
  env: Schema.optional(Schema.Record(Schema.String, WorkflowTemplate)),
};

export const WorkflowAgentNode = Schema.Struct({
  kind: Schema.Literal("agent"),
  ...StepFields,
  ...GraphFields,
  ...AgentFields,
});
export type WorkflowAgentNode = typeof WorkflowAgentNode.Type;

export const WorkflowCommandNode = Schema.Struct({
  kind: Schema.Literal("command"),
  ...StepFields,
  ...GraphFields,
  ...CommandFields,
});
export type WorkflowCommandNode = typeof WorkflowCommandNode.Type;

export const WorkflowGateNode = Schema.Struct({
  kind: Schema.Literal("gate"),
  ...StepFields,
  ...GraphFields,
  ask: WorkflowTemplate,
  /** Default `["approve", "reject"]`; each option is a port. */
  options: Schema.optional(Schema.Array(WorkflowNodeKey)),
  expires: Schema.optional(Schema.Struct({ after: WorkflowDuration, decision: WorkflowNodeKey })),
});
export type WorkflowGateNode = typeof WorkflowGateNode.Type;

export const WorkflowBranchNode = Schema.Struct({
  kind: Schema.Literal("branch"),
  ...StepFields,
  ...GraphFields,
  /** The first case that matches wins. */
  cases: Schema.Array(Schema.Struct({ port: WorkflowNodeKey, when: WorkflowExpr })),
  else: Schema.optional(WorkflowNodeKey),
});
export type WorkflowBranchNode = typeof WorkflowBranchNode.Type;

const WORKFLOW_OUTPUT_STATUSES = [
  "no_change",
  "ready_for_review",
  "no_gain",
  "rejected",
  "checks_failed",
  "blocked",
  "proposals",
] as const;

/**
 * An honest end: the status says what happened. `pullRequest` is the only publication there is.
 * At the top level it ends the run; inside a `map` or `loop` body it ends that body instance,
 * its value becomes the item's result and its pull request, if any, is opened.
 */
export const WorkflowOutputNode = Schema.Struct({
  kind: Schema.Literal("output"),
  ...StepFields,
  ...GraphFields,
  status: Schema.Literals(WORKFLOW_OUTPUT_STATUSES),
  value: Schema.Record(Schema.String, WorkflowTemplate),
  /** Markdown shown on the run and in the push. */
  report: Schema.optional(WorkflowTemplate),
  /** The engine pushes the WfBranch (no force) and opens a draft pull request. */
  pullRequest: Schema.optional(
    Schema.Struct({
      workspace: Schema.String,
      base: WorkflowTemplate,
      title: WorkflowTemplate,
      body: WorkflowTemplate,
    }),
  ),
  /** The command Israel runs (merge, deploy, restart). */
  handoff: Schema.optional(WorkflowTemplate),
  /** Marks the ledger entry of that sha as validated. */
  promote: Schema.optional(Schema.Struct({ ledger: WorkflowLedgerKey, sha: WorkflowTemplate })),
  notify: Schema.optional(Schema.Boolean),
  /**
   * Posts the rendered `report` to the current main thread of the workflow's `bot`, once per run.
   * Top level only; an empty report posts nothing. The post wakes the bot, and replaces the
   * finished push.
   */
  postToBot: Schema.optional(Schema.Boolean),
});
export type WorkflowOutputNode = typeof WorkflowOutputNode.Type;

export const WorkflowCallNode = Schema.Struct({
  kind: Schema.Literal("call"),
  ...StepFields,
  ...GraphFields,
  /** Pinned to the version hash when the parent run starts. */
  workflow: WorkflowKey,
  params: Schema.Record(Schema.String, WorkflowTemplate),
});
export type WorkflowCallNode = typeof WorkflowCallNode.Type;

/** A block child: the step fields of an agent or a command, without the graph fields. */
export const WorkflowAgentSpec = Schema.Struct({ ...StepFields, ...AgentFields });
export type WorkflowAgentSpec = typeof WorkflowAgentSpec.Type;
export const WorkflowCommandSpec = Schema.Struct({ ...StepFields, ...CommandFields });
export type WorkflowCommandSpec = typeof WorkflowCommandSpec.Type;

const BlockBudget = Schema.Struct({
  iterations: Schema.optional(PositiveInt),
  wall: Schema.optional(WorkflowDuration),
  tokens: Schema.optional(PositiveInt),
});
const BlockWorkspace = Schema.Struct({ project: WorkflowTemplate, base: WorkflowTemplate });

export const WorkflowHillclimbNode = Schema.Struct({
  kind: Schema.Literal("hillclimb"),
  ...StepFields,
  ...GraphFields,
  /** Branches: wf/<run>/<node>/…; the best worktree is exported as `<node>.best`. */
  workspace: BlockWorkspace,
  /** Survives across runs: no attempt repeats. */
  ledger: WorkflowLedgerKey,
  /** Turn 1 proposes `{ key, mechanism, rationale }`; turn 2 implements and commits. */
  generator: WorkflowAgentSpec,
  /** Without `artifact` the build only prepares the worktree (`vp i`) and nothing is copied. */
  build: Schema.optional(
    Schema.Struct({
      ...StepFields,
      ...CommandFields,
      artifact: Schema.optional(WorkflowTemplate),
    }),
  ),
  /** Each prints JSON with numbers; read as `m.<name>`. */
  measure: Schema.Record(Schema.String, WorkflowCommandSpec),
  objective: Schema.Struct({ expr: WorkflowExpr, direction: Schema.Literals(["max", "min"]) }),
  /** Accepts the candidate over the current best. */
  keep: WorkflowExpr,
  /** Pre-registered bar, evaluated only on a confirmation measurement against the origin. */
  target: WorkflowExpr,
  confirmWhen: Schema.optional(WorkflowExpr),
  plateau: Schema.Struct({ rounds: PositiveInt }),
  budget: BlockBudget,
});
export type WorkflowHillclimbNode = typeof WorkflowHillclimbNode.Type;

export const WorkflowArenaNode = Schema.Struct({
  kind: Schema.Literal("arena"),
  ...StepFields,
  ...GraphFields,
  task: WorkflowTemplate,
  artifact: WorkflowTemplate,
  /** N = length. */
  runners: Schema.NonEmptyArray(WorkflowModelUse),
  minCandidates: PositiveInt,
  /** The compiler refuses a judge of the lead's family. */
  judge: WorkflowModelUse,
  /** 3 to 6 criteria; only the judge sees them. */
  rubric: Schema.NonEmptyArray(Schema.String),
  lead: WorkflowModelUse,
  verify: Schema.optional(WorkflowCommandSpec),
  maxReruns: NonNegativeInt,
  /** The grafted worktree is exported as `<node>.graft`. */
  workspace: BlockWorkspace,
});
export type WorkflowArenaNode = typeof WorkflowArenaNode.Type;

export const WorkflowGraphNode = Schema.Struct({
  kind: Schema.Literal("graph"),
  ...StepFields,
  ...GraphFields,
  goal: WorkflowTemplate,
  lead: WorkflowModelUse,
  leaf: WorkflowModelUse,
  /** The integration worktree is exported as `<node>.integration`. */
  workspace: BlockWorkspace,
  finalChecks: Schema.Array(WorkflowCommandSpec),
  reworkCap: PositiveInt,
  maxLeaves: PositiveInt,
  maxParallel: PositiveInt,
});
export type WorkflowGraphNode = typeof WorkflowGraphNode.Type;

export const WorkflowInterrogateNode = Schema.Struct({
  kind: Schema.Literal("interrogate"),
  ...StepFields,
  ...GraphFields,
  target: Schema.Struct({ workspace: Schema.String, baseRef: WorkflowTemplate }),
  intent: WorkflowTemplate,
  mode: Schema.Literals(["loop", "panel"]),
  /** loop: [sol@high]; panel: [sol@high, opus]. */
  reviewers: Schema.NonEmptyArray(WorkflowModelUse),
  lead: WorkflowModelUse,
  checks: Schema.Array(WorkflowCommandSpec),
  /** 3; 5 only when declared. */
  rounds: PositiveInt,
});
export type WorkflowInterrogateNode = typeof WorkflowInterrogateNode.Type;

/** Nodes and edges of one level: the top of a definition, or a `map`/`loop` body. */
export interface WorkflowGraph {
  readonly nodes: { readonly [id: string]: WorkflowNode };
  /** `"a -> b"`, `"check:fail -> fix"`, `"route:conflicts -> repair"`. */
  readonly edges: ReadonlyArray<string>;
}
export const WorkflowGraph: Schema.Codec<WorkflowGraph> = Schema.Struct({
  nodes: Schema.Record(
    Schema.String,
    Schema.suspend((): Schema.Codec<WorkflowNode> => WorkflowNode),
  ),
  edges: Schema.Array(WorkflowEdge),
});

export const WorkflowMapNode = Schema.Struct({
  kind: Schema.Literal("map"),
  ...StepFields,
  ...GraphFields,
  items: WorkflowExpr,
  /** Optional extra name for `item`, so a nested body can still reach an outer item. */
  as: Schema.optional(WorkflowNodeKey),
  maxItems: PositiveInt,
  concurrency: PositiveInt,
  body: WorkflowGraph,
  collect: Schema.optional(Schema.Record(Schema.String, WorkflowTemplate)),
});
export type WorkflowMapNode = typeof WorkflowMapNode.Type;

export const WorkflowLoopNode = Schema.Struct({
  kind: Schema.Literal("loop"),
  ...StepFields,
  ...GraphFields,
  body: WorkflowGraph,
  until: WorkflowExpr,
  max: PositiveInt,
});
export type WorkflowLoopNode = typeof WorkflowLoopNode.Type;

export const WorkflowNode = Schema.Union([
  WorkflowAgentNode,
  WorkflowCommandNode,
  WorkflowGateNode,
  WorkflowBranchNode,
  WorkflowOutputNode,
  WorkflowCallNode,
  WorkflowMapNode,
  WorkflowLoopNode,
  WorkflowHillclimbNode,
  WorkflowArenaNode,
  WorkflowGraphNode,
  WorkflowInterrogateNode,
]);
export type WorkflowNode = typeof WorkflowNode.Type;
export type WorkflowNodeKind = WorkflowNode["kind"];
const WORKFLOW_BLOCK_KINDS = ["hillclimb", "arena", "graph", "interrogate"] as const;
export type WorkflowBlockKind = (typeof WORKFLOW_BLOCK_KINDS)[number];

/** The canvas node's text; the trigger id when absent. */
const TriggerTitle = { title: Schema.optional(Schema.String) };
/** Event triggers map their payload to the workflow params: param name → template over `trigger`. */
const TriggerCommon = {
  ...TriggerTitle,
  params: Schema.optional(Schema.Record(Schema.String, WorkflowTemplate)),
};
// Same pattern as `BotId` in bots.ts, which this module cannot import (bots.ts imports the RPCs).
const TriggerBotId = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,64}$/));

/**
 * A run asked for by the owner in a client (Run now). Its form is the workflow's `params`. Owner
 * runs ignore the workflow's and the trigger's switches; a suspension still blocks them.
 */
export const WorkflowManualTrigger = Schema.Struct({
  kind: Schema.Literal("manual"),
  ...TriggerTitle,
});
/**
 * The workflow as a tool for bots: `workflow_list` shows `description` and the params, and
 * `workflow_run` refuses a workflow without this trigger or a bot `bots` does not list.
 */
export const WorkflowBotTrigger = Schema.Struct({
  kind: Schema.Literal("bot"),
  ...TriggerTitle,
  /** When a bot should run it, written for the bot. */
  description: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1_000)),
  /** Bot ids allowed to run it; every bot when absent. */
  bots: Schema.optional(Schema.Array(TriggerBotId).check(Schema.isMaxLength(32))),
});
/** Lets `call` nodes start this workflow; a call to a workflow without it does not compile. */
export const WorkflowCallTrigger = Schema.Struct({
  kind: Schema.Literal("call"),
  ...TriggerTitle,
  /** Workflow ids allowed to call it; every workflow when absent. */
  from: Schema.optional(Schema.Array(WorkflowKey)),
});

export const WorkflowTrigger = Schema.Union([
  WorkflowManualTrigger,
  WorkflowBotTrigger,
  WorkflowCallTrigger,
  Schema.Struct({
    ...TriggerCommon,
    kind: Schema.Literal("cron"),
    expr: Schema.String,
    tz: Schema.String,
    misfire: Schema.optional(
      Schema.Struct({ mode: Schema.Literals(["latest", "skip"]), grace: WorkflowDuration }),
    ),
  }),
  Schema.Struct({
    ...TriggerCommon,
    kind: Schema.Literal("webhook"),
    signature: Schema.optional(ScheduledTaskWebhookSignature),
    filters: Schema.optional(
      Schema.Array(ScheduledTaskWebhookFilter).check(Schema.isMaxLength(MAX_WEBHOOK_FILTERS)),
    ),
    replayKey: Schema.optional(Schema.String),
    template: Schema.optional(WorkflowTemplate),
  }),
  Schema.Struct({
    ...TriggerCommon,
    kind: Schema.Literal("upstreamTag"),
    remote: Schema.String,
    pattern: Schema.String,
    pollMinutes: PositiveInt,
  }),
  Schema.Struct({
    ...TriggerCommon,
    kind: Schema.Literal("prMerged"),
    scope: Schema.Literals(["linked", "repo"]),
    repo: Schema.String,
    base: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    ...TriggerCommon,
    kind: Schema.Literal("threadSettled"),
    projectId: Schema.optional(TrimmedNonEmptyString),
    botId: Schema.optional(Schema.String),
    titlePrefix: Schema.optional(Schema.String),
  }),
  Schema.Struct({
    ...TriggerCommon,
    kind: Schema.Literal("workflowFailed"),
    workflow: Schema.optional(WorkflowKey),
  }),
]);
export type WorkflowTrigger = typeof WorkflowTrigger.Type;
export type WorkflowTriggerKind = WorkflowTrigger["kind"];
/** Started by a caller who passes the params; at most one of each per workflow. */
export const WORKFLOW_ON_DEMAND_TRIGGER_KINDS = ["manual", "bot", "call"] as const;

export const WorkflowRunBudget = Schema.Struct({
  steps: PositiveInt,
  wall: WorkflowDuration,
  tokens: PositiveInt,
  /** An estimate; holds only when every step has a known price. */
  usd: Schema.optional(Schema.Number),
});
export type WorkflowRunBudget = typeof WorkflowRunBudget.Type;

/** Outside the semantic hash: moving a box does not change the version that runs. */
export const WorkflowCanvasLayout = Schema.Struct({
  positions: Schema.Record(
    Schema.String,
    Schema.Struct({
      x: Schema.Number,
      y: Schema.Number,
      w: Schema.optional(Schema.Number),
      h: Schema.optional(Schema.Number),
    }),
  ),
  annotations: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      kind: Schema.Literals(["note", "frame"]),
      text: Schema.String,
      x: Schema.Number,
      y: Schema.Number,
      w: Schema.Number,
      h: Schema.Number,
      attachedTo: Schema.optional(Schema.String),
    }),
  ),
  viewport: Schema.optional(
    Schema.Struct({ x: Schema.Number, y: Schema.Number, zoom: Schema.Number }),
  ),
});
export type WorkflowCanvasLayout = typeof WorkflowCanvasLayout.Type;

const WORKFLOW_SCHEMA_VERSION = "t3.workflow/v1";

export const WorkflowDefinition = Schema.Struct({
  schema: Schema.Literal(WORKFLOW_SCHEMA_VERSION),
  id: WorkflowKey,
  title: TrimmedNonEmptyString,
  description: Schema.optional(Schema.String),
  /** Project of the step threads and the webhook tasks. */
  home: Schema.Struct({ project: Schema.String }),
  /**
   * The bot this workflow works for: its `agent` steps get the bot's host MCP servers, and an
   * output with `postToBot` reports in its conversation. A bot may only bind a workflow to itself.
   */
  bot: Schema.optional(TriggerBotId),
  params: Schema.optional(Schema.Record(Schema.String, WorkflowParamSpec)),
  /** Trigger id → trigger. Ids share the node namespace, so they also key `canvas.positions`. */
  triggers: Schema.optional(Schema.Record(Schema.String, WorkflowTrigger)),
  /** Default `single`. */
  concurrency: Schema.optional(Schema.Literals(["single", "queue", "parallel"])),
  budget: WorkflowRunBudget,
  fatigue: Schema.Struct({ consecutiveFailures: PositiveInt }),
  /** Adds protected refs; the host's list always applies. */
  protect: Schema.optional(Schema.Array(Schema.String)),
  models: Schema.optional(Schema.Record(Schema.String, WorkflowModelRef)),
  workspaces: Schema.optional(Schema.Record(Schema.String, WorkflowWorkspaceDecl)),
  /** A local kanban board; a project linked to Linear is refused. */
  card: Schema.optional(Schema.Struct({ project: Schema.String })),
  nodes: Schema.Record(Schema.String, WorkflowNode),
  edges: Schema.Array(WorkflowEdge),
  canvas: Schema.optional(WorkflowCanvasLayout),
});
export type WorkflowDefinition = typeof WorkflowDefinition.Type;

// ── Diagnostics ───────────────────────────────────────────────────────────────────────────────

export const WORKFLOW_DIAGNOSTIC_CODES = [
  "schema",
  "unknown-node",
  "cycle",
  "unreachable",
  "port",
  "expr",
  "template-root",
  "untrusted-in-argv",
  "forbidden-command",
  "heavy-nesting",
  "model-alias",
  "judge-family",
  "budget-ceiling",
  "trigger",
  "call-cycle",
  "card-linear",
  "thread-continue",
  "bot",
] as const;
export const WorkflowDiagnosticCode = Schema.Literals(WORKFLOW_DIAGNOSTIC_CODES);
export type WorkflowDiagnosticCode = typeof WorkflowDiagnosticCode.Type;

export const WorkflowDiagnostic = Schema.Struct({
  /** Dotted path into the definition: `nodes.climb.measure.bench.argv[4]`, `edges[3]`. */
  path: Schema.String,
  code: WorkflowDiagnosticCode,
  message: Schema.String,
});
export type WorkflowDiagnostic = typeof WorkflowDiagnostic.Type;

// ── Views (derived from the journal, never stored) ────────────────────────────────────────────

export const WorkflowStepStatus = Schema.Literals([
  "pending",
  "dispatched",
  "running",
  "waiting_gate",
  "succeeded",
  "failed",
  "skipped",
  "cancelled",
  "lost",
  "timed_out",
  "ambiguous",
]);
export type WorkflowStepStatus = typeof WorkflowStepStatus.Type;

export const WorkflowStepCost = Schema.Struct({
  /** (input − cache reads) + output: what the budget counts. */
  billable: NonNegativeInt,
  /** Includes cache reads and writes, like TurnTokenUsage. */
  input: NonNegativeInt,
  /** Includes reasoning. */
  output: NonNegativeInt,
  cacheRead: NonNegativeInt,
  usage: Schema.Literals(["complete", "partial", "unavailable"]),
  /** null = unknown, never 0. */
  usdEstimate: Schema.NullOr(Schema.Number),
});
export type WorkflowStepCost = typeof WorkflowStepCost.Type;

export const WorkflowStepAttemptView = Schema.Struct({
  key: WorkflowStepKey,
  node: WorkflowNodeId,
  kind: Schema.String,
  attempt: PositiveInt,
  status: WorkflowStepStatus,
  threadId: Schema.NullOr(ThreadId),
  startedAt: Schema.NullOr(IsoDateTime),
  endedAt: Schema.NullOr(IsoDateTime),
  /** heavy.sh wait, separate from run time. */
  queuedMs: Schema.NullOr(NonNegativeInt),
  port: Schema.NullOr(Schema.String),
  /** 500 characters. */
  summary: Schema.NullOr(Schema.String),
  cost: Schema.NullOr(WorkflowStepCost),
  /** Path of the log or artifact. */
  evidence: Schema.NullOr(Schema.String),
});
export type WorkflowStepAttemptView = typeof WorkflowStepAttemptView.Type;

export const WorkflowGateView = Schema.Struct({
  key: Schema.String,
  step: WorkflowStepKey,
  ask: Schema.String,
  /** `ask` in a line or two (`gateReason`); absent from older hosts. */
  reason: Schema.optional(Schema.String),
  options: Schema.Array(Schema.String),
  openedAt: IsoDateTime,
  expiresAt: Schema.NullOr(IsoDateTime),
  decision: Schema.NullOr(
    Schema.Struct({ option: Schema.String, note: Schema.NullOr(Schema.String), at: IsoDateTime }),
  ),
});
export type WorkflowGateView = typeof WorkflowGateView.Type;

/** One measurement: the objective and each `measure.<name>` output. */
export const WorkflowMetricReading = Schema.Struct({
  objective: Schema.NullOr(Schema.Number),
  values: Schema.Record(Schema.String, Schema.Unknown),
});
export type WorkflowMetricReading = typeof WorkflowMetricReading.Type;

export const WorkflowLedgerVerdict = Schema.Literals([
  "kept",
  /** Kept, then approved by the workflow's final validation; only this becomes a base. */
  "validated",
  "rejected",
  "invalid",
  "duplicate",
  "abandoned",
]);
export type WorkflowLedgerVerdict = typeof WorkflowLedgerVerdict.Type;

export const WorkflowLedgerEntry = Schema.Struct({
  ledger: WorkflowLedgerId,
  key: Schema.String,
  workflowId: WorkflowId,
  runId: WorkflowRunId,
  step: WorkflowStepKey,
  hypothesis: Schema.String,
  barHash: Schema.String,
  registeredAt: IsoDateTime,
  verdict: Schema.NullOr(WorkflowLedgerVerdict),
  before: Schema.NullOr(WorkflowMetricReading),
  after: Schema.NullOr(WorkflowMetricReading),
  sha: Schema.NullOr(Schema.String),
  note: Schema.NullOr(Schema.String),
});
export type WorkflowLedgerEntry = typeof WorkflowLedgerEntry.Type;

export const WorkflowRunStatus = Schema.Literals([
  /** TriggerFired accepted, run not created yet. */
  "queued",
  /** TriggerSkipped; the reason is in `skipReason`. */
  "skipped",
  "running",
  "paused",
  "succeeded",
  "failed",
  "cancelled",
  "budget_exhausted",
]);
export type WorkflowRunStatus = typeof WorkflowRunStatus.Type;

export const WorkflowPauseReason = Schema.Literals([
  "fatigue",
  "ambiguous",
  "user",
  /** The host's daily token cap (HostLimits.workflowTokensPerDay) was reached; lifts at the day's turn. */
  "daily_cap",
]);
export type WorkflowPauseReason = typeof WorkflowPauseReason.Type;

export const WorkflowSkipReason = Schema.Literals(["busy", "disabled", "suspended", "invalid"]);
export type WorkflowSkipReason = typeof WorkflowSkipReason.Type;

export const WorkflowRunSummary = Schema.Struct({
  runId: WorkflowRunId,
  workflowId: WorkflowId,
  title: Schema.String,
  /** null while queued or skipped: no version is pinned yet. */
  hash: Schema.NullOr(WorkflowHash),
  commit: Schema.NullOr(Schema.String),
  status: WorkflowRunStatus,
  pausedFor: Schema.NullOr(WorkflowPauseReason),
  skipReason: Schema.NullOr(WorkflowSkipReason),
  /** `id` is the trigger that started the run, as the run's version names it. */
  trigger: Schema.Struct({ id: Schema.String, kind: Schema.String, label: Schema.String }),
  startedAt: IsoDateTime,
  endedAt: Schema.NullOr(IsoDateTime),
  outputStatus: Schema.NullOr(Schema.String),
  stepsUsed: NonNegativeInt,
  cost: WorkflowStepCost,
  reservedTokens: NonNegativeInt,
  openGates: NonNegativeInt,
  pullRequest: Schema.NullOr(Schema.String),
  /** Wall time without pauses and open-gate waits (the `wall` budget's clock); null before it starts. */
  activeMs: Schema.NullOr(NonNegativeInt),
  /** When `activeMs` was measured, while that clock still runs; null while paused, at a gate or ended. */
  activeSince: Schema.NullOr(IsoDateTime),
  /**
   * The oldest gate still waiting for the user, with its short reason; null when none. Absent
   * from older hosts and from rows written before it existed.
   */
  gate: Schema.optional(
    Schema.NullOr(
      Schema.Struct({ key: Schema.String, reason: Schema.String, openedAt: IsoDateTime }),
    ),
  ),
});
export type WorkflowRunSummary = typeof WorkflowRunSummary.Type;
