/** Which version of a workflow runs: the definitions service (slice 5) implements this. */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { CompiledWorkflow } from "@t3tools/shared/workflows";

import type { WorkflowJournalError } from "./Journal.ts";

export interface PinnedVersion {
  readonly workflowId: string;
  readonly commit: string;
  readonly compiled: CompiledWorkflow;
}

/** What the workflow decider needs to turn a TriggerFired into a run. */
export type CurrentVersion =
  | {
      readonly _tag: "Ready";
      readonly version: PinnedVersion;
      readonly enabled: boolean;
      readonly suspended: boolean;
      /** Triggers switched off on their own (`WorkflowStatus.off`). */
      readonly off: ReadonlySet<string>;
    }
  | { readonly _tag: "Invalid" }
  | { readonly _tag: "Missing" };

export class WorkflowCatalog extends Context.Service<
  WorkflowCatalog,
  {
    readonly current: (workflowId: string) => Effect.Effect<CurrentVersion, WorkflowJournalError>;
    /** The version a run pinned in RunStarted; never the HEAD of the definitions repository. */
    readonly pinned: (
      workflowId: string,
      commit: string,
    ) => Effect.Effect<PinnedVersion, WorkflowJournalError>;
    /** Workflows with a `workflowFailed` trigger on `workflowId` (or on any workflow). */
    readonly failureSubscribers: (workflowId: string) => Effect.Effect<
      ReadonlyArray<{
        readonly workflowId: string;
        readonly triggerId: string;
        readonly params?: Readonly<Record<string, string>>;
      }>,
      WorkflowJournalError
    >;
  }
>()("t3/bots/workflows/Catalog/WorkflowCatalog") {}
