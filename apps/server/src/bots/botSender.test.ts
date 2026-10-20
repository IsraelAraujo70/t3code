import { assert, describe, it } from "@effect/vitest";

import { BotId, botThreadId, ThreadId } from "@t3tools/contracts";

import { BOT_SENDER_PREFIX, withBotSenderNote } from "./botSender.ts";

describe("withBotSenderNote", () => {
  it("marks a message a bot thread sent and leaves every other message alone", () => {
    const sender = botThreadId(BotId.make(`b_${"a".repeat(32)}`), 2);
    assert.strictEqual(
      withBotSenderNote("Quanto gastei?", sender),
      `${BOT_SENDER_PREFIX} ${sender}, not from the user]\n\nQuanto gastei?`,
    );
    assert.strictEqual(withBotSenderNote("Oi", undefined), "Oi");
    assert.strictEqual(withBotSenderNote("Oi", ThreadId.make("thread-1")), "Oi");
  });
});
