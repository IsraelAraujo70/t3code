/**
 * Pushes to the user's phones when a bot replies or waits on them. It follows only the live
 * event tail: a restart never resends what was already news before it. Pushes run beside the
 * stream, so a slow FCM never holds up the next event.
 */
import {
  parseBotThreadId,
  type Bot,
  type GuestId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { forkParked } from "../../serverActivation.ts";
import { BotsStore } from "../BotsStore.ts";
import { GuestStore } from "../guest/GuestStore.ts";
import * as BotPushDelivery from "./BotPushDelivery.ts";
import type { BotPushData } from "./BotPushDelivery.ts";
import {
  botPushData,
  botPushNotice,
  guestPushData,
  type BotPushChange,
  type BotPushNotice,
} from "./botPushNotice.ts";

/** Keys remembered so a repeated event never pushes twice; old ones are long settled. */
const MAX_SENT_KEYS = 512;

export class BotPushReactor extends Context.Service<
  BotPushReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Returns once the push, if any, is handed off; it does not wait for FCM. */
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/bots/push/BotPushReactor") {}

/** One push to send: its payload and the phones it goes to. */
export interface BotPushSend {
  readonly data: BotPushData;
  readonly audience: BotPushDelivery.BotPushAudience;
}

/**
 * Every party to the bot gets the push: the owner always (T3's data-only push, on the owner's
 * phones), and the guest the bot is shared with, if any (a minimal payload with a visible
 * notification, on the guest's phones). Rejected tokens are dropped from their own registry.
 */
export function pushesFor(
  bot: Pick<Bot, "name">,
  guestId: Option.Option<GuestId>,
  notice: BotPushNotice,
  ownerData: BotPushData,
  store: Pick<BotsStore["Service"], "listPushDevices" | "deletePushDevice">,
  guests: Pick<GuestStore["Service"], "listPushDevices" | "deletePushDevice">,
): ReadonlyArray<BotPushSend> {
  const owner: BotPushSend = {
    data: ownerData,
    audience: { devices: store.listPushDevices, drop: store.deletePushDevice },
  };
  if (Option.isNone(guestId)) return [owner];
  const id = guestId.value;
  return [
    owner,
    {
      data: guestPushData(notice),
      audience: {
        devices: guests.listPushDevices(id),
        drop: (token) => guests.deletePushDevice(id, token),
        notification: { title: bot.name, body: notice.body },
      },
    },
  ];
}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const store = yield* BotsStore;
  const guests = yield* GuestStore;
  const delivery = yield* BotPushDelivery.BotPushDelivery;
  const environmentId = yield* (yield* ServerEnvironment.ServerEnvironment).getEnvironmentId;
  const scope = yield* Effect.scope;
  const sent = new Set<string>();

  const remember = (key: string) => {
    sent.add(key);
    if (sent.size > MAX_SENT_KEYS) sent.delete(sent.values().next().value!);
  };

  /** The projection reads a change needs; null skips the reads when it cannot push. */
  const changeOf = Effect.fn("BotPushReactor.changeOf")(function* (
    event: OrchestrationV2DomainEvent,
  ) {
    if (event.type === "run.updated") {
      const run = event.payload;
      if (run.status !== "completed") return null;
      const trigger = yield* projections.getRunMessage(event.threadId, run.id);
      const { messages } = yield* projections.getThreadRecords(event.threadId, ["messages"], {
        messageRunIds: [run.id],
        messageRoles: ["assistant"],
      });
      return { type: "run", run, trigger, replies: messages } satisfies BotPushChange;
    }
    if (event.type !== "runtime-request.updated") return null;
    if (event.payload.status !== "pending") return null;
    // Read the stored request: the event may be older than an answer already recorded.
    const stored = yield* projections.getRuntimeResponseContext(event.threadId, event.payload.id);
    return {
      type: "request",
      request: stored.request ?? event.payload,
      item: stored.item,
    } satisfies BotPushChange;
  });

  const handle: BotPushReactor["Service"]["handle"] = Effect.fn("BotPushReactor.handle")(
    function* (event) {
      const parsed = parseBotThreadId(event.threadId);
      if (parsed === null) return;
      const change = yield* changeOf(event);
      if (change === null) return;
      const bot = Option.getOrUndefined(yield* store.getBot(parsed.botId));
      const notice = botPushNotice(event.threadId, bot, change);
      if (notice === null || bot === undefined || sent.has(notice.key)) return;
      remember(notice.key);
      const ownerData = botPushData(notice, {
        botName: bot.name,
        environmentId,
        sentAt: yield* Clock.currentTimeMillis,
      });
      const guestId = yield* guests.guestOfBot(bot.id);
      for (const push of pushesFor(bot, guestId, notice, ownerData, store, guests)) {
        yield* Effect.forkIn(delivery.deliver(push.data, push.audience), scope);
      }
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("handling a bot push event failed", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  const start: BotPushReactor["Service"]["start"] = () =>
    delivery.enabled
      ? forkParked(
          Stream.runForEach(engine.streamDomainEvents, handle).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("bot push event stream failed", { cause }),
            ),
          ),
        )
      : Effect.void;

  return { start, handle } satisfies BotPushReactor["Service"];
});

const layer = Layer.effect(BotPushReactor, make);

/** Starts the reactor with the server; it stays idle when push is off. */
export const layerStart = Layer.effectDiscard(
  Effect.gen(function* () {
    const reactor = yield* BotPushReactor;
    yield* reactor.start();
  }),
).pipe(
  Layer.provide(layer),
  Layer.provide(BotPushDelivery.layer),
  Layer.provide(ProjectionStore.layer),
);
