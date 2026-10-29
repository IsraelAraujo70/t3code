import { BotId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { botGenerationView } from "./botChat.ts";

const botId = BotId.make("b_gen");

describe("botGenerationView", () => {
  it.each([
    ["a plain thread", "thread-1", 2, null],
    ["an unknown current generation", "bot:b_gen:2", null, null],
    ["the first generation", "bot:b_gen:1", 1, { kind: "current", botId, previousThreadId: null }],
    [
      "a renewed generation",
      "bot:b_gen:2",
      2,
      { kind: "current", botId, previousThreadId: ThreadId.make("bot:b_gen:1") },
    ],
    [
      "a generation newer than the directory",
      "bot:b_gen:3",
      2,
      { kind: "current", botId, previousThreadId: ThreadId.make("bot:b_gen:2") },
    ],
    [
      "an earlier generation",
      "bot:b_gen:1",
      3,
      { kind: "earlier", botId, currentThreadId: ThreadId.make("bot:b_gen:3") },
    ],
  ] as const)("reads %s", (_name, threadId, homeGeneration, expected) => {
    expect(botGenerationView(threadId, homeGeneration)).toEqual(expected);
  });
});
