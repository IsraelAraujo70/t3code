import {
  BotId,
  botThreadId,
  KANBAN_OWNER_PERSON_ID,
  kanbanBotPersonId,
  ProviderInstanceId,
  type BotDirectoryEntry,
  type KanbanSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildKanbanLookups, personDisplay } from "./kanbanLookups";

const botId = BotId.make("b_pm");
const bot: BotDirectoryEntry = {
  id: botId,
  name: "Moneria PM",
  sectionId: null,
  role: "",
  model: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
  homeGeneration: 1,
  position: 0,
  canManageBots: false,
  rotation: "daily",
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  homeThreadId: botThreadId(botId, 1),
  memories: [],
};

const snapshot: KanbanSnapshot = {
  accounts: [],
  workspaces: [],
  links: [],
  states: [],
  tickets: [],
  people: [
    {
      id: "u_israel",
      organizationId: "org",
      name: "Israel Araujo de Oliveira",
      displayName: "israel",
      avatarUrl: "https://avatars.example/israel.png",
      active: true,
    },
    {
      id: "u_vinicius",
      organizationId: "org",
      name: "",
      displayName: "vinicius.bispo",
      avatarUrl: null,
      active: true,
    },
  ],
  labels: [],
  linearProjects: [],
  milestones: [],
  cycles: [],
  views: [],
  allWorkspacesBotIds: [],
};

describe("personDisplay", () => {
  const lookups = buildKanbanLookups(snapshot, [bot], "Israel");

  it("shows a Linear user by name with their avatar", () => {
    expect(personDisplay(lookups, "u_israel")).toEqual({
      id: "u_israel",
      name: "Israel Araujo de Oliveira",
      avatarUrl: "https://avatars.example/israel.png",
      botId: null,
    });
  });

  it("falls back to the display name when a Linear user has no name", () => {
    expect(personDisplay(lookups, "u_vinicius").name).toBe("vinicius.bispo");
  });

  it("shows the owner by the owner's name, or You when unknown", () => {
    expect(personDisplay(lookups, KANBAN_OWNER_PERSON_ID).name).toBe("Israel");
    expect(personDisplay(buildKanbanLookups(snapshot, [], null), KANBAN_OWNER_PERSON_ID).name).toBe(
      "You",
    );
  });

  it("shows a bot by its name and face", () => {
    expect(personDisplay(lookups, kanbanBotPersonId(botId))).toEqual({
      id: "bot:b_pm",
      name: "Moneria PM",
      avatarUrl: null,
      botId: "b_pm",
    });
  });

  it("shows an unknown id as itself", () => {
    expect(personDisplay(lookups, "u_gone")).toEqual({
      id: "u_gone",
      name: "u_gone",
      avatarUrl: null,
      botId: null,
    });
  });
});
