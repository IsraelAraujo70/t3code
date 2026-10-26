import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { describe, expect, it } from "vite-plus/test";

import { render } from "../../test/render";
import { ChatHeader } from "../components/chat/ChatHeader";

const environmentId = EnvironmentId.make("env-local");
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

function header(threadId: string, title: string) {
  return (
    <ChatHeader
      activeThreadEnvironmentId={environmentId}
      activeThreadId={ThreadId.make(threadId)}
      activeThreadTitle={title}
      isServerThread
      activeProject={scratchProject}
      parentThreadLink={null}
      onOpenThread={() => {}}
      rightPanelOpen={false}
      onNewThreadInProject={() => {}}
    />
  );
}

describe("ChatHeader in a bot conversation", () => {
  it("shows the bot's face instead of the No project crumb", async () => {
    await using screen = await render(header("bot:b_header:1", "T3 Fork"));
    const breadcrumb = screen.getByRole("navigation", { name: "Thread breadcrumb" });
    await expect.element(breadcrumb.getByText("T3 Fork")).toBeVisible();
    expect(breadcrumb.getByText("No project").query()).toBeNull();
    expect(breadcrumb.element().querySelector("li:first-child svg")).not.toBeNull();
  });

  it("keeps the project crumb in a normal thread", async () => {
    await using screen = await render(header("thread-plain", "Fix the build"));
    const breadcrumb = screen.getByRole("navigation", { name: "Thread breadcrumb" });
    await expect.element(breadcrumb.getByText("No project")).toBeVisible();
    await expect.element(breadcrumb.getByText("Fix the build")).toBeVisible();
  });
});
