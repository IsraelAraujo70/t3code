import { BotId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import "~/index.css";

import { render } from "../../test/render";
import { BotThreadsMenu } from "./BotThreadsMenu";

const { calls } = vi.hoisted(() => ({ calls: [] as unknown[] }));

const botId = BotId.make("b_history");

vi.mock("../state/bots", async () => {
  const { BotId, EnvironmentId, ThreadId } = await import("@t3tools/contracts");
  return {
    botsEnvironment: { listThreads: { label: "list" }, openThread: { label: "open" } },
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
    useAtomCommand: () => async (input: unknown) => {
      calls.push(input);
      return {
        _tag: "Success",
        value: {
          threadId: ThreadId.make("bot:b_history:t-ab"),
          botId: BotId.make("b_history"),
          threads: [
            {
              title: "Planning",
              threadId: ThreadId.make("bot:b_history:t-ab"),
              createdAt: "2026-10-27T10:00:00.000Z",
              updatedAt: "2026-10-29T07:00:00.000Z",
            },
          ],
        },
      };
    },
  };
});

vi.mock("../state/session", () => ({ useEnvironmentScope: () => true }));

vi.mock("../hooks/useThreadActions", () => ({
  useThreadActions: () => ({ archiveThread: vi.fn() }),
}));

describe("BotThreadsMenu", () => {
  it("opens and lists side threads", async () => {
    calls.length = 0;
    await using screen = await render(
      <BotThreadsMenu botId={botId} threadId={ThreadId.make("bot:b_history:2")} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Threads of Moneria" }));
    await expect.element(screen.getByRole("menuitem", { name: "Main conversation" })).toBeVisible();
    await expect.element(screen.getByRole("menuitem", { name: "Planning" })).toBeVisible();
  });
  it("opens a thread with the entered title", async () => {
    calls.length = 0;
    await using screen = await render(
      <BotThreadsMenu botId={botId} threadId={ThreadId.make("bot:b_history:2")} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Threads of Moneria" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "New thread…" }));
    await userEvent.fill(screen.getByRole("textbox", { name: "Title" }), "Planning");
    await userEvent.click(screen.getByRole("button", { name: "Create thread" }));
    expect(calls).toContainEqual(expect.objectContaining({ input: { botId, title: "Planning" } }));
  });
});
