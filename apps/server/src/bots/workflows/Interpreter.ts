/**
 * Executes recorded intents. Everything here must be idempotent per intent key: after a crash the
 * actor runs the same intent again, and it must reach the same upstream receipt, unit or ref.
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";

import type { Intent, NewFact } from "./facts.ts";
import type { IntentResult } from "./state.ts";

export class WorkflowInterpreter extends Context.Service<
  WorkflowInterpreter,
  {
    /**
     * Runs one intent and returns its result facts, under `result:<intent.key>` in the run's
     * stream (plus any fact another stream needs). Never fails: a failure is an `IntentFailed`.
     */
    readonly execute: (runId: string, intent: Intent) => Effect.Effect<ReadonlyArray<NewFact>>;
    /**
     * The run ended before this start intent (StartTurn, StartUnit, StartChildRun) had a result:
     * make sure it does not run, stopping it if an earlier execution did start it, and return its
     * result as a non-retryable `IntentFailed`. Idempotent like `execute`.
     */
    readonly abandon: (runId: string, intent: Intent) => Effect.Effect<ReadonlyArray<NewFact>>;
    /**
     * Watches a started turn (`StartTurn` with `TurnStarted`) or unit (`StartUnit` with
     * `UnitSpawned`) until it settles: runtime requests on the way, then `TurnSettled` or
     * `UnitExited`. Called again for the same intent after a restart.
     */
    readonly observe: (
      runId: string,
      intent: Intent,
      result: IntentResult,
    ) => Stream.Stream<NewFact>;
  }
>()("t3/bots/workflows/Interpreter/WorkflowInterpreter") {}
