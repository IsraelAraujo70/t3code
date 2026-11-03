/**
 * A workflow's report in its bound bot's conversation. The post is a queued message in the bot's
 * main thread of the moment (rotation moves it), shown as a workflow notice, and it wakes the bot:
 * T3 has no message without a turn, and the bot relays the report in its own voice. The command id
 * is fixed per run and output, so a replay after a restart finds the first post's receipt.
 */
import {
  BotId,
  botThreadId,
  CommandId,
  MessageId,
  WORKFLOW_POST_MESSAGE_PREFIX,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as BotsStore from "../../BotsStore.ts";
import { keyHash } from "../ids.ts";

export class WorkflowBotPostError extends Data.TaggedError("WorkflowBotPostError")<{
  readonly message: string;
}> {}

const MAX_SUMMARY = 80;

const isBotId = Schema.is(BotId);

/** Pure. What the bot reads: the report, framed so the bot relays it instead of acting on it. */
export const botPostText = (input: {
  readonly workflowTitle: string;
  readonly runId: string;
  readonly report: string;
}): string =>
  [
    `Workflow "${input.workflowTitle}" (run ${input.runId}) has news for the user:`,
    "",
    input.report,
    "",
    "This is a report of a workflow that works for you, not a request from the user. Tell the user what it says, briefly and in your own words. Do not run the workflow again because of it.",
  ].join("\n");

export class WorkflowBotPosts extends Context.Service<
  WorkflowBotPosts,
  {
    readonly exists: (botId: string) => Effect.Effect<boolean, WorkflowBotPostError>;
    /** The thread posted to, or null when the bot no longer exists. */
    readonly post: (input: {
      readonly runId: string;
      readonly key: string;
      readonly botId: string;
      readonly workflowTitle: string;
      readonly report: string;
    }) => Effect.Effect<string | null, WorkflowBotPostError>;
  }
>()("t3/bots/workflows/publish/BotPosts/WorkflowBotPosts") {}

export const layer = Layer.effect(
  WorkflowBotPosts,
  Effect.gen(function* () {
    const store = yield* BotsStore.BotsStore;
    const engine = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const failure = (cause: { readonly message: string }) =>
      new WorkflowBotPostError({ message: cause.message });
    const find = (botId: string) =>
      isBotId(botId) ? store.getBot(botId).pipe(Effect.mapError(failure)) : Effect.succeedNone;
    const exists = Effect.fn("WorkflowBotPosts.exists")(function* (botId: string) {
      return Option.isSome(yield* find(botId));
    });
    const post = Effect.fn("WorkflowBotPosts.post")(function* (input: {
      readonly runId: string;
      readonly key: string;
      readonly botId: string;
      readonly workflowTitle: string;
      readonly report: string;
    }) {
      const bot = yield* find(input.botId);
      if (Option.isNone(bot)) return null;
      const hash = keyHash(input.runId, input.key);
      const messageId = MessageId.make(`${WORKFLOW_POST_MESSAGE_PREFIX}${hash}`);
      const threadId = botThreadId(bot.value.id, bot.value.homeGeneration);
      // A replay after a crash finds the first post where it went, queued or not, also when the
      // bot rotated since: the same command id cannot be dispatched again to the new thread.
      for (const generation of [bot.value.homeGeneration, bot.value.homeGeneration - 1]) {
        if (generation < 1) continue;
        const earlier = botThreadId(bot.value.id, generation);
        const found = yield* projections
          .getThreadRecords(earlier, ["messages"], { messageIds: [messageId] })
          .pipe(
            Effect.map((records) => records.messages.length > 0),
            Effect.orElseSucceed(() => false),
          );
        if (found) return earlier as string;
      }
      const title =
        input.workflowTitle.length > MAX_SUMMARY
          ? `${input.workflowTitle.slice(0, MAX_SUMMARY - 1)}…`
          : input.workflowTitle;
      yield* engine
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`server:workflow-post:${hash}`),
          threadId,
          messageId,
          text: botPostText({ ...input }),
          notification: {
            source: { kind: "system" },
            outcome: "completed",
            summary: `Workflow "${title}" reported`,
            detail: input.report,
          },
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
        })
        .pipe(Effect.mapError(failure));
      return threadId as string;
    });
    return WorkflowBotPosts.of({ exists, post });
  }),
);
