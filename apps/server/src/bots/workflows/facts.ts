/**
 * The journal's vocabulary (docs/friend/workflows-design.md §3.1). Every fact is plain JSON in
 * `workflow_facts`; its key is unique in its stream, so writing it twice writes nothing.
 * Streams: `run:<runId>`, `workflow:<workflowId>`, `ledger:<ledgerId>`.
 */
import * as Schema from "effect/Schema";

import { KanbanTicketId, WorkflowModelRef, WorkflowStepCost } from "@t3tools/contracts";

const Json = Schema.Json;
const Text = Schema.String;
const NullableText = Schema.NullOr(Schema.String);

/** Where a step's code lives: a named workspace, or a disposable checkout made for one attempt. */
export const WorkspaceRef = Schema.Struct({ name: Text, path: Text });
export type WorkspaceRef = typeof WorkspaceRef.Type;

/** A resource of the definition a start waits for: one of `slots` flock files must be free. */
export const SlotUse = Schema.Struct({ resource: Text, slots: Schema.Number });
export type SlotUse = typeof SlotUse.Type;

/**
 * What a `call` hands its child, resolved in the parent's item: worktrees the child works in
 * without preparing or removing them, and threads its agent nodes continue, by child name.
 */
export const CallInherit = Schema.Struct({
  workspaces: Schema.Record(
    Schema.String,
    Schema.Struct({ path: Text, project: Text, branch: NullableText, headSha: Text }),
  ),
  threads: Schema.Record(
    Schema.String,
    Schema.Struct({
      threadId: Text,
      projectRef: Text,
      path: Text,
      model: WorkflowModelRef,
      access: Schema.Literals(["read", "write"]),
      bot: Schema.optional(Text),
    }),
  ),
});
export type CallInherit = typeof CallInherit.Type;

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
    // wf-engine slice 7: a block child carries its own timeout; graph nodes read theirs from the definition.
    timeoutMs: Schema.optional(Schema.Number),
    /**
     * The workflow's bound bot, set only on an `agent` node's turns: HostMcpForward gives this
     * thread that bot's host MCP servers. Judges and block children never carry it.
     */
    bot: Schema.optional(Text),
    /** An `agent` node's `uses`: the turn starts once it holds a slot and keeps it until it ends. */
    uses: Schema.optional(SlotUse),
  },
  /**
   * One command in its own systemd unit; `heavy` takes the heavy.sh lock and `uses` a slot of a
   * resource inside the unit, before the argv starts.
   */
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
    // wf-engine slice 8: a paid command reserves tokens and is charged `out[tokensFrom]`.
    reservation: Schema.optional(Schema.Number),
    tokensFrom: Schema.optional(Text),
    uses: Schema.optional(SlotUse),
  },
  /** A git worktree of `projectRef` at `baseRef`; `branch` null makes it detached and disposable. */
  PrepareWorkspace: {
    key: Text,
    name: Text,
    projectRef: Text,
    baseRef: Text,
    branch: NullableText,
    /**
     * `branchPolicy: agent`: the worktree is the agent's on any branch it creates (adopted as it
     * is on a replay), and a pre-push hook for this worktree alone refuses a force push, a
     * deletion and a push to one of `protect`.
     */
    agentBranch: Schema.optional(Schema.Struct({ protect: Schema.Array(Text) })),
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
  /** The sha a ref of a project resolves to, without a checkout (a read-only pin). */
  ResolveRef: { key: Text, projectRef: Text, ref: Text },
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
    /** Who decided the gate behind it; a bot's decision never accepts an approval. */
    by: Schema.optionalKey(Text),
  },
  /**
   * Israel decides every gate through `gate.decide`. A gate with `bot` is also the workflow bot's:
   * it gets the ask in its conversation instead of the push, and `workflow_gate_decide` lets that
   * bot alone decide it. A protected or ambiguous gate never carries `bot`.
   */
  OpenGate: {
    key: Text,
    step: Text,
    gateKey: Text,
    reason: Schema.Literals(["gate", "protected", "ambiguous", "question"]),
    ask: Text,
    /** `ask` in a line or two; gates opened before it existed derive it from `ask`. */
    short: Schema.optionalKey(Text),
    options: Schema.Array(Text),
    expiresAt: NullableText,
    bot: Schema.optionalKey(Text),
  },
  /** One of the three notices the user gets; `key` names the event, so a resend deduplicates. */
  Notify: {
    key: Text,
    kind: Schema.Literals(["needs_you", "failed", "finished"]),
    title: Text,
    body: Text,
  },
  /** The run's kanban card; it points at the run and never links a step thread. */
  UpsertCard: {
    key: Text,
    ticketId: Schema.optionalKey(KanbanTicketId),
    // wf-engine slice 8: the kanban project of `card.project`.
    project: Text,
    column: Schema.Literals(["todo", "in_progress", "in_review", "done"]),
    title: Text,
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
  /**
   * Key `post:<step>` (`post:<node>:<item>` in a body): the output's report as a message in the
   * bot's current main thread. Key `ask:<gateKey>` with `gate`: a gate routed to the bot, framed
   * as a question it answers with `workflow_gate_decide`.
   */
  PostToBot: {
    key: Text,
    step: Text,
    botId: Text,
    workflowTitle: Text,
    report: Text,
    gate: Schema.optionalKey(Text),
  },
  /** Key `ticket:<ref>`: a kanban ticket (id or identifier) and its issue as a first message. */
  ReadTicket: { key: Text, ref: Text },
  /** Key `link:<ticketId>:<threadId>`: links a visible step thread to its kanban card. */
  LinkThread: { key: Text, ticketId: Text, threadId: Text },
  StartChildRun: {
    key: Text,
    step: Text,
    attempt: Schema.Number,
    workflowId: Text,
    params: Schema.Record(Schema.String, Json),
    // wf-engine slice 8: the child's whole token budget, reserved in the parent until it ends.
    reservation: Schema.optional(Schema.Number),
    inherit: Schema.optional(CallInherit),
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
    /** `id` is the trigger the decider resolved; facts written before it existed read it as `kind`. */
    trigger: Schema.Struct({
      id: Schema.optional(Text),
      kind: Text,
      occurrence: Text,
      label: Text,
      payload: Json,
    }),
    budget: Schema.Struct({
      steps: Schema.Number,
      wallMs: Schema.Number,
      tokens: Schema.Number,
      usd: Schema.NullOr(Schema.Number),
    }),
    parent: Schema.NullOr(Schema.Struct({ runId: Text, step: Text })),
    /** A call's `workspaces` and `threads`, as the parent resolved them. */
    inherit: Schema.optional(CallInherit),
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
  // wf-engine slice 7: a block pins a decision of its own under `block:<step>:<id>`.
  BlockAdvanced: { step: Text, id: Text, event: Json },
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
  /** Key `ended` (`ended:<n>` after the n-th reopening). */
  RunEnded: {
    status: Schema.Literals(["succeeded", "failed", "cancelled", "budget_exhausted"]),
    at: Text,
  },
  /** Key `reopen:<control key>`: a retry of `step` brought a failed run back to running. */
  RunReopened: { step: Text, by: Text, at: Text },
  /**
   * Key `retry:<control key>`: `step` runs again. The steps after it, in its level and in every map
   * that holds it, start over (`superseded`); those maps resolve again (`reopened`).
   */
  RetryApplied: {
    step: Text,
    by: Text,
    superseded: Schema.Array(Text),
    reopened: Schema.Array(Text),
    at: Text,
  },
  /** Key `released:<branch>`: run `to` took over this ended run's branch; it cannot reopen on it. */
  BranchReleased: { branch: Text, to: Text },

  // Results of intents, key `result:<intent key>`.
  TurnStarted: { threadId: Text },
  UnitSpawned: { unit: Text, at: Text },
  WorkspaceReady: {
    name: Text,
    path: Text,
    branch: NullableText,
    headSha: Text,
    /** The ref and sha a new worktree started from (a fetched remote tip, or the local ref). */
    base: Schema.optional(Schema.Struct({ ref: Text, sha: Text })),
  },
  GitOpDone: { sha: Text },
  WorkspaceRemoved: {},
  RefResolved: { sha: Text },
  Interrupted: {},
  Answered: {},
  GateOpened: { gateKey: Text, at: Text },
  Notified: {},
  // A result recorded before cards kept their ticket has none; the next card scans for it.
  CardUpserted: { ticketId: Schema.optionalKey(KanbanTicketId) },
  PullRequestOpened: { url: Text, branch: Text },
  ChildRunStarted: { childRunId: Text },
  /** `threadId` null: the bot no longer exists and nothing was posted. */
  BotPosted: { threadId: NullableText },
  /** `title` is `<identifier> <title>`; `message` opens the visible thread. */
  TicketRead: { ticketId: Text, title: Text, message: Text },
  ThreadLinked: {},
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
    // wf-engine slice 7: `git rev-parse HEAD^{tree}` next to headSha; the ledger refuses a tree twice.
    treeHash: Schema.optional(NullableText),
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
    /** stderr's last 8 KiB; absent from receipts written before it was kept. */
    stderr: Schema.optional(Text),
  },
  /**
   * Key `slot:<intent key>`: the start got slot `slot` of `resource` after `waitedMs`. A start
   * with `uses` and no such fact is still waiting.
   */
  SlotAcquired: {
    step: Text,
    attempt: Schema.Number,
    resource: Text,
    slot: Schema.Number,
    waitedMs: Schema.Number,
  },
  // wf-engine slice 8: usage a provider reports mid-turn, key `usage:<intent key>:<n>` (n = multiple of the reservation).
  TurnUsageReported: { step: Text, attempt: Schema.Number, billable: Schema.Number, at: Text },
  /** Key `request:<requestId>`. */
  RuntimeRequest: {
    step: Text,
    attempt: Schema.Number,
    threadId: Text,
    requestId: Text,
    requestKind: Text,
    text: Text,
  },
  /** Key `gate:<gateKey>`: the first decision wins. A bot's `note` is its answer. */
  GateDecided: {
    gateKey: Text,
    option: Text,
    note: NullableText,
    by: Schema.Union([
      Schema.Literals(["user", "expiry"]),
      Schema.TemplateLiteral(["bot:", Schema.String]),
    ]),
    at: Text,
  },
  /**
   * Key `handover:<gateKey>`: a bot's gate whose ask can never reach the bot is Israel's, as gate
   * `to`. Only an undecided gate is handed over, and no decision of it counts after this.
   */
  GateHandedOver: { gateKey: Text, to: Text, at: Text },
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
  /** Key `warn:<reason>`: something the run could not do as written; it goes on regardless. */
  RunWarned: { message: Text, at: Text },
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
    inherit: Schema.optional(CallInherit),
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
  /** Key `trigger-toggled:<triggerId>:<clientRequestId>`. A trigger is on until its first one. */
  TriggerToggled: { triggerId: Text, enabled: Schema.Boolean, by: Text, at: Text },
  /** Key `suspended:<runId>`: the failed run that reached the fatigue limit. */
  Suspended: { reason: Schema.Literal("fatigue"), at: Text },
  /** Key `unsuspended:<clientRequestId>`. */
  Unsuspended: { by: Text, at: Text },
});
export type WorkflowFact = typeof WorkflowFact.Type;

