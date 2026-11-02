import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerEnvironment } from "../../../environment/ServerEnvironment.ts";
import * as KanbanStore from "../../kanban/KanbanStore.ts";
import * as BotPushDelivery from "../../push/BotPushDelivery.ts";
import * as WorkflowCards from "../card/WorkflowCards.ts";
import * as BotPosts from "../publish/BotPosts.ts";
import * as PullRequests from "../publish/PullRequests.ts";
import { workflowPushData, type NotifyIntent } from "./notices.ts";

export class WorkflowNotices extends Context.Service<
  WorkflowNotices,
  {
    readonly deliver: (input: {
      readonly runId: string;
      readonly workflowId: string;
      readonly notice: NotifyIntent;
    }) => Effect.Effect<void>;
  }
>()("t3/bots/workflows/notices/WorkflowNotices") {}

export const layer = Layer.effect(
  WorkflowNotices,
  Effect.gen(function* () {
    const environment = yield* ServerEnvironment;
    const delivery = yield* BotPushDelivery.BotPushDelivery;
    const deliver = Effect.fn("WorkflowNotices.deliver")(
      function* (input: {
        readonly runId: string;
        readonly workflowId: string;
        readonly notice: NotifyIntent;
      }) {
        const environmentId = yield* environment.getEnvironmentId;
        const sentAt = yield* Clock.currentTimeMillis;
        yield* delivery.deliver(
          workflowPushData(input.notice, { ...input, environmentId, sentAt }),
        );
      },
      Effect.catchCause((cause) => Effect.logWarning("workflow notice delivery failed", { cause })),
    );
    return { deliver };
  }),
);

/**
 * Notices, the run's card, pull requests and posts to the bound bot, as the host interpreter reads
 * them (wf-engine slice 8). Provided where BotsStore, ServerEnvironment, KanbanService and the
 * orchestrator already exist.
 */
export const deliveryLayer = Layer.mergeAll(
  layer.pipe(Layer.provide(BotPushDelivery.layer)),
  WorkflowCards.layer.pipe(Layer.provide(KanbanStore.layer)),
  PullRequests.layer,
  BotPosts.layer,
);
