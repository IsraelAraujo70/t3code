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
import { foldRunDelta, joinRunPages } from "./workflows.run.ts";

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
     * A run: every `run.get` page once, then the `run.subscribe` deltas folded in. Reconnecting
     * starts over from `run.get`, so a missed delta never leaves the view behind.
     */
    run: createEnvironmentSubscriptionAtomFamily(runtime, {
      label: "environment-data:workflows:run",
      subscribe: (input: { readonly runId: WorkflowRunView["summary"]["runId"] }) =>
        followRun(input.runId),
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

type RunId = WorkflowRunView["summary"]["runId"];
type StepsCursor = NonNullable<WorkflowRunView["nextStepsCursor"]>;
const readRun = (runId: RunId, stepsCursor?: StepsCursor) =>
  request(M.workflowsRunGet, stepsCursor === undefined ? { runId } : { runId, stepsCursor });
type RunRead = ReturnType<typeof readRun>;
type RunReadOf<A> = Effect.Effect<A, Effect.Error<RunRead>, Effect.Services<RunRead>>;
type RunPages = readonly [WorkflowRunView, ...WorkflowRunView[]];
/**
 * Every `run.get` page joined, so no screen ever sees a partial set of attempts (a node's status
 * would read as pending).
 */
const readWholeRun = (runId: RunId): RunReadOf<WorkflowRunView> => {
  const morePages = (pages: RunPages): RunReadOf<RunPages> => {
    const cursor = pages[pages.length - 1]!.nextStepsCursor;
    return cursor === null
      ? Effect.succeed(pages)
      : readRun(runId, cursor).pipe(Effect.flatMap((page) => morePages([...pages, page])));
  };
  return readRun(runId).pipe(
    Effect.flatMap((first) => morePages([first])),
    Effect.map(joinRunPages),
  );
};
const runDeltas = (runId: RunId, afterSeq: number) =>
  subscribe(M.workflowsRunSubscribe, { runId, afterSeq });
type RunStream = Stream.Stream<
  WorkflowRunView,
  Effect.Error<RunRead> | Stream.Error<ReturnType<typeof runDeltas>>,
  Effect.Services<RunRead> | Stream.Services<ReturnType<typeof runDeltas>>
>;
/**
 * The whole run, then its deltas. Deltas never carry the definition, so a run read while still
 * queued is read again once it pins its version (its `commit` appears), and followed from there.
 */
const followRun = (runId: RunId): RunStream =>
  Stream.unwrap(
    readWholeRun(runId).pipe(
      Effect.map((view): RunStream => {
        // `scan` emits `view` first, then each folded delta.
        const deltas = runDeltas(runId, view.seq).pipe(Stream.scan(() => view, foldRunDelta));
        if (view.definition !== null || view.summary.commit !== null) return deltas;
        return deltas.pipe(
          Stream.takeUntil((next) => next.summary.commit !== null),
          Stream.concat(Stream.suspend(() => followRun(runId))),
        );
      }),
    ),
  );

export type WorkflowsEnvironmentAtoms = ReturnType<typeof createWorkflowsEnvironmentAtoms>;
