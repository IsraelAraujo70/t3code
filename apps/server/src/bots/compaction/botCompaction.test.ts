import { assert, describe, it } from "@effect/vitest";

import { MessageId, ProviderThreadId, RunId } from "@t3tools/contracts";

import {
  BOT_COMPACTION_THRESHOLD,
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
  it("asks a bot past the threshold to save its memory, once per run", () => {
    const step = botCompactionStep(run("message:user-1"), over);
    assert.strictEqual(step?.kind, "flush");
    assert.strictEqual(step?.messageId, "message:bot-compaction:flush:run-7");
    assert.include(step!.text, "memory_save");
    assert.include(step!.text, "320000 of 1000000 tokens");
    assert.strictEqual(step?.notification?.source.kind, "system");
    assert.isNull(botCompactionStep(run("message:user-1"), under));
    assert.isNull(botCompactionStep(run("message:user-1"), null));
  });

  it("compacts after the flush run, whatever its usage, and stops after the compaction", () => {
    const flushed = run("message:bot-compaction:flush:run-6");
    const compact = botCompactionStep(flushed, under);
    assert.strictEqual(compact?.kind, "compact");
    assert.strictEqual(compact?.text, "/compact");
    assert.isUndefined(compact?.notification);

    // A compaction that left the context high must not start another flush by itself.
    assert.isNull(botCompactionStep(run("message:bot-compaction:compact:run-7"), over));
  });

  it("does nothing for runs that did not complete, so an interrupted flush never compacts", () => {
    assert.isNull(botCompactionStep(run("message:user-1", "failed"), over));
    assert.isNull(botCompactionStep(run("message:bot-compaction:flush:run-6", "failed"), over));
    assert.isNull(botCompactionStep(run("message:user-1", "running"), over));
  });

  it("uses the smaller of the fixed threshold and a share of a small window", () => {
    assert.strictEqual(botCompactionThreshold(1_000_000), BOT_COMPACTION_THRESHOLD.tokens);
    assert.strictEqual(botCompactionThreshold(200_000), 120_000);
    assert.strictEqual(botCompactionThreshold(null), BOT_COMPACTION_THRESHOLD.tokens);
    assert.strictEqual(
      botCompactionStep(run("message:user-1"), { usedTokens: 130_000, maxTokens: 200_000 })?.kind,
      "flush",
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
