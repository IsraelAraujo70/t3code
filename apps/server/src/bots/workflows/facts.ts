/**
 * The journal's vocabulary (docs/friend/workflows-design.md §3.1). Every fact is plain JSON in
 * `workflow_facts`; its key is unique in its stream, so writing it twice writes nothing.
 * Streams: `run:<runId>`, `workflow:<workflowId>`, `ledger:<ledgerId>`.
 */
import * as Schema from "effect/Schema";

import { WorkflowModelRef, WorkflowStepCost } from "@t3tools/contracts";

const Json = Schema.Json;
const Text = Schema.String;
const NullableText = Schema.NullOr(Schema.String);

/** Where a step's code lives: a named workspace, or a disposable checkout made for one attempt. */
export const WorkspaceRef = Schema.Struct({ name: Text, path: Text });
export type WorkspaceRef = typeof WorkspaceRef.Type;

// ── Intents: what the interpreter executes, each under its own key ────────────────────────────

export const Intent = Schema.TaggedUnion({
  /** A turn in a new thread (`threadId` precomputed) or a follow-up in an existing one. */
  StartTurn: {
    key: Text,
    step: Text,
    attempt: Schema.Number,
    threadId: Text,
    mode: Schema.Literals(["new", "continue"]),
    projectRef: Text,
    title: Text,
    workspace: WorkspaceRef,
    prompt: Text,
    model: WorkflowModelRef,
    access: Schema.Literals(["read", "write"]),
    reservation: Schema.Number,
  },
  /** One command in its own systemd unit; `heavy` takes the heavy.sh lock inside the unit. */
  StartUnit: {
    key: Text,
    step: Text,
    attempt: Schema.Number,
    argv: Schema.Array(Text),
    cwd: WorkspaceRef,
    heavy: Schema.Boolean,
    replay: Schema.Literals(["safe", "never"]),
    timeoutMs: Schema.Number,
    env: Schema.Record(Schema.String, Text),
    /** How the interpreter turns stdout into `UnitExited.out`; absent is "none". */
    parse: Schema.optional(Schema.Literals(["none", "json", "json-last-line"])),
  },
  /** A git worktree of `projectRef` at `baseRef`; `branch` null makes it detached and disposable. */
  PrepareWorkspace: {
    key: Text,
    name: Text,
    projectRef: Text,
    baseRef: Text,
    branch: NullableText,
  },
  GitOp: {
    key: Text,
    workspace: Text,
    op: Schema.Union([
      Schema.Struct({ kind: Schema.Literal("advance"), branch: Text, to: Text, from: Text }),
      Schema.Struct({ kind: Schema.Literal("mergeLocal"), from: Text, expectHead: Text }),
    ]),
  },
  RemoveWorkspace: { key: Text, name: Text },
  Interrupt: {
    key: Text,
    step: Text,
    target: Schema.Union([
      Schema.Struct({ threadId: Text }),
      Schema.Struct({ unit: Text }),
      Schema.Struct({ childRunId: Text }),
    ]),
  },
  AnswerRequest: {
    key: Text,
    threadId: Text,
    requestId: Text,
    answer: Schema.Union([Schema.Literal("decline"), Schema.Struct({ text: Text })]),
  },
  /** Every gate is the owner's: only `gate.decide` with a user session answers it. */
  OpenGate: {
    key: Text,
    step: Text,
    gateKey: Text,
    reason: Schema.Literals(["gate", "protected", "ambiguous", "question"]),
    ask: Text,
    options: Schema.Array(Text),
    expiresAt: NullableText,
  },
  /** One of the three notices the user gets; `key` names the event, so a resend deduplicates. */
  Notify: {
    key: Text,
    kind: Schema.Literals(["needs_you", "failed", "finished"]),
    title: Text,
    body: Text,
    runPath: Text,
  },
  /** The run's kanban card; it points at the run and never links a step thread. */
  UpsertCard: {
    key: Text,
    column: Schema.Literals(["todo", "in_progress", "in_review", "done"]),
    title: Text,
    runPath: Text,
  },
  /** Push the journal's sha, never the worktree's HEAD, to a `wf/…` branch without force. */
  OpenPullRequest: {
    key: Text,
    workspace: Text,
    branch: Text,
    sha: Text,
    base: Text,
    title: Text,
    body: Text,
  },
  StartChildRun: {
    key: Text,
    step: Text,
    attempt: Schema.Number,
    workflowId: Text,
    params: Schema.Record(Schema.String, Json),
  },
});
export type Intent = typeof Intent.Type;

