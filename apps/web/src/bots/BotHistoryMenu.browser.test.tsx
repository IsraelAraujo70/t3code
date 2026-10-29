import { BotId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { BotHistoryMenu } from "./BotHistoryMenu";

const botId = BotId.make("b_history");

vi.mock("../state/bots", async () => {
  const { BotId, EnvironmentId, ThreadId } = await import("@t3tools/contracts");
  return {
    botsEnvironment: { history: { label: "bots:history" } },
    useBotsEnvironmentId: () => EnvironmentId.make("bots-host"),
    useBotDirectory: () => ({
      directory: {
        bots: [
          {
            id: BotId.make("b_history"),
            name: "Moneria",
            homeThreadId: ThreadId.make("bot:b_history:2"),
          },
        ],
      },
    }),
  };
});
vi.mock("../state/use-atom-command", async () => {
  const { BotId, ThreadId } = await import("@t3tools/contracts");
  return {
    useAtomCommand: () => async () => ({
      _tag: "Success",
      value: {
        botId: BotId.make("b_history"),
        generations: [
          {
            generation: 1,
            threadId: ThreadId.make("bot:b_history:1"),
            startedAt: "2026-10-27T10:00:00.000Z",
            endedAt: "2026-10-29T07:00:00.000Z",
            handoff: null,
          },
        ],
      },
    }),
  };
});

describe("BotHistoryMenu", () => {
  it("opens and lists the earlier generations", async () => {
    await using screen = await render(
      <BotHistoryMenu botId={botId} threadId={ThreadId.make("bot:b_history:2")} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Earlier conversations of Moneria" }));
    await expect
      .element(screen.getByRole("menuitem", { name: "Current conversation" }))
      .toBeVisible();
    await expect.element(screen.getByRole("menuitem", { name: /Oct 27/ })).toBeVisible();
  });
});
