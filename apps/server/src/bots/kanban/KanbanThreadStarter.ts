/**
 * Starts work on a ticket: a new thread in its T3 project, or a message to a bot's conversation,
 * carrying the issue as context, then links that thread to the ticket. Kept apart from
 * KanbanService because it needs the orchestration runtime, which the kanban's store and sync do not.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  KanbanError,
  type KanbanTicketStartThreadInput,
  type KanbanTicketStartThreadResult,
} from "@t3tools/contracts";

export class KanbanThreadStarter extends Context.Service<
  KanbanThreadStarter,
  {
    readonly startThread: (
      input: KanbanTicketStartThreadInput,
    ) => Effect.Effect<KanbanTicketStartThreadResult, KanbanError>;
  }
>()("t3/bots/kanban/KanbanThreadStarter") {}

export const layerLive = Layer.succeed(
  KanbanThreadStarter,
  KanbanThreadStarter.of({
    startThread: Effect.fn("KanbanThreadStarter.startThread")(() =>
      Effect.fail(new KanbanError({ message: "Starting a thread is not implemented yet." })),
    ),
  }),
);