// ── Run stream ────────────────────────────────────────────────────────────────────────────────

const StepStatusResolved = Schema.Literals([
  "succeeded",
  "failed",
  "lost",
  "timed_out",
  "cancelled",
  "ambiguous",
]);

export const RunFact = Schema.TaggedUnion({
  /** Key `started`. Pins the version: the actor only reads `workflow_versions`, never HEAD. */
  RunStarted: {
    workflowId: Text,
    commit: Text,
    hash: Text,
    title: Text,
    params: Schema.Record(Schema.String, Json),
    trigger: Schema.Struct({ kind: Text, occurrence: Text, label: Text, payload: Json }),
    budget: Schema.Struct({
      steps: Schema.Number,
      wallMs: Schema.Number,
      tokens: Schema.Number,
      usd: Schema.NullOr(Schema.Number),
    }),
    parent: Schema.NullOr(Schema.Struct({ runId: Text, step: Text })),
    causalDepth: Schema.Number,
    at: Text,
  },
  /** Key = intent.key. */
  IntentRecorded: { intent: Intent },
  /** Key `skip:<step>`. */
  StepSkipped: { step: Text, reason: Schema.Literals(["guard", "dead-path", "once"]) },
  /** Key `expand:<step>`. The items a map runs, capped at maxItems. */
  MapExpanded: { step: Text, items: Schema.Array(Json) },
  /** Key `iter:<step>:<index>`. */
  IterationStarted: { step: Text, index: Schema.Number },
  /** Key `resolved:<step>@<attempt>`. `port` null sends every successor down a dead path. */
  StepResolved: {
    step: Text,
    attempt: Schema.Number,
    status: StepStatusResolved,
    port: NullableText,
    output: Json,
    error: NullableText,
    at: Text,
  },
  /** Key `output`. */
  OutputSet: {
    status: Text,
    value: Schema.Record(Schema.String, Json),
    report: NullableText,
    handoff: NullableText,
  },
  /** Key `pause:<n>`. */
  RunPaused: {
    reason: Schema.Literals(["fatigue", "ambiguous", "user", "daily_cap"]),
    detail: Text,
    at: Text,
  },
  /** Key `resume:<n>`. */
  RunResumed: { at: Text },
  /** Key `ended`. */
  RunEnded: {
    status: Schema.Literals(["succeeded", "failed", "cancelled", "budget_exhausted"]),
    at: Text,
  },

  // Results of intents, key `result:<intent key>`.
  TurnStarted: { threadId: Text },
  UnitSpawned: { unit: Text, at: Text },
  WorkspaceReady: { name: Text, path: Text, branch: NullableText, headSha: Text },
  GitOpDone: { sha: Text },
  WorkspaceRemoved: {},
  Interrupted: {},
  Answered: {},
  GateOpened: { gateKey: Text, at: Text },
  Notified: {},
  CardUpserted: {},
  PullRequestOpened: { url: Text, branch: Text },
  ChildRunStarted: { childRunId: Text },
  /** The intent cannot be done; `retryable` lets the actor try the same key again later. */
  IntentFailed: { error: Text, retryable: Schema.Boolean },

  // Observations, each under its natural key.
  /** Key `settled:<step>@<attempt>` (`…:nudge` for the follow-up that asks for the JSON). */
  TurnSettled: {
    step: Text,
    attempt: Schema.Number,
    status: Schema.Literals(["completed", "failed", "cancelled", "interrupted"]),
    text: Text,
    output: Json,
    outputError: NullableText,
    cost: WorkflowStepCost,
    /** HEAD of the step's worktree after the turn, read by the engine, never taken from the agent. */
    headSha: Schema.optional(NullableText),
    /** The engine could not observe the turn's end: its outcome is unknown and Israel decides. */
    unobserved: Schema.optional(Schema.Boolean),
  },
  /** Key `exited:<step>@<attempt>`. `started` false: the argv never ran. `lost`: no exit receipt. */
  UnitExited: {
    step: Text,
    attempt: Schema.Number,
    exit: Schema.NullOr(Schema.Number),
    signal: NullableText,
    queuedMs: Schema.Number,
    out: Json,
    tail: Text,
    lost: Schema.Boolean,
    started: Schema.Boolean,
    parseError: Schema.optional(NullableText),
    headSha: Schema.optional(NullableText),
  },
  /** Key `request:<requestId>`. */
  RuntimeRequest: {
    step: Text,
    attempt: Schema.Number,
    threadId: Text,
    requestId: Text,
    requestKind: Text,
    text: Text,
  },
  /** Key `gate:<gateKey>`: the first decision wins. */
  GateDecided: {
    gateKey: Text,
    option: Text,
    note: NullableText,
    by: Schema.Literals(["user", "expiry"]),
    at: Text,
  },
  /** Key `control:<clientRequestId>`. */
  ControlRequested: {
    control: Schema.Literals(["cancel", "pause", "resume", "retry", "amendBudget"]),
    step: NullableText,
    /** New ceilings for `amendBudget`; the budget slice applies them. */
    budget: Schema.optional(
      Schema.Struct({
        steps: Schema.optional(Schema.Number),
        wallMs: Schema.optional(Schema.Number),
        tokens: Schema.optional(Schema.Number),
      }),
    ),
    by: Text,
    at: Text,
  },
  /** Key `child:<childRunId>`. */
  ChildRunEnded: {
    childRunId: Text,
    status: Text,
    output: Json,
    cost: WorkflowStepCost,
  },
});
export type RunFact = typeof RunFact.Type;

