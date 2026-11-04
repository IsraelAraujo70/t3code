/**
 * The contract between the run decider and the four blocks (§4). A block is a pure sub-decider:
 * each pass it derives its typed sub-state from its children, then asks for the next children
 * through `BlockIO`. Every child has a step key under the block's own (`<step>/<child>`), and
 * asking for a child that is already recorded records nothing, so a block may ask every pass.
 */
import type { Json } from "effect/Schema";
import type * as Result from "effect/Result";

import type {
  WorkflowBlockView,
  WorkflowModelRef,
  WorkflowModelUse,
  WorkflowNode,
  WorkflowOutputShape,
} from "@t3tools/contracts";
import type { JsonValue } from "@t3tools/shared/workflows";

import type { BlockEventEntry } from "../state.ts";
import type { LedgerState, LedgerVerdict } from "./ledger.ts";

export type BlockKind = "hillclimb" | "arena" | "graph" | "interrogate";
export type BlockNode<K extends BlockKind = BlockKind> = Extract<
  WorkflowNode,
  { readonly kind: K }
>;

/** A git worktree a block prepared for its children. */
export interface BlockWorkspace {
  /** Run-unique: `<block step>/<child>`. */
  readonly name: string;
  readonly path: string;
  readonly project: string;
  readonly branch: string | null;
  /** The sha it was prepared at. */
  readonly headSha: string;
  /** The `base` a declared workspace asked for and the sha it started from, when recorded. */
  readonly base?: { readonly ref: string; readonly sha: string };
}

/** Never recorded. */
export interface Absent {
  readonly _tag: "Absent";
}
/** Recorded and not answered yet, or asked for and not admitted by the budget yet. */
export interface Waiting {
  readonly _tag: "Waiting";
}
/** The intent itself failed (launch, prepare, git, a refused command): nothing ran. */
export interface Failed {
  readonly _tag: "Failed";
  readonly error: string;
}

export type TurnObservation =
  | Absent
  | Waiting
  | Failed
  | {
      readonly _tag: "Settled";
      /** Completed, and its JSON decoded when an output shape was asked (after one nudge). */
      readonly ok: boolean;
      readonly status: "completed" | "failed" | "cancelled" | "interrupted";
      readonly text: string;
      readonly output: Json;
      /** Why `ok` is false. */
      readonly error: string | null;
      readonly threadId: string;
      /** Read by the engine after the turn, never taken from the agent. */
      readonly headSha: string | null;
      readonly treeHash: string | null;
    };

export type UnitObservation =
  | Absent
  | Waiting
  | Failed
  | {
      readonly _tag: "Exited";
      /** Exit 0, an exit receipt, and parsed when a parse mode was asked. */
      readonly ok: boolean;
      readonly exit: number | null;
      /** `TIMEOUT` when the unit hit its own timeout. */
      readonly signal: string | null;
      readonly out: Json;
      readonly tail: string;
      readonly lost: boolean;
      readonly parseError: string | null;
    };

export type WorkspaceObservation =
  | Absent
  | Waiting
  | Failed
  | { readonly _tag: "Ready"; readonly workspace: BlockWorkspace };

export type GitObservation =
  | Absent
  | Waiting
  | Failed
  | { readonly _tag: "Done"; readonly sha: string };

export interface TurnRequest {
  readonly model: WorkflowModelRef;
  readonly prompt: string;
  readonly workspace: BlockWorkspace;
  readonly access: "read" | "write";
  /** The child whose thread this turn continues (same workspace and access); absent opens a new thread. */
  readonly continues?: string;
  /** Asks for a ```json block with these fields and nudges once in the same thread when it is missing. */
  readonly output?: WorkflowOutputShape;
  /** Billable tokens reserved before the start; absent uses the run's default estimate. */
  readonly reservation?: number;
  readonly timeoutMs?: number;
}

export interface UnitRequest {
  /** Rendered. A protected command waits for the owner's gate first; a forbidden one fails. */
  readonly argv: ReadonlyArray<string>;
  readonly cwd: BlockWorkspace;
  readonly heavy: boolean;
  readonly replay: "safe" | "never";
  readonly timeoutMs: number;
  readonly env?: { readonly [name: string]: string };
  readonly parse?: "none" | "json" | "json-last-line";
  /** A paid command: `out[tokensFrom]` is charged, and `reservation` is passed as WF_TOKEN_BUDGET. */
  readonly tokensFrom?: string;
  readonly reservation?: number;
}

/** The ledger-side answer to a registration: ours, another run's (or another step's), or not stored yet. */
export type Claim = "mine" | "taken" | "pending";

