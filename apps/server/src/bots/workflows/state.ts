/** What folding a run's facts yields; `decide` reads only this and the compiled definition. */
import type { Json } from "effect/Schema";

import type { Intent, RunFact } from "./facts.ts";

type FactOf<Tag extends RunFact["_tag"]> = Extract<RunFact, { readonly _tag: Tag }>;

export type RunStarted = FactOf<"RunStarted">;
export type RunEnded = FactOf<"RunEnded">;
export type OutputSet = FactOf<"OutputSet">;
export type RunPaused = FactOf<"RunPaused">;
export type StepResolved = FactOf<"StepResolved">;
export type TurnSettled = FactOf<"TurnSettled">;
export type UnitExited = FactOf<"UnitExited">;
export type RuntimeRequest = FactOf<"RuntimeRequest">;
export type GateDecided = FactOf<"GateDecided">;
export type ControlRequested = FactOf<"ControlRequested">;
export type ChildRunEnded = FactOf<"ChildRunEnded">;
export type WorkspaceReady = FactOf<"WorkspaceReady">;

/** Facts stored under `result:<intent key>`. */
export type IntentResult = Exclude<
  RunFact,
  {
    readonly _tag:
      | "RunStarted"
      | "IntentRecorded"
      | "StepSkipped"
      | "MapExpanded"
      | "IterationStarted"
      | "StepResolved"
      | "OutputSet"
      | "RunPaused"
      | "RunResumed"
      | "RunEnded"
      | "TurnSettled"
      | "UnitExited"
      | "RuntimeRequest"
      | "GateDecided"
      | "ControlRequested"
      | "ChildRunEnded";
  }
>;

export interface IntentEntry {
  readonly intent: Intent;
  readonly seq: number;
  /** null while the intent waits for the interpreter: re-execute it with the same key. */
  readonly result: IntentResult | null;
}

/** One attempt of one step instance (`merge`, `each[2]/design`). */
export interface StepAttempt {
  readonly step: string;
  readonly attempt: number;
  /** Seq of the first fact of this attempt; orders attempts and feeds `startedAt`. */
  readonly firstSeq: number;
  /** Seq of the last fact that changed this attempt: what a delta after `afterSeq` includes. */
  readonly lastSeq: number;
  /** When its turn, unit or child run started (the stored time of that result fact). */
  readonly startedAt: string | null;
  readonly threadId: string | null;
  readonly unit: string | null;
  /** The main turn's observation. */
  readonly settled: TurnSettled | null;
  /** The follow-up turn that asked for the missing JSON. */
  readonly nudge: TurnSettled | null;
  readonly exited: UnitExited | null;
  readonly child: ChildRunEnded | null;
  readonly resolved: StepResolved | null;
}

export interface GateState {
  readonly intent: Extract<Intent, { readonly _tag: "OpenGate" }>;
  readonly openedAt: string | null;
  readonly decision: GateDecided | null;
  /** Seq of the last fact that changed this gate. */
  readonly lastSeq: number;
}

export interface RunState {
  readonly runId: string;
  readonly lastSeq: number;
  readonly started: RunStarted | null;
  readonly ended: RunEnded | null;
  readonly output: OutputSet | null;
  /** The open pause; null while the run is not paused. */
  readonly paused: RunPaused | null;
  readonly pauseCount: number;
  readonly resumeCount: number;
  readonly intents: ReadonlyMap<string, IntentEntry>;
  /** By step key, attempts ascending. */
  readonly attempts: ReadonlyMap<string, ReadonlyArray<StepAttempt>>;
  readonly skipped: ReadonlyMap<string, "guard" | "dead-path" | "once">;
  /** Seq of each StepSkipped, for deltas. */
  readonly skippedSeq: ReadonlyMap<string, number>;
  /** Every key already in the run's stream: `decide` never emits one of these again. */
  readonly keys: ReadonlySet<string>;
  /** Child run outcomes by child run id, whatever order they and their start receipt arrived in. */
  readonly children: ReadonlyMap<string, ChildRunEnded>;
  /** Map step key → its items. */
  readonly expansions: ReadonlyMap<string, ReadonlyArray<Json>>;
  /** Loop step key → highest iteration index started. */
  readonly iterations: ReadonlyMap<string, number>;
  /** By gate key. */
  readonly gates: ReadonlyMap<string, GateState>;
  /** By request id. */
  readonly requests: ReadonlyMap<string, RuntimeRequest>;
  /** In journal order, with their keys. */
  readonly controls: ReadonlyArray<{
    readonly key: string;
    readonly seq: number;
    readonly control: ControlRequested;
  }>;
  /** By workspace name. */
  readonly workspaces: ReadonlyMap<string, WorkspaceReady>;
}
