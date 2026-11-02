/**
 * Workflows (friend fork) data access for one environment: the only module that talks to the
 * `bots.workflows.*` RPCs. Web and mobile bind it once each against their connection runtime.
 */
import { BOTS_WS_METHODS, type WorkflowRunView } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "./connection/registry.ts";
import { request, subscribe } from "./rpc/client.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
  createEnvironmentSubscriptionAtomFamily,
} from "./state/runtime.ts";
import { foldRunDelta } from "./workflows.run.ts";

const M = BOTS_WS_METHODS;

export function createWorkflowsEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  // Definition writes to one environment apply in order: a save never lands before the create.
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { environmentId: string }) => environmentId,
  };
  return {
    /** Workflows, deleted ones and templates; refreshed on every change. */
    snapshot: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:workflows:snapshot",
      tag: M.workflowsSubscribe,
    }),
    /** One file as on disk; emits after every save from any writer and every hand edit. */
    document: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:workflows:document",
      tag: M.workflowsDocumentSubscribe,
    }),
    /**
     * A run: `run.get` once, then the `run.subscribe` deltas folded in. Reconnecting starts over
     * from `run.get`, so a missed delta never leaves the view behind.
     */
    run: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:workflows:run",
      subscribe: (input: { readonly runId: WorkflowRunView["summary"]["runId"] }) =>
        Stream.unwrap(
          request(M.workflowsRunGet, { runId: input.runId }).pipe(
            // `scan` emits `view` first, then each folded delta.
            Effect.map((view) =>
              subscribe(M.workflowsRunSubscribe, { runId: input.runId, afterSeq: view.seq }).pipe(
                Stream.scan(() => view, foldRunDelta),
              ),
            ),
          ),
        ),
    }),
    validate: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:workflows:validate",
      tag: M.workflowsValidate,
    }),
    history: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:workflows:history",
      tag: M.workflowsHistory,
    }),
    runs: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:workflows:runs",
      tag: M.workflowsRunsList,
    }),
    step: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:workflows:step",
      tag: M.workflowsRunStep,
    }),
    metrics: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:workflows:metrics",
      tag: M.workflowsMetrics,
    }),
    ledger: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:workflows:ledger",
      tag: M.workflowsLedger,
    }),
    save: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workflows:save",
      tag: M.workflowsSave,
      scheduler,
      concurrency,
    }),
    fromTemplate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workflows:from-template",
      tag: M.workflowsFromTemplate,
      scheduler,
      concurrency,
    }),
    setEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workflows:set-enabled",
      tag: M.workflowsSetEnabled,
      scheduler,
      concurrency,
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workflows:delete",
      tag: M.workflowsDelete,
      scheduler,
      concurrency,
    }),
    restore: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:workflows:restore",
      tag: M.workflowsRestore,
      scheduler,
      concurrency,
    }),
    // Runs are independent of definition writes and of each other.
    runStart: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:workflows:run-start",
      tag: M.workflowsRunStart,
    }),
    runControl: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:workflows:run-control",
      tag: M.workflowsRunControl,
    }),
    gateDecide: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:workflows:gate-decide",
      tag: M.workflowsGateDecide,
    }),
  };
}

export type WorkflowsEnvironmentAtoms = ReturnType<typeof createWorkflowsEnvironmentAtoms>;
