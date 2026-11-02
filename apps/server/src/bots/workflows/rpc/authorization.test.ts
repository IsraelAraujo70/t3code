import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  RpcScopeAuthorization,
  WORKFLOWS_RPCS,
  WORKFLOWS_WS_METHODS as M,
  WorkflowRunId,
  WorkflowId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import { RpcGroup } from "effect/rpc";
import * as RpcTest from "effect/rpc/RpcTest";

import * as RpcAuthorization from "../../../auth/RpcAuthorization.ts";

const group = RpcGroup.make(...WORKFLOWS_RPCS)
  .omit(
    ...WORKFLOWS_RPCS.map((rpc) => rpc._tag).filter(
      (tag) =>
        tag !== M.workflowsValidate &&
        tag !== M.workflowsGateDecide &&
        tag !== M.workflowsTriggerSample &&
        tag !== M.workflowsTriggerListen,
    ),
  )
  .middleware(RpcScopeAuthorization);

describe("workflow RPC authorization", () => {
  it.effect("a read-only session validates but never reaches a gate decision", () =>
    Effect.gen(function* () {
      const decided: Array<string> = [];
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(M.workflowsValidate, () =>
              Effect.succeed({ diagnostics: [], normalizedSource: null, semanticHash: null }),
            ),
            group.toLayerHandler(M.workflowsGateDecide, (input) =>
              Effect.sync(() => decided.push(input.gateKey)).pipe(
                Effect.andThen(Effect.die("a read-only session reached the gate handler")),
              ),
            ),
            group.toLayerHandler(M.workflowsTriggerSample, () => Effect.succeed(null)),
            group.toLayerHandler(M.workflowsTriggerListen, () =>
              Stream.die("read-only listen reached handler"),
            ),
            RpcAuthorization.layer([AuthOrchestrationReadScope]),
          ),
        ),
      );

      expect((yield* client[M.workflowsValidate]({ source: "schema: x" })).diagnostics).toEqual([]);
      expect(
        yield* client[M.workflowsGateDecide]({
          runId: WorkflowRunId.make("wfr_0123456789abcdef0123"),
          gateKey: "deploy",
          option: "approve",
        }).pipe(Effect.flip),
      ).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: AuthOrchestrationOperateScope,
      });
      const ref = { workflowId: WorkflowId.make("inbox"), triggerId: "push" };
      expect(yield* client[M.workflowsTriggerSample](ref)).toBeNull();
      expect(
        yield* client[M.workflowsTriggerListen](ref).pipe(Stream.runCollect, Effect.flip),
      ).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: AuthOrchestrationOperateScope,
      });
      expect(decided).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it("guards every write, run and gate decision with operate and nothing weaker", () => {
    for (const method of [
      M.workflowsSave,
      M.workflowsFromTemplate,
      M.workflowsSetEnabled,
      M.workflowsDelete,
      M.workflowsRestore,
      M.workflowsRunStart,
      M.workflowsRunControl,
      M.workflowsGateDecide,
    ]) {
      expect(RpcAuthorization.RPC_REQUIRED_SCOPES[method]).toBe(AuthOrchestrationOperateScope);
    }
  });
});
