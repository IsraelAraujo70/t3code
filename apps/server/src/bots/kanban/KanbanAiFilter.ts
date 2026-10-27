/**
 * Turns a sentence ("my urgent bugs in progress") into kanban filter clauses with a small model
 * through the server's OpenRouter key, the same key dictation uses. The answer is decoded as
 * `KanbanFilterClause`s; nothing the model says reaches the board unchecked.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  KanbanError,
  type KanbanAiFilterInput,
  type KanbanAiFilterResult,
} from "@t3tools/contracts";

export class KanbanAiFilter extends Context.Service<
  KanbanAiFilter,
  {
    readonly filter: (
      input: KanbanAiFilterInput,
    ) => Effect.Effect<KanbanAiFilterResult, KanbanError>;
  }
>()("t3/bots/kanban/KanbanAiFilter") {}

export const layerLive = Layer.succeed(
  KanbanAiFilter,
  KanbanAiFilter.of({
    filter: Effect.fn("KanbanAiFilter.filter")(() =>
      Effect.fail(new KanbanError({ message: "AI filter is not implemented yet." })),
    ),
  }),
);
