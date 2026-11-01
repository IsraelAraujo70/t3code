import "~/index.css";

import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { BOT_AVATAR_VIEW_BOX } from "@t3tools/client-runtime/bot-avatar";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  BotId,
  EnvironmentId,
  ProjectId,
  ThreadId,
  botSideThreadId,
  botThreadId,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { render } from "../../test/render";
import { SortableThreadRow } from "../components/sidebar/SidebarThreadRow";
import { makeThreadFixture } from "../test-fixtures";
import { isBotsBlockThread } from "./BotThreadIdentity";

vi.mock("../state/bots", async () => {
  const { BotId } = await import("@t3tools/contracts");
  return {
    useBotDirectory: (environmentId: string | null) => ({
      directory:
        environmentId === null
          ? null
          : { bots: [{ id: BotId.make("b_sidebar"), name: "Moneria" }] },
      error: null,
    }),
  };
});

const environmentId = EnvironmentId.make("bots-host");
const scratchProject: EnvironmentProject = {
  id: ProjectId.make("scratch"),
  environmentId,
  isScratch: true,
  title: "No project",
  workspaceRoot: "/tmp/scratch",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-10-26T00:00:00.000Z",
  updatedAt: "2026-10-26T00:00:00.000Z",
};

const noop = () => {};

function cardRow(threadId: ThreadId, title: string) {
  const thread = makeThreadFixture({
    environmentId,
    id: threadId,
    projectId: scratchProject.id,
    title,
  });
  const sortableId = `${environmentId}:${threadId}`;
  return (
    <DndContext>
      <SortableContext items={[sortableId]}>
        <ul>
          <SortableThreadRow
            sortableId={sortableId}
            sortableDisabled
            contextDrag={false}
            thread={thread}
            variant="card"
            variantAction="settle"
            settlementSupported={false}
            snoozeSupported={false}
            pinningSupported={false}
            isPinned={false}
            dropVerb={null}
            dragOverPinned={false}
            sweepAction={null}
            snoozeWakeLabelText={null}
            wokeAt={null}
            isActive={false}
            isRouteThread={false}
            openPullRequestsInRightPanel={false}
            jumpLabel={null}
            currentEnvironmentId={environmentId}
            environmentLabel={null}
            environmentMachine="server"
            scratchMachineLabel={null}
            project={scratchProject}
            projectDisplayName="No project"
            providerEntryByInstanceId={new Map()}
            timestampFormat="locale"
            onThreadClick={noop}
            onThreadActivate={noop}
            onStartRename={noop}
            onRenameTitleChange={noop}
            onCommitRename={noop}
            onCancelRename={noop}
            isRenaming={false}
            renamingTitle=""
            onContextMenu={noop}
            onSettle={noop}
            onActionSweepStart={noop}
            onUnsettle={noop}
            onSnooze={noop}
            onUnsnooze={noop}
            onUnpin={noop}
            onAcknowledgeWoke={noop}
          />
        </ul>
      </SortableContext>
    </DndContext>
  );
}

const botAvatarIn = (root: Element) => root.querySelector(`svg[viewBox="${BOT_AVATAR_VIEW_BOX}"]`);

describe("a bot thread in the sidebar thread list", () => {
  it("names its bot and shows the bot's face instead of No project", async () => {
    await using screen = await render(
      cardRow(botSideThreadId(BotId.make("b_sidebar"), "3e9221ec"), "Cerc"),
    );
    await expect.element(screen.getByText("Cerc").last()).toBeVisible();
    await expect.element(screen.getByText("Moneria").last()).toBeVisible();
    expect(screen.getByText("No project").query()).toBeNull();
    expect(botAvatarIn(screen.container)).not.toBeNull();
  });

  it("keeps the project in a normal thread", async () => {
    await using screen = await render(cardRow(ThreadId.make("thread-plain"), "Fix the build"));
    await expect.element(screen.getByText("No project")).toBeVisible();
    expect(botAvatarIn(screen.container)).toBeNull();
  });

  it("leaves a side thread to the Bots block only where the block lists it under its bot", () => {
    const botId = BotId.make("b_sidebar");
    const main = botThreadId(botId, 3);
    const side = botSideThreadId(botId, "3e9221ec");
    const layouts = ["rail", "sections", "tabs", "mixed"] as const;
    expect(layouts.map((layout) => isBotsBlockThread(main, layout))).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(layouts.map((layout) => isBotsBlockThread(side, layout))).toEqual([
      false,
      true,
      true,
      false,
    ]);
    expect(isBotsBlockThread("thread-plain", "sections")).toBe(false);
  });
});
