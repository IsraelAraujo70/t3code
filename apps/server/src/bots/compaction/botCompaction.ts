import type {
  OrchestrationV2Notification,
  OrchestrationV2ProviderTurn,
  OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { BOT_ROTATION_MESSAGE_PREFIX } from "../rotation/rotationPolicy.ts";

/** Opens the id of every message the server sends a bot to save its memory and then compact. */
export const BOT_COMPACTION_MESSAGE_PREFIX = "message:bot-compaction:";
const FLUSH_PREFIX = `${BOT_COMPACTION_MESSAGE_PREFIX}flush:`;
const COMPACT_PREFIX = `${BOT_COMPACTION_MESSAGE_PREFIX}compact:`;

/**
 * The server compacts a bot's conversation well before the provider would on its own: a window
 * of a million tokens otherwise carries hundreds of thousands into every turn, and the bot gets a
 * turn to save its memory first, which the provider's own compaction never gives it.
 */
export const BOT_COMPACTION_THRESHOLD = { tokens: 300_000, shareOfWindow: 0.6 } as const;

/** Context a run left behind, from the provider turn that ended it. */
export interface BotContextUsage {
  readonly usedTokens: number;
  readonly maxTokens?: number | null | undefined;
}

/**
 * The most recently recorded usage of the bot's own provider thread; subagents keep turns of
 * their own in the same projection. The provider thread's contextUsage is refreshed only when
 * the next turn starts, while the turn that just ended records its usage before its run
 * completes.
 */
export function latestContextUsage(
  turns: ReadonlyArray<Pick<OrchestrationV2ProviderTurn, "providerThreadId" | "tokenUsage">>,
  providerThreadId: OrchestrationV2ProviderTurn["providerThreadId"] | null,
): BotContextUsage | null {
  let latest: NonNullable<OrchestrationV2ProviderTurn["tokenUsage"]> | null = null;
  for (const turn of turns) {
    if (turn.providerThreadId !== providerThreadId) continue;
    if (turn.tokenUsage !== undefined && turn.tokenUsage.updatedAt > (latest?.updatedAt ?? "")) {
      latest = turn.tokenUsage;
    }
  }
  return latest;
}

export function botCompactionThreshold(maxTokens: number | null | undefined): number {
  return maxTokens == null
    ? BOT_COMPACTION_THRESHOLD.tokens
    : Math.min(
        BOT_COMPACTION_THRESHOLD.tokens,
        Math.floor(maxTokens * BOT_COMPACTION_THRESHOLD.shareOfWindow),
      );
}

export interface BotCompactionStep {
  readonly kind: "flush" | "compact";
  /** Stable per run, so a replayed event never sends the message twice. */
  readonly key: string;
  readonly messageId: string;
  readonly text: string;
  readonly notification?: OrchestrationV2Notification;
}

/** Owner bots save to their T3 memory; a guest's bot has no T3 tools, only its sandbox's files. */
export type BotCompactionSaver = "memory" | "files";

const flushText = (usage: BotContextUsage, saver: BotCompactionSaver) =>
  [
    `Your conversation now carries ${usage.usedTokens}${usage.maxTokens == null ? "" : ` of ${usage.maxTokens}`} tokens of context, so T3 compacts it right after this turn. Only your memories, your instructions and a short summary carry over.`,
    saver === "memory"
      ? "Before that, save with memory_save what you would need to continue: open work and who is waiting on it, decisions and corrections from the user, and the threads you follow. Merge related memories and forget stale ones first, so everything fits your memory budget."
      : "Before that, write what you would need to continue to a notes file in your home directory: open work, decisions and corrections from the user, and anything you promised to do. Update the file instead of starting a new one.",
    "Start no new work. Answer in one line.",
  ].join("\n\n");

type CompactionRun = Pick<OrchestrationV2Run, "id" | "status" | "userMessageId" | "completedAt">;

const unfinished = new Set<OrchestrationV2Run["status"]>([
  "queued",
  "preparing",
  "starting",
  "running",
  "waiting",
]);

/**
 * Pure. Whether a compaction cycle is already under way: a flush or `/compact` that has not
 * finished, or a flush that completed last and whose `/compact` is not queued yet. Runs that were
 * queued before the cycle started complete over the threshold too, and must not start another.
 */
export function botCompactionPending(runs: ReadonlyArray<CompactionRun>): boolean {
  let latest: CompactionRun | undefined;
  for (const run of runs) {
    if (run.userMessageId.startsWith(BOT_COMPACTION_MESSAGE_PREFIX) && unfinished.has(run.status)) {
      return true;
    }
    if (
      run.status === "completed" &&
      run.completedAt !== null &&
      (latest?.completedAt == null ||
        DateTime.toEpochMillis(run.completedAt) > DateTime.toEpochMillis(latest.completedAt))
    ) {
      latest = run;
    }
  }
  if (latest === undefined || !latest.userMessageId.startsWith(FLUSH_PREFIX)) return false;
  const compactId = `${COMPACT_PREFIX}${latest.id}`;
  return !runs.some((run) => run.userMessageId === compactId);
}

/**
 * Pure. What a completed run of a bot's conversation calls for: after a run the flush started,
 * compact; after any other run past the threshold, a turn to save memory first, unless a cycle
 * is already pending. A run the compaction started, or one that did not complete, calls for
 * nothing, so the two can never chain into a loop.
 */
export function botCompactionStep(
  run: Pick<OrchestrationV2Run, "id" | "status" | "userMessageId">,
  usage: BotContextUsage | null,
  compactionPending: boolean,
  saver: BotCompactionSaver = "memory",
): BotCompactionStep | null {
  if (run.status !== "completed") return null;
  if (run.userMessageId.startsWith(COMPACT_PREFIX)) return null;
  // A rotation's handoff ends a conversation that is archived next, not compacted.
  if (run.userMessageId.startsWith(BOT_ROTATION_MESSAGE_PREFIX)) return null;
  if (run.userMessageId.startsWith(FLUSH_PREFIX)) {
    // The text must be exactly the command RunExecutionService turns into a compaction.
    return {
      kind: "compact",
      key: run.id,
      messageId: `${COMPACT_PREFIX}${run.id}`,
      text: "/compact",
    };
  }
  if (compactionPending) return null;
  if (usage === null || usage.usedTokens < botCompactionThreshold(usage.maxTokens)) return null;
  return {
    kind: "flush",
    key: run.id,
    messageId: `${FLUSH_PREFIX}${run.id}`,
    text: flushText(usage, saver),
    notification: {
      source: { kind: "system" },
      outcome: "updated",
      summary: "Saving memories before compacting the conversation",
    },
  };
}
