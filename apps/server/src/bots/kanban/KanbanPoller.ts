/**
 * Polls Linear for every linked project. The bots host has no public URL for Linear's webhooks
 * (only the tailnet), so changes made in Linear arrive by polling: one incremental query per link
 * and interval, asking only for issues updated since the link's cursor, and a full re-read every
 * 30 minutes. `T3CODE_KANBAN_POLL_SECONDS` sets the interval (default 60); 0 turns polling off.
 */
import * as Config from "effect/Config";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { KanbanService } from "./KanbanService.ts";

export const KANBAN_POLL_ENV = "T3CODE_KANBAN_POLL_SECONDS";
const DEFAULT_POLL_SECONDS = 60;

export const layerStart = Layer.effectDiscard(
  Effect.gen(function* () {
    const kanban = yield* KanbanService;
    const seconds = yield* Config.Int(KANBAN_POLL_ENV).pipe(
      Config.withDefault(DEFAULT_POLL_SECONDS),
      Effect.orElseSucceed(() => DEFAULT_POLL_SECONDS),
    );
    if (seconds <= 0) return;
    const tick = kanban.poll.pipe(
      Effect.catch((error) => Effect.logWarning("Kanban poll failed", error.message)),
    );
    yield* Effect.sleep(Duration.seconds(seconds)).pipe(
      Effect.andThen(tick),
      Effect.forever,
      Effect.forkScoped,
    );
  }),
);
