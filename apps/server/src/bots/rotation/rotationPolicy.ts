import type {
  BotId,
  BotRotation,
  OrchestrationV2Notification,
  OrchestrationV2Run,
  OrchestrationV2RuntimeRequest,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** Opens the id of every message the server sends a bot to rotate its conversation. */
export const BOT_ROTATION_MESSAGE_PREFIX = "message:bot-rotation:";

export const BOT_ROTATION_POLICY = {
  /** Local hour of the host after which a generation's rotation is due. */
  quietHour: 4,
  /** A generation with fewer runs is small enough to keep going. */
  minRuns: 10,
  /** Characters of handoff the next generation carries in its instructions. */
  handoffLimit: 3_000,
} as const;

export const handoffMessageId = (botId: BotId, generation: number) =>
  `${BOT_ROTATION_MESSAGE_PREFIX}handoff:${botId}:${generation}`;

/**
 * Pure. When a generation that started at `startedAt` becomes due: the first quiet hour after it,
 * or after six more days for a weekly bot. Null when rotation is off.
 */
export function rotationDueAt(
  rotation: BotRotation,
  startedAt: DateTime.Utc,
  zone: DateTime.TimeZone,
): DateTime.Utc | null {
  if (rotation === "off") return null;
  const from = DateTime.setZone(
    DateTime.add(startedAt, { days: rotation === "weekly" ? 6 : 0 }),
    zone,
  );
  const sameDay = DateTime.setParts(from, {
    hour: BOT_ROTATION_POLICY.quietHour,
    minute: 0,
    second: 0,
    millisecond: 0,
  });
  return DateTime.toUtc(
    DateTime.isGreaterThan(sameDay, from) ? sameDay : DateTime.add(sameDay, { days: 1 }),
  );
}

const unfinished = new Set<OrchestrationV2Run["status"]>([
  "queued",
  "preparing",
  "starting",
  "running",
  "waiting",
]);

/**
 * Pure. Whether the bot is in the middle of something a rotation would cut: a run that has not
 * ended (a queued message, held or not, counts) or a question or approval still waiting.
 */
function conversationBusy(
  runs: ReadonlyArray<Pick<OrchestrationV2Run, "status">>,
  requests: ReadonlyArray<Pick<OrchestrationV2RuntimeRequest, "status">>,
): boolean {
  return (
    runs.some((run) => unfinished.has(run.status)) ||
    requests.some((request) => request.status === "pending")
  );
}

export type BotRotationStep =
  | { readonly kind: "none" }
  /** Ask the bot for its handoff; the rotation follows once that turn ends. */
  | { readonly kind: "handoff" }
  /** Rotate now; the handoff is the final reply of this run, when it completed. */
  | { readonly kind: "rotate"; readonly handoffRunId: OrchestrationV2Run["id"] | null };

/**
 * Pure. What a bot's current generation calls for. Once the handoff message exists, the rotation
 * happens at the next idle moment whatever its turn's outcome, and whatever the policy says by
 * then. Before it, a due generation with enough runs gets the handoff turn, never while busy.
 */
export function botRotationStep(input: {
  readonly rotation: BotRotation;
  readonly handoffMessageId: string;
  readonly startedAt: DateTime.Utc;
  readonly now: DateTime.Utc;
  readonly zone: DateTime.TimeZone;
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "status" | "userMessageId">>;
  readonly requests: ReadonlyArray<Pick<OrchestrationV2RuntimeRequest, "status">>;
}): BotRotationStep {
  if (conversationBusy(input.runs, input.requests)) return { kind: "none" };
  const handoffRun = input.runs.find((run) => run.userMessageId === input.handoffMessageId);
  if (handoffRun !== undefined) {
    return {
      kind: "rotate",
      handoffRunId: handoffRun.status === "completed" ? handoffRun.id : null,
    };
  }
  const dueAt = rotationDueAt(input.rotation, input.startedAt, input.zone);
  if (dueAt === null || DateTime.isLessThan(input.now, dueAt)) return { kind: "none" };
  if (input.runs.length < BOT_ROTATION_POLICY.minRuns) return { kind: "none" };
  return { kind: "handoff" };
}

/** Owner bots save to their T3 memory; a guest's bot has no T3 tools, only its sandbox's files. */
export type BotRotationSaver = "memory" | "files";

export const handoffRequest = (
  saver: BotRotationSaver,
): { readonly text: string; readonly notification: OrchestrationV2Notification } => ({
  text: [
    "T3 starts a fresh conversation for you right after this turn, so each one stays small and quick to open. This conversation is archived; the next one starts with your memories, your instructions, the reply you write now, and this thread's id, which you can read with t3_thread_read if you ever need the details.",
    saver === "memory"
      ? "First save with memory_save anything durable you learned here that is not in your memories yet: facts about the user, decisions and corrections. Merge related memories and forget stale ones first, so everything fits your memory budget."
      : "First update the notes file in your home directory with anything durable you learned here: decisions, corrections from the user, and promises you made.",
    `Then reply with a handoff for yourself, at most ${BOT_ROTATION_POLICY.handoffLimit} characters: open work and who is waiting on it, the threads you follow (with their ids), and what you promised to do next. Write only the handoff. Start no new work.`,
  ].join("\n\n"),
  notification: {
    source: { kind: "system" },
    outcome: "updated",
    summary: "Writing a handoff before starting a fresh conversation",
  },
});

/** Pure. The handoff as the next generation carries it. */
export function clipHandoff(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  return trimmed.length <= BOT_ROTATION_POLICY.handoffLimit
    ? trimmed
    : `${trimmed.slice(0, BOT_ROTATION_POLICY.handoffLimit - 1)}…`;
}
