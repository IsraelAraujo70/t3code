import { assert, describe, it } from "@effect/vitest";
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  type AuthEnvironmentScope,
  BOTS_WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as RpcTest from "effect/rpc/RpcTest";

import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import { rpcInstrumentationLayer } from "../observability/RpcInstrumentation.ts";
import * as BotsService from "./BotsService.ts";
import * as Dictation from "./dictation/Dictation.ts";
import * as BotsRpc from "./rpcHandlers.ts";
import * as VoiceSession from "./voice/VoiceSession.ts";

const connect = (scopes: ReadonlyArray<AuthEnvironmentScope>, calls: Array<string>) =>
  RpcTest.makeClient(BotsRpc.ServerBotsRpcGroup).pipe(
    Effect.provide(
      Layer.mergeAll(
        BotsRpc.layerHandlers.pipe(
          Layer.provide(
            Layer.mock(BotsService.BotsService)({
              updateOwner: (input) =>
                Effect.sync(() => {
                  calls.push(input.aboutMe);
                  return input;
                }),
              registerPushDevice: (input) =>
                Effect.sync(() => {
                  calls.push(`register ${input.token} ${input.label ?? "-"}`);
                  return { token: input.token };
                }),
              unregisterPushDevice: (input) =>
                Effect.sync(() => {
                  calls.push(`unregister ${input.token}`);
                  return input;
                }),
            }),
          ),
          Layer.provide(Layer.mock(Dictation.Dictation)({})),
          Layer.provide(Layer.mock(VoiceSession.VoiceSessions)({})),
        ),
        RpcAuthorization.layer(scopes),
        rpcInstrumentationLayer,
      ),
    ),
    Effect.provideService(Metric.MetricRegistry, new Map()),
  );

describe("bots RPC handler layer", () => {
  it.effect("serves bots RPCs through BotsService behind scope authorization", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const operator = yield* connect(
        [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
        calls,
      );
      assert.deepStrictEqual(yield* operator[BOTS_WS_METHODS.ownerUpdate]({ aboutMe: "Ada" }), {
        aboutMe: "Ada",
      });

      const reader = yield* connect([AuthOrchestrationReadScope], calls);
      const rejection = yield* reader[BOTS_WS_METHODS.ownerUpdate]({ aboutMe: "Eve" }).pipe(
        Effect.flip,
      );
      assert.equal(rejection._tag, "EnvironmentAuthorizationError");
      assert.deepStrictEqual(calls, ["Ada"]);
    }).pipe(Effect.scoped),
  );

  it.effect("registers and unregisters push devices for operators only", () =>
    Effect.gen(function* () {
      const calls: Array<string> = [];
      const operator = yield* connect(
        [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
        calls,
      );
      assert.deepStrictEqual(
        yield* operator[BOTS_WS_METHODS.pushDeviceRegister]({ token: "fcm-1", label: "Pixel" }),
        { token: "fcm-1" },
      );
      assert.deepStrictEqual(
        yield* operator[BOTS_WS_METHODS.pushDeviceUnregister]({ token: "fcm-1" }),
        { token: "fcm-1" },
      );

      const reader = yield* connect([AuthOrchestrationReadScope], calls);
      const rejection = yield* reader[BOTS_WS_METHODS.pushDeviceRegister]({ token: "fcm-2" }).pipe(
        Effect.flip,
      );
      assert.equal(rejection._tag, "EnvironmentAuthorizationError");
      assert.deepStrictEqual(calls, ["register fcm-1 Pixel", "unregister fcm-1"]);
    }).pipe(Effect.scoped),
  );
});
