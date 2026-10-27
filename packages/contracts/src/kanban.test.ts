import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { KANBAN_DEFAULT_VIEW_CONFIG, KanbanSnapshot } from "./kanban.ts";

const decodeSnapshot = Schema.decodeSync(KanbanSnapshot);

describe("KanbanSnapshot", () => {
  it("decodes a snapshot from a host that predates bot views and all-workspace bots", () => {
    const fromOldHost = {
      accounts: [],
      workspaces: [{ id: "local", name: "Local", botIds: [] }],
      links: [],
      states: [],
      tickets: [],
      people: [],
      labels: [],
      linearProjects: [],
      milestones: [],
      cycles: [],
      views: [
        {
          id: "v_all",
          projectId: null,
          name: "All issues",
          icon: null,
          config: KANBAN_DEFAULT_VIEW_CONFIG,
          linearViewId: null,
          createdAt: "2026-10-01T00:00:00.000Z",
          updatedAt: "2026-10-01T00:00:00.000Z",
        },
      ],
    };
    const snapshot = decodeSnapshot(fromOldHost);
    expect(snapshot.allWorkspacesBotIds).toEqual([]);
    expect(snapshot.views[0]).toMatchObject({ createdBy: "owner", updatedBy: "owner" });
  });
});