/** What a block reads; built from the folded run alone, so views use it too. */
export interface BlockReader {
  readonly runId: string;
  /** The block's own step key (`climb`, `each[2]/climb`). */
  readonly step: string;
  /** The block step's attempt. Attempt n > 1 scopes children under `<step>/a<n>/…`. */
  readonly attempt: number;
  /** Ignores any output shape the turn asked for; read such a turn through `BlockIO.turn`. */
  readonly turnOf: (child: string) => TurnObservation;
  readonly unitOf: (child: string) => UnitObservation;
  readonly workspaceOf: (child: string) => WorkspaceObservation;
  readonly gitOf: (child: string) => GitObservation;
  /** The child's step status as the run view shows it. */
  readonly childStatus: (
    child: string,
  ) =>
    | "pending"
    | "dispatched"
    | "running"
    | "waiting_gate"
    | "succeeded"
    | "failed"
    | "lost"
    | "timed_out"
    | "cancelled"
    | "ambiguous"
    | "skipped";
  /** This block's BlockAdvanced events, in journal order (and this pass's, in the decider). */
  readonly events: ReadonlyArray<BlockEventEntry>;
  /** Billable tokens charged to this block's children (reservation for unknown usage). */
  readonly spent: () => number;
  /** Active milliseconds since the block's first child started (pauses and gate waits excluded). */
  readonly activeMs: () => number;
}

/** What a block may do in one pass. Every action is idempotent per child id. */
export interface BlockIO extends BlockReader {
  readonly now: number;
  readonly runDir: string;
  /** `<runDir>/steps/<sanitized child step>`: where a child's command writes its files. */
  readonly stepDir: (child: string) => string;

  readonly workspace: (
    child: string,
    request: { readonly project: string; readonly baseRef: string; readonly branch: string | null },
  ) => WorkspaceObservation;
  readonly turn: (child: string, request: TurnRequest) => TurnObservation;
  readonly unit: (child: string, request: UnitRequest) => UnitObservation;
  /** Compare-and-swap of `refs/heads/<branch>` from `from` to `to`, in the workspace's repository. */
  readonly advance: (
    child: string,
    request: {
      readonly workspace: BlockWorkspace;
      readonly branch: string;
      readonly from: string;
      readonly to: string;
    },
  ) => GitObservation;
  /** Merges `from` into the workspace whose HEAD must still be `expectHead`. */
  readonly mergeLocal: (
    child: string,
    request: {
      readonly workspace: BlockWorkspace;
      readonly from: string;
      readonly expectHead: string;
    },
  ) => GitObservation;
  readonly remove: (workspace: BlockWorkspace) => void;
  /**
   * A declared workspace or a block export (`climb.best`) by name, with the HEAD the journal last
   * saw in it; null while it is not prepared (or not exported).
   */
  readonly namedWorkspace: (name: string) => BlockWorkspace | null;
  /** Stops the child's live turn or unit, if any. */
  readonly interrupt: (child: string) => void;
  /**
   * Overrides how a settled child shows in the run (default: ok → succeeded, otherwise failed,
   * lost or timed_out). A measurement that ran but is incomplete is `failed`: it counts for fatigue.
   */
  readonly settleChild: (
    child: string,
    status: "succeeded" | "failed",
    error: string | null,
  ) => void;
  /** Pins a decision under `block:<step>:<id>`; recording the same id twice keeps the first. */
  readonly event: (id: string, event: Json) => void;

  readonly ledger: (ledgerId: string) => LedgerState;
  /**
   * Registers `key` for `child` before any code is written (pre-registration). The first run and
   * child to store it own it; the same key from another child of this block is `taken` too.
   */
  readonly register: (
    ledgerId: string,
    child: string,
    entry: { readonly key: string; readonly hypothesis: string; readonly barHash: string },
  ) => Claim;
  /** Claims a tree hash for an entry; a tree already claimed by another entry is a duplicate. */
  readonly seeTree: (ledgerId: string, treeHash: string, entryKey: string) => Claim;
  readonly resolveEntry: (
    ledgerId: string,
    entry: {
      readonly key: string;
      readonly verdict: Exclude<LedgerVerdict, "validated">;
      readonly before: Json;
      readonly after: Json;
      readonly sha: string | null;
      readonly note: string | null;
    },
  ) => void;

  /** Templates and expressions over the block's level, plus `roots` (`m`, `best`, `step`, …). */
  readonly render: (
    template: string,
    roots?: { readonly [root: string]: JsonValue },
  ) => Result.Result<string, string>;
  readonly evaluate: (
    expr: string,
    roots?: { readonly [root: string]: JsonValue },
  ) => Result.Result<JsonValue, string>;
  readonly model: (use: WorkflowModelUse) => Result.Result<WorkflowModelRef, string>;

  /**
   * Resolves the block step: `fail` resolves it failed, any other port succeeded. `exports` names
   * the worktrees later nodes reach as `<node>.<name>` (`best`, `graft`, `integration`).
   */
  readonly finish: (
    port: string,
    output: { readonly [key: string]: Json },
    options?: {
      readonly error?: string;
      readonly exports?: {
        readonly [name: string]: { readonly workspace: BlockWorkspace; readonly head: string };
      };
    },
  ) => void;
}

/** One block kind: derive its sub-state, decide its next children, show its view. */
export interface BlockDecider<K extends BlockKind, State> {
  readonly derive: (node: BlockNode<K>, reader: BlockReader) => State;
  readonly decide: (node: BlockNode<K>, state: State, io: BlockIO) => void;
  readonly view: (node: BlockNode<K>, state: State) => WorkflowBlockView;
}
