import { Context, Data, Effect, Layer, Option, Semaphore } from "effect";
import type { ProjectId, KanbanTicketId } from "@t3tools/contracts";
import { KanbanStore } from "../../kanban/KanbanStore.ts";
import { KanbanService } from "../../kanban/KanbanService.ts";
import type { CardColumn } from "./cardIntent.ts";

export class WorkflowCardError extends Data.TaggedError("WorkflowCardError")<{
  readonly message: string;
  readonly retryable: boolean;
}> {}
export class WorkflowCards extends Context.Service<
  WorkflowCards,
  {
    readonly upsert: (input: {
      runId: string;
      projectId: ProjectId;
      column: CardColumn;
      title: string;
      link: string;
    }) => Effect.Effect<{ ticketId: KanbanTicketId }, WorkflowCardError>;
  }
>()("t3/bots/workflows/card/WorkflowCards") {}

export const layer = Layer.effect(
  WorkflowCards,
  Effect.gen(function* () {
    const store = yield* KanbanStore;
    const kanban = yield* KanbanService;
    const permit = yield* Semaphore.make(1);
    return WorkflowCards.of({
      upsert: Effect.fn("WorkflowCards.upsert")(
        function* (input) {
          if (Option.isSome(yield* store.getLink(input.projectId))) {
            return yield* new WorkflowCardError({
              message: "the project is linked to Linear",
              retryable: false,
            });
          }
          const marker = `wf-run:${input.runId}`;
          for (const ticket of yield* store.listTickets) {
            if (ticket.projectId !== input.projectId || ticket.status.kind !== "local") continue;
            const description = yield* store.getLocalDescription(ticket.id);
            if (Option.isNone(description) || !description.value.split("\n").includes(marker))
              continue;
            if (ticket.status.state !== input.column)
              yield* kanban.moveTicket({
                ticketId: ticket.id,
                to: { kind: "local", state: input.column },
              });
            return { ticketId: ticket.id };
          }
          const ticket = yield* kanban.createTicket({
            projectId: input.projectId,
            title: input.title,
            description: `${marker}\n${input.link}`,
            state: input.column,
          });
          return { ticketId: ticket.id };
        },
        Effect.mapError((error) =>
          error instanceof WorkflowCardError
            ? error
            : new WorkflowCardError({ message: error.message, retryable: true }),
        ),
        permit.withPermits(1),
      ),
    });
  }),
);
