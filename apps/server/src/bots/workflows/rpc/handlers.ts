/**
 * The `bots.workflows.*` handlers, spread into the bots handler group. Each one calls one method of
 * `WorkflowDefinitions`; execution operations refuse as unavailable until the engine lands.
 */
import { WORKFLOWS_WS_METHODS as M, WorkflowsError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { WorkflowDefinitions } from "../definitions/WorkflowDefinitions.ts";

const unavailable = new WorkflowsError({
  code: "unavailable",
  message: "Workflows are not available on this server yet.",
});
const refuse = () => Effect.fail(unavailable);
const refuseStream = () => Stream.fail(unavailable);

export const handlers = Effect.gen(function* () {
  const definitions = yield* WorkflowDefinitions;
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
    [M.workflowsRunStart]: refuse,
    [M.workflowsRunsList]: refuse,
    [M.workflowsRunGet]: refuse,
    [M.workflowsRunSubscribe]: refuseStream,
    [M.workflowsRunStep]: refuse,
    [M.workflowsRunControl]: refuse,
    [M.workflowsGateDecide]: refuse,
    [M.workflowsMetrics]: refuse,
    [M.workflowsLedger]: refuse,
  };
});
