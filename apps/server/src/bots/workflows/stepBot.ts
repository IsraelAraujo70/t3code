/**
 * Which bot a workflow step thread works for, read from the engine's own journal: the thread's
 * `StartTurn` intent carries the bot of the run's pinned definition, and only `agent` turns carry
 * it. Nothing the caller controls takes part, so HostMcpForward can trust the answer.
 */
import {
  BotId,
  parseWorkflowItemThreadId,
  parseWorkflowStepThreadId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as BotsDb from "../BotsDb.ts";
import * as BotsStore from "../BotsStore.ts";
import { runStream } from "./facts.ts";

const isBotId = Schema.is(BotId);

export class WorkflowStepBots extends Context.Service<
  WorkflowStepBots,
  {
    /** The existing bot a step thread is bound to; none for any other thread or a deleted bot. */
    readonly botOf: (threadId: ThreadId) => Effect.Effect<Option.Option<BotId>>;
  }
>()("t3/bots/workflows/stepBot/WorkflowStepBots") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* BotsStore.BotsStore;
  const botOf = Effect.fn("WorkflowStepBots.botOf")(
    function* (threadId: ThreadId) {
      // A visible step thread (`wfi:`) works for the bot like a hidden one.
      const step = parseWorkflowStepThreadId(threadId) ?? parseWorkflowItemThreadId(threadId);
      if (step === null) return Option.none<BotId>();
      const rows = yield* sql<{ readonly bot: unknown }>`
        SELECT json_extract(payload_json, '$.intent.bot') AS bot FROM workflow_facts
        WHERE stream = ${runStream(step.runId)} AND kind = 'IntentRecorded'
          AND json_extract(payload_json, '$.intent._tag') = 'StartTurn'
          AND json_extract(payload_json, '$.intent.threadId') = ${threadId}
          AND json_extract(payload_json, '$.intent.bot') IS NOT NULL
        LIMIT 1`;
      const bot = rows[0]?.bot;
      if (!isBotId(bot)) return Option.none<BotId>();
      return Option.map(yield* store.getBot(bot), (found) => found.id);
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not read the bot of a workflow step.", { cause }).pipe(
        Effect.as(Option.none<BotId>()),
      ),
    ),
  );
  return WorkflowStepBots.of({ botOf });
});

/** Over an existing bots database and store. */
export const layerFromDb = Layer.effect(WorkflowStepBots, make);

export const layer = layerFromDb.pipe(Layer.provide(BotsDb.layer));
