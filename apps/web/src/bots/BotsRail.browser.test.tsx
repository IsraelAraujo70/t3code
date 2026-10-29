import "~/index.css";

import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { BotsRail } from "./BotsRail";

vi.mock("./BotAvatar", () => ({
  BotAvatar: (props: { botId: string; size: number }) => (
    <span data-rail-avatar={props.botId} style={{ width: props.size, height: props.size }} />
  ),
}));
vi.mock("./BotsSidebarSection", async () => {
  const { BotId, BotSectionId, EnvironmentId, ProviderInstanceId, botThreadId } =
    await import("@t3tools/contracts");
  const environmentId = EnvironmentId.make("bots-host");
  const at = "2026-10-01T00:00:00.000Z";
  const sections = ["Casa", "Moneria"].map((name, position) => ({
    id: BotSectionId.make(name),
    name,
    position,
    createdAt: at,
    updatedAt: at,
  }));
  const rows = [
    ["b_free", null],
    ["b_casa1", "Casa"],
    ["b_casa2", "Casa"],
    ["b_mon1", "Moneria"],
    ["b_mon2", "Moneria"],
  ].map(([id, section], position) => {
    const botId = BotId.make(id!);
    return {
      bot: {
        id: botId,
        name: id!,
        sectionId: section === null ? null : BotSectionId.make(section!),
        role: "",
        model: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
        homeGeneration: 1,
        position,
        canManageBots: false,
        rotation: "daily" as const,
        createdAt: at,
        updatedAt: at,
        homeThreadId: botThreadId(botId, 1),
        memories: [],
      },
      threadRef: { environmentId, threadId: botThreadId(botId, 1) },
      status: { kind: "needs-you" as const, attention: null },
      preview: "Waiting on the deploy",
      activityAt: at,
    };
  });
  return {
    BotsSidebarSection: () => null,
    BotStatusDot: () => null,
    compactTimeLabel: () => "5m",
    useBotMenu: () => async () => {},
    useOpenBotsSettings: () => () => {},
    useBotsArrangement: () => ({ environmentId, shown: { sections }, rows }),
  };
});

const avatarPositions = (root: Element) =>
  Array.from(root.querySelectorAll("[data-rail-avatar]"), (avatar) => {
    const rect = avatar.getBoundingClientRect();
    return { bot: avatar.getAttribute("data-rail-avatar"), x: rect.x, y: rect.y };
  });

describe("BotsRail", () => {
  it("keeps every avatar in place when the names slide out", async () => {
    await using screen = await render(
      <div className="relative flex h-[600px] w-80">
        <BotsRail threads={[]} activeThreadRef={null} onOpenThread={() => {}} />
      </div>,
    );
    const nav = screen.getByRole("navigation", { name: "Bots" });
    await expect.element(nav).toBeVisible();
    const closed = avatarPositions(nav.element());
    expect(closed).toHaveLength(5);

    await userEvent.tab();
    await expect.element(nav.getByText("Moneria", { exact: true })).toBeVisible();
    expect(avatarPositions(nav.element())).toEqual(closed);
  });
});
