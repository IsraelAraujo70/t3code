import { assert, describe, it } from "@effect/vitest";

import { MessageId, type OrchestrationV2Run, ProviderThreadId, RunId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  BOT_COMPACTION_THRESHOLD,
  botCompactionPending,
  botCompactionStep,
  botCompactionThreshold,
  latestContextUsage,
} from "./botCompaction.ts";

const run = (userMessageId: string, status: "completed" | "failed" | "running" = "completed") => ({
  id: RunId.make("run-7"),
  status,
  userMessageId: MessageId.make(userMessageId),
});

const over = { usedTokens: 320_000, maxTokens: 1_000_000 };
const under = { usedTokens: 120_000, maxTokens: 1_000_000 };

describe("botCompactionStep", () => {
  it("tells a guest's bot, which has no memory tool, to save to its files", () => {
    const step = botCompactionStep(run("message:user-1"), over, false, "files");
    assert.notInclude(step!.text, "memory_save");
    assert.include(step!.text, "notes file in your home directory");
  });

  it("asks a bot past the threshold to save its memory, once per run", () => {
    const step = botCompactionStep(run("message:user-1"), over, false);
    assert.strictEqual(step?.kind, "flush");
    assert.strictEqual(step?.messageId, "message:bot-compaction:flush:run-7");
    assert.include(step!.text, "memory_save");
    assert.include(step!.text, "320000 of 1000000 tokens");
    assert.strictEqual(step?.notification?.source.kind, "system");
    assert.isNull(botCompactionStep(run("message:user-1"), under, false));
    assert.isNull(botCompactionStep(run("message:user-1"), null, false));
  });

  it("compacts after the flush run, whatever its usage, and stops after the compaction", () => {
    const flushed = run("message:bot-compaction:flush:run-6");
    const compact = botCompactionStep(flushed, under, false);
    assert.strictEqual(compact?.kind, "compact");
    assert.strictEqual(compact?.text, "/compact");
    assert.isUndefined(compact?.notification);

    // A compaction that left the context high must not start another flush by itself.
    assert.isNull(botCompactionStep(run("message:bot-compaction:compact:run-7"), over, false));
  });

  it("does nothing for runs that did not complete, so an interrupted flush never compacts", () => {
    assert.isNull(botCompactionStep(run("message:user-1", "failed"), over, false));
    assert.isNull(
      botCompactionStep(run("message:bot-compaction:flush:run-6", "failed"), over, false),
    );
    assert.isNull(botCompactionStep(run("message:user-1", "running"), over, false));
  });

  it("uses the smaller of the fixed threshold and a share of a small window", () => {
    assert.strictEqual(botCompactionThreshold(1_000_000), BOT_COMPACTION_THRESHOLD.tokens);
    assert.strictEqual(botCompactionThreshold(200_000), 120_000);
    assert.strictEqual(botCompactionThreshold(null), BOT_COMPACTION_THRESHOLD.tokens);
    assert.strictEqual(
      botCompactionStep(run("message:user-1"), { usedTokens: 130_000, maxTokens: 200_000 }, false)
        ?.kind,
      "flush",
    );
  });
});

describe("botCompactionPending", () => {
  const threadRun = (
    ordinal: number,
    userMessageId: string,
    status: OrchestrationV2Run["status"],
    completedSecond: number | null = null,
  ) => ({
    id: RunId.make(`run:ordinal:${ordinal}`),
    status,
    userMessageId: MessageId.make(userMessageId),
    completedAt:
      completedSecond === null
        ? null
        : DateTime.makeUnsafe(`2026-10-22T12:29:${String(completedSecond).padStart(2, "0")}Z`),
  });

  it("starts one cycle when several runs over the threshold complete before it ends", () => {
    // The InsiderXL PM thread on 2026-10-22: notices 115, 119 and 131 all completed past 300K
    // before the first /compact ran, and each queued a flush of its own.
    const runs = [
      threadRun(115, "message:notice-115", "running"),
      threadRun(119, "message:notice-119", "queued"),
      threadRun(131, "message:notice-131", "queued"),
    ];
    const steps: Array<string> = [];
    for (const [index, ordinal, second] of [
      [0, 115, 26],
      [1, 119, 43],
      [2, 131, 53],
    ] as const) {
      const completed = threadRun(ordinal, runs[index]!.userMessageId, "completed", second);
      runs[index] = completed;
      const step = botCompactionStep(completed, over, botCompactionPending(runs));
      if (step === null) continue;
      steps.push(step.messageId);
      runs.push(threadRun(130 + index, step.messageId, "queued"));
    }
    assert.deepStrictEqual(steps, ["message:bot-compaction:flush:run:ordinal:115"]);
  });

  it("stays pending from the flush until its /compact finishes", () => {
    const flush = threadRun(130, "message:bot-compaction:flush:run:ordinal:115", "completed", 36);
    const ordinary = threadRun(129, "message:notice-115", "completed", 26);
    // The flush completed and its /compact is not queued yet.
    assert.isTrue(botCompactionPending([ordinary, flush]));
    const compact = (status: OrchestrationV2Run["status"], second: number | null = null) =>
      threadRun(133, "message:bot-compaction:compact:run:ordinal:130", status, second);
    assert.isTrue(botCompactionPending([ordinary, flush, compact("queued")]));
    assert.isTrue(botCompactionPending([ordinary, flush, compact("running")]));
    assert.isFalse(botCompactionPending([ordinary, flush, compact("completed", 54)]));
    // A failed /compact ends the cycle, so the next run past the threshold can start another.
    assert.isFalse(botCompactionPending([ordinary, flush, compact("failed", 54)]));
  });

  it("is not pending without a cycle, or when a flush was followed by other work", () => {
    assert.isFalse(botCompactionPending([]));
    assert.isFalse(botCompactionPending([threadRun(1, "message:user-1", "completed", 10)]));
    // A flush whose /compact never got queued must not block compaction forever.
    assert.isFalse(
      botCompactionPending([
        threadRun(1, "message:bot-compaction:flush:run:ordinal:0", "completed", 10),
        threadRun(2, "message:user-2", "completed", 20),
      ]),
    );
  });
});

describe("latestContextUsage", () => {
  const own = ProviderThreadId.make("provider-thread:own");
  const subagent = ProviderThreadId.make("provider-thread:subagent");
  const usage = (usedTokens: number, updatedAt: string) => ({ usedTokens, updatedAt });

  it("reads the newest usage of the bot's own provider thread, ignoring subagents", () => {
    const latest = latestContextUsage(
      [
        { providerThreadId: own, tokenUsage: usage(200_000, "2026-10-20T20:00:00.000Z") },
        { providerThreadId: own, tokenUsage: usage(20_000, "2026-10-20T21:00:00.000Z") },
        { providerThreadId: own, tokenUsage: undefined },
        { providerThreadId: subagent, tokenUsage: usage(400_000, "2026-10-20T22:00:00.000Z") },
      ],
      own,
    );
    assert.strictEqual(latest?.usedTokens, 20_000);
    assert.isNull(latestContextUsage([{ providerThreadId: own, tokenUsage: undefined }], own));
    assert.isNull(latestContextUsage([], null));
  });
});
