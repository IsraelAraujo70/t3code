/**
 * The kanban side of a visible step thread (`thread: { visible: true, kanbanCard }`): reading the
 * card's issue for the thread's first message, and linking the thread to the card. Unlike the
 * KanbanThreadStarter it creates no thread; the engine launches it under a deterministic id.
 */
import { Context, Data, Effect, Layer, Option } from "effect";
import { KanbanTicketId, ThreadId } from "@t3tools/contracts";

import { buildTicketThreadMessage } from "../../kanban/KanbanThreadStarter.ts";
import { KanbanService } from "../../kanban/KanbanService.ts";

class WorkflowTicketError extends Data.TaggedError("WorkflowTicketError")<{
  readonly message: string;
  readonly retryable: boolean;
}> {}

interface WorkflowTicket {
  readonly ticketId: string;
  /** `<identifier> <title>`, as a thread started from the card is named. */
  readonly title: string;
  /** The card's issue, as `buildTicketThreadMessage` writes it for a thread started from the card. */
  readonly message: string;
}

export class WorkflowTickets extends Context.Service<
  WorkflowTickets,
  {
    /** A ticket by id, or by identifier (`BACK-222`, case-insensitive). */
    readonly read: (ref: string) => Effect.Effect<WorkflowTicket, WorkflowTicketError>;
    /** Idempotent: linking a thread already linked changes nothing. */
    readonly link: (input: {
      readonly ticketId: string;
      readonly threadId: string;
    }) => Effect.Effect<void, WorkflowTicketError>;
  }
>()("t3/bots/workflows/card/WorkflowTickets") {}

const MAX_MESSAGE_CHARS = 30_000;

export const layer = Layer.effect(
  WorkflowTickets,
  Effect.gen(function* () {
    const kanban = yield* KanbanService;
    const failure = (message: string) => (cause: { readonly message: string }) =>
      new WorkflowTicketError({ message: `${message}: ${cause.message}`, retryable: true });
    return WorkflowTickets.of({
      read: Effect.fn("WorkflowTickets.read")(function* (ref: string) {
        const snapshot = yield* kanban.readSnapshot.pipe(
          Effect.mapError(failure("Could not read the kanban")),
        );
        const wanted = ref.trim().toLowerCase();
        const ticket =
          snapshot.tickets.find((t) => t.id === ref.trim()) ??
          snapshot.tickets.find((t) => t.identifier.toLowerCase() === wanted);
        if (ticket === undefined)
          return yield* new WorkflowTicketError({
            message: `There is no kanban ticket ${ref}.`,
            retryable: false,
          });
        // The thread still starts without the description when it cannot be read.
        const detail = yield* kanban.ticketDetail({ ticketId: ticket.id }).pipe(Effect.option);
        const description = Option.match(detail, {
          onNone: () => null,
          onSome: (value) => value.description,
        });
        return {
          ticketId: ticket.id,
          title: `${ticket.identifier} ${ticket.title}`,
          message: buildTicketThreadMessage(ticket, description, undefined).slice(
            0,
            MAX_MESSAGE_CHARS,
          ),
        };
      }),
      link: Effect.fn("WorkflowTickets.link")(function* (input) {
        yield* kanban
          .linkThread({
            ticketId: KanbanTicketId.make(input.ticketId),
            threadId: ThreadId.make(input.threadId),
          })
          .pipe(Effect.mapError(failure("Could not link the thread to its card")));
      }),
    });
  }),
);
