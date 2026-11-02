import { KanbanTicketId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { emptyRunState } from "../fold.ts";
import { cardColumnOf, cardIntent } from "./cardIntent.ts";
import type { IntentEntry } from "../state.ts";

describe("card intents", () => {
  it("prioritizes ended, waiting and started", () => {
    for (const ended of [false, true])
      for (const waiting of [false, true])
        for (const started of [false, true]) {
          expect(cardColumnOf({ ended, waiting, started })).toBe(
            ended ? "done" : waiting ? "in_review" : started ? "in_progress" : "todo",
          );
        }
  });
  it("records transitions and reads the highest sequence", () => {
    const intents = new Map<string, IntentEntry>();
    const state = { ...emptyRunState("run"), intents };
    const card = { project: "p", title: "Run", runId: "run" };
    for (const [index, column] of (
      ["in_progress", "in_review", "in_progress"] as const
    ).entries()) {
      const intent = cardIntent(state, card, column)!;
      expect(intent.key).toBe(`card:${index + 1}`);
      expect(intent).not.toHaveProperty("runPath");
      expect(intent.ticketId).toBe(index === 0 ? undefined : "ticket");
      intents.set(intent.key, { intent, seq: index + 1, result: null });
      // Nothing new while the last card has no result, whatever the column.
      expect(cardIntent(state, card, "done")).toBeNull();
      intents.set(intent.key, {
        intent,
        seq: index + 1,
        result: { _tag: "CardUpserted", ticketId: KanbanTicketId.make("ticket") },
      });
      expect(cardIntent(state, card, column)).toBeNull();
    }
    const first = intents.get("card:1")!;
    intents.delete("card:1");
    intents.set("card:1", first);
    expect(cardIntent(state, card, "in_progress")).toBeNull();
  });
});