// wf-engine slice 7: the ledger stream `ledger:<ledgerId>`, shared by every run (§3.1).
export const LedgerFact = Schema.TaggedUnion({
  /** Key `entry:<key>`: the first run to register a key owns it. */
  EntryRegistered: {
    key: Text,
    workflowId: Text,
    runId: Text,
    step: Text,
    hypothesis: Text,
    barHash: Text,
    at: Text,
  },
  /** Key `tree:<treeHash>`: the first entry measured with that tree. */
  TreeSeen: { treeHash: Text, entryKey: Text, runId: Text },
  /** Key `resolved:<key>`. */
  EntryResolved: {
    key: Text,
    verdict: Schema.Literals(["kept", "rejected", "invalid", "duplicate", "abandoned"]),
    before: Json,
    after: Json,
    sha: NullableText,
    note: NullableText,
    at: Text,
  },
  /** Key `validated:<key>`: an output's `promote` approved a kept entry; only these become a base. */
  EntryValidated: { key: Text, runId: Text, at: Text },
});
export type LedgerFact = typeof LedgerFact.Type;

export const Fact = Schema.Union([RunFact, WorkflowFact, LedgerFact]);
export type Fact = typeof Fact.Type;
export type FactTag = Fact["_tag"];

/** A fact on its way into the journal. */
export interface NewFact {
  readonly stream: string;
  readonly key: string;
  readonly fact: Fact;
  /**
   * Written only if no fact of these kinds landed in its stream after `after`, checked in the
   * append's transaction (a fact already stored under its key is returned as usual).
   */
  readonly guard?: { readonly absent: ReadonlyArray<string>; readonly after: number };
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
// wf-engine slice 7.
export const ledgerStream = (ledgerId: string) => `ledger:${ledgerId}`;
