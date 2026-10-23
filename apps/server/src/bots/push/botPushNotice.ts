import {
  parseBotThreadId,
  type Bot,
  type BotId,
  type EnvironmentId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { isFromBot } from "../botSender.ts";
import { BOT_COMPACTION_MESSAGE_PREFIX } from "../compaction/botCompaction.ts";
import { awaitsAnswer } from "../threadWatch/threadWatchNotice.ts";
import type { BotPushData } from "./BotPushDelivery.ts";

/** What may push: a run of a bot's main thread ended, or the thread waits on a request. */
export type BotPushChange =
  | {
      readonly type: "run";
      readonly run: Pick<OrchestrationV2Run, "id" | "status" | "userMessageId">;
      /** The message that started the run. */
      readonly trigger: Pick<OrchestrationV2ConversationMessage, "senderThreadId"> | undefined;
      /** The run's assistant messages. */
      readonly replies: ReadonlyArray<
        Pick<OrchestrationV2ConversationMessage, "text" | "createdAt">
      >;
    }
  | {
      readonly type: "request";
      readonly request: Pick<OrchestrationV2RuntimeRequest, "id" | "status" | "kind">;
      /** The turn item that shows the request, when it is projected. */
      readonly item: OrchestrationV2TurnItem | undefined;
    };

export interface BotPushNotice {
  readonly kind: "replied" | "waiting";
  /** Stable per change, so a replayed event or a retried push shows once on the phone. */
  readonly key: string;
  readonly threadId: ThreadId;
  readonly botId: BotId;
  readonly body: string;
}

const MAX_BODY = 600;

const clip = (text: string) => {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_BODY ? `${collapsed.slice(0, MAX_BODY - 1)}…` : collapsed;
};

const lastReply = (replies: Extract<BotPushChange, { type: "run" }>["replies"]) =>
  replies
    .filter((reply) => reply.text.trim().length > 0)
    .toSorted((a, b) => DateTime.toEpochMillis(a.createdAt) - DateTime.toEpochMillis(b.createdAt))
    .at(-1)?.text;

const requestText = (item: OrchestrationV2TurnItem | undefined) => {
  if (item?.type === "user_input_request") {
    return item.questions.map((question) => question.question).join(" ");
  }
  if (item?.type === "approval_request") return item.prompt ?? "";
  return "";
};

/**
 * Pure. The push for a change in a bot's current main thread, or null when it is not news to the
 * user: another thread, a past generation, a run that did not complete or left no reply, a run
 * saving memory or compacting, a run another bot asked for, or a request no one answers in the
 * conversation. Runs a thread watch woke do push: the bot is telling the user what happened.
 */
export function botPushNotice(
  threadId: ThreadId,
  bot: Pick<Bot, "id" | "homeGeneration"> | undefined,
  change: BotPushChange,
): BotPushNotice | null {
  const parsed = parseBotThreadId(threadId);
  if (parsed === null || bot === undefined) return null;
  if (bot.id !== parsed.botId || bot.homeGeneration !== parsed.generation) return null;

  if (change.type === "run") {
    if (change.run.status !== "completed") return null;
    if (change.run.userMessageId.startsWith(BOT_COMPACTION_MESSAGE_PREFIX)) return null;
    if (isFromBot(change.trigger?.senderThreadId)) return null;
    const reply = lastReply(change.replies);
    if (reply === undefined) return null;
    return {
      kind: "replied",
      key: `bot-push:run:${change.run.id}`,
      threadId,
      botId: bot.id,
      body: clip(reply),
    };
  }

  if (!awaitsAnswer(change.request)) return null;
  const question = clip(requestText(change.item));
  return {
    kind: "waiting",
    key: `bot-push:request:${change.request.id}`,
    threadId,
    botId: bot.id,
    body: question.length > 0 ? `Waiting for you: ${question}` : "Waiting for your answer",
  };
}

/** The FCM data the Android app reads; it matches `alert_path` against the thread on screen. */
export function botPushData(
  notice: BotPushNotice,
  context: {
    readonly botName: string;
    readonly environmentId: EnvironmentId;
    readonly sentAt: number;
  },
): BotPushData {
  return {
    t3_kind: "bot_message",
    alert_id: notice.key,
    alert_title: context.botName,
    alert_body: notice.body,
    alert_path: `/threads/${encodeURIComponent(context.environmentId)}/${encodeURIComponent(notice.threadId)}`,
    alert_group: notice.botId,
    sent_at: String(context.sentAt),
  };
}

/**
 * Pure. A guest's phone runs the guest app, which opens the bot's chat by `botId`. It gets nothing
 * about the owner's environment or threads; Android shows the FCM `notification` itself.
 */
export function guestPushData(notice: BotPushNotice): BotPushData {
  return { t3_kind: "guest_bot_message", botId: notice.botId, alert_id: notice.key };
}
