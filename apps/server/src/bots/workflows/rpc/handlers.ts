/**
 * The `bots.workflows.*` handlers, spread into the bots handler group. Each one calls one method of
 * `WorkflowDefinitions` or `WorkflowEngine`; until those services land they refuse as unavailable.
 */
import { WORKFLOWS_WS_METHODS as M, WorkflowsError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

const unavailable = new WorkflowsError({
  code: "unavailable",
  message: "Workflows are not available on this server yet.",
});
const refuse = () => Effect.fail(unavailable);
const refuseStream = () => Stream.fail(unavailable);

export const handlers = Effect.succeed({
  [M.workflowsSubscribe]: refuseStream,
  [M.workflowsDocumentSubscribe]: refuseStream,
  [M.workflowsValidate]: refuse,
  [M.workflowsSave]: refuse,
  [M.workflowsFromTemplate]: refuse,
  [M.workflowsSetEnabled]: refuse,
  [M.workflowsDelete]: refuse,
  [M.workflowsRestore]: refuse,
  [M.workflowsHistory]: refuse,
  [M.workflowsRunStart]: refuse,
  [M.workflowsRunsList]: refuse,
  [M.workflowsRunGet]: refuse,
  [M.workflowsRunSubscribe]: refuseStream,
  [M.workflowsRunStep]: refuse,
  [M.workflowsRunControl]: refuse,
  [M.workflowsGateDecide]: refuse,
  [M.workflowsMetrics]: refuse,
  [M.workflowsLedger]: refuse,
});