// ── Workflow stream ───────────────────────────────────────────────────────────────────────────

export const WorkflowFact = Schema.TaggedUnion({
  /** Key = occurrence (`manual:<id>`, `cron:<trigger>:<iso>`, …). */
  TriggerFired: {
    /** `runIdFor(workflowId, occurrence)`, so a queued run is found by its id alone. */
    runId: Text,
    triggerId: Text,
    kind: Text,
    occurrence: Text,
    label: Text,
    params: Schema.Record(Schema.String, Json),
    payload: Json,
    causalDepth: Schema.Number,
    parent: Schema.NullOr(Schema.Struct({ runId: Text, step: Text })),
    at: Text,
  },
  /** Key `created:<occurrence>`, appended with the run's RunStarted. */
  RunCreated: { runId: Text, occurrence: Text },
  /** Key `skipped:<occurrence>`. */
  TriggerSkipped: {
    occurrence: Text,
    reason: Schema.Literals(["busy", "disabled", "suspended", "invalid"]),
  },
  /** Key `outcome:<runId>`, appended with the run's RunEnded. */
  RunOutcome: { runId: Text, status: Text },
  /** Key `toggled:<clientRequestId>`. A workflow is off until its first Toggled. */
  Toggled: { enabled: Schema.Boolean, by: Text, at: Text },
  /** Key `suspended:<runId>`: the failed run that reached the fatigue limit. */
  Suspended: { reason: Schema.Literal("fatigue"), at: Text },
  /** Key `unsuspended:<clientRequestId>`. */
  Unsuspended: { by: Text, at: Text },
});
export type WorkflowFact = typeof WorkflowFact.Type;

export const Fact = Schema.Union([RunFact, WorkflowFact]);
export type Fact = typeof Fact.Type;
export type FactTag = Fact["_tag"];

/** A fact on its way into the journal. */
export interface NewFact {
  readonly stream: string;
  readonly key: string;
  readonly fact: Fact;
}

/** A fact as the journal holds it. */
export interface StoredFact {
  readonly stream: string;
  readonly seq: number;
  readonly key: string;
  readonly fact: Fact;
  readonly at: string;
}

export const runStream = (runId: string) => `run:${runId}`;
export const workflowStream = (workflowId: string) => `workflow:${workflowId}`;
