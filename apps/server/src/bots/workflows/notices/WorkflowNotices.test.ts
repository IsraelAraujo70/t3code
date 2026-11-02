import { EnvironmentId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerEnvironment } from "../../../environment/ServerEnvironment.ts";
import * as BotsStore from "../../BotsStore.ts";
import { BotPushDelivery, type BotPushData } from "../../push/BotPushDelivery.ts";
import { failedNotice } from "./notices.ts";
import { WorkflowNotices, layer } from "./WorkflowNotices.ts";

it.effect("delivers the notice to the owner's devices with environment and clock", () => {
  const received: BotPushData[] = [];
  return Effect.gen(function* () {
    yield* (yield* WorkflowNotices).deliver({
      runId: "r",
      workflowId: "w",
      notice: failedNotice("Title", "r", "failed"),
    });
    assert.deepStrictEqual(received, [
      {
        t3_kind: "bot_message",
        alert_id: "wf:r:notify:end",
        alert_title: "Title",
        alert_body: "The run failed.",
        alert_path: "/bots/workflows/env/runs/r",
        alert_group: "wf:w",
        sent_at: "0",
      },
    ]);
  }).pipe(
    Effect.provide(
      layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            BotsStore.layerMemory,
            Layer.succeed(ServerEnvironment, {
              getEnvironmentId: Effect.succeed(EnvironmentId.make("env")),
              getDescriptor: Effect.die("unused"),
            }),
            Layer.succeed(BotPushDelivery, {
              enabled: true,
              deliver: (data, audience) =>
                Effect.gen(function* () {
                  received.push(data);
                  assert.deepStrictEqual(yield* audience.devices.pipe(Effect.orDie), []);
                  assert.deepStrictEqual(audience.notification, {
                    title: "Title",
                    body: "The run failed.",
                  });
                  yield* audience.drop("expired").pipe(Effect.orDie);
                }),
            }),
          ),
        ),
      ),
    ),
  );
});
