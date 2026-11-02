import * as Context from "effect/Context";

import { WORKFLOWS_WS_METHODS as M, WorkflowsError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { WorkflowEngine } from "../WorkflowEngine.ts";
import type { WorkflowJournalError } from "../Journal.ts";
import * as Stream from "effect/Stream";

import { WorkflowDefinitions } from "../definitions/WorkflowDefinitions.ts";

const unavailable = new WorkflowsError({
  code: "unavailable",
  message: "Workflows are not available on this server yet.",
});
const operationError = (cause: WorkflowJournalError) =>
  new WorkflowsError({ code: "internal", message: "Workflow run operation failed.", cause });

export const handlers = Effect.gen(function* () {
  const definitions = yield* WorkflowDefinitions;
  const engine = yield* Effect.serviceOption(WorkflowEngine);
  const execute = <A>(
    operation: (
      service: Context.Service.Shape<typeof WorkflowEngine>,
    ) => Effect.Effect<A, WorkflowJournalError>,
  ) =>
    Option.isSome(engine)
      ? operation(engine.value).pipe(Effect.mapError(operationError))
      : Effect.fail(unavailable);
  return {
    [M.workflowsSubscribe]: () => definitions.snapshot,
    [M.workflowsDocumentSubscribe]: (input: { readonly workflowId: string }) =>
      definitions.documentChanges(input.workflowId),
    [M.workflowsValidate]: definitions.validate,
    [M.workflowsSave]: (input: Parameters<typeof definitions.save>[0]) =>
      definitions.save(input, { kind: "user" }),
    [M.workflowsFromTemplate]: (input: Parameters<typeof definitions.fromTemplate>[0]) =>
      definitions.fromTemplate(input, { kind: "user" }),
    [M.workflowsSetEnabled]: (input: Parameters<typeof definitions.setEnabled>[0]) =>
      definitions.setEnabled(input, { kind: "user" }),
    [M.workflowsDelete]: (input: Parameters<typeof definitions.delete>[0]) =>
      definitions.delete(input, { kind: "user" }),
    [M.workflowsRestore]: (input: Parameters<typeof definitions.restore>[0]) =>
      definitions.restore(input, { kind: "user" }),
    [M.workflowsHistory]: definitions.history,
    [M.workflowsRunStart]: (
      input: Parameters<Context.Service.Shape<typeof WorkflowEngine>["startRun"]>[0],
    ) => execute((engine) => engine.startRun(input, "Owner")),
    [M.workflowsRunsList]: (
      input: Parameters<Context.Service.Shape<typeof WorkflowEngine>["listRuns"]>[0],
    ) => execute((engine) => engine.listRuns(input)),
    [M.workflowsRunGet]: (
      input: Parameters<Context.Service.Shape<typeof WorkflowEngine>["runView"]>[0],
    ) => execute((engine) => engine.runView(input)),
    [M.workflowsRunSubscribe]: (
      input: Parameters<Context.Service.Shape<typeof WorkflowEngine>["subscribeRun"]>[0],
    ) =>
      Option.isSome(engine)
        ? engine.value.subscribeRun(input).pipe(Stream.mapError(operationError))
        : Stream.fail(unavailable),
    [M.workflowsRunStep]: (
      input: Parameters<Context.Service.Shape<typeof WorkflowEngine>["stepDetail"]>[0],
    ) => execute((engine) => engine.stepDetail(input)),
    [M.workflowsRunControl]: (
      input: Parameters<Context.Service.Shape<typeof WorkflowEngine>["controlRun"]>[0],
    ) => execute((engine) => engine.controlRun(input, "Owner")),
    [M.workflowsGateDecide]: (
      input: Parameters<Context.Service.Shape<typeof WorkflowEngine>["gateDecide"]>[0],
    ) => execute((engine) => engine.gateDecide(input)),
    [M.workflowsMetrics]: (
      input: Parameters<Context.Service.Shape<typeof WorkflowEngine>["metrics"]>[0],
    ) => execute((engine) => engine.metrics(input)),
    // Triggers n1 stubs: the trigger payload, samples and test mode land with their services.
    [M.workflowsRunTrigger]: () => Effect.fail(unavailable),
    [M.workflowsTriggerSample]: () => Effect.fail(unavailable),
    [M.workflowsTriggerListen]: () => Stream.fail(unavailable),
    [M.workflowsLedger]: (
      input: Parameters<Context.Service.Shape<typeof WorkflowEngine>["ledger"]>[0],
    ) => execute((engine) => engine.ledger(input)),
  };
});
