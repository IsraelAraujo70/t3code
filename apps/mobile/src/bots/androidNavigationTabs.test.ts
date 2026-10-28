import { describe, expect, it, vi } from "vite-plus/test";

import { androidNavigationTabs } from "./androidNavigationTabs";

// The Bots and Kanban sections exist only on Android (botsTab.android.ts).
vi.mock("./botsTab", () => ({ BOTS_TAB_AVAILABLE: true }));

const sections = ["threads", "bots", "kanban", "pullRequests", "usage"] as const;

describe("androidNavigationTabs", () => {
  it("ends a phone's bar or floating pill in More, holding the rest and Settings", () => {
    expect(
      androidNavigationTabs({ order: [], hidden: [], rail: false, selected: "threads" }),
    ).toEqual({
      tabs: ["threads", "bots", "kanban", "pullRequests", "more"],
      moreTabs: ["usage", "settings"],
      selectedTab: "threads",
    });
  });

  it("keeps Bots and Kanban reachable in any order the user picks", () => {
    const orders = [
      ["usage", "pullRequests", "threads", "bots", "kanban"],
      ["kanban", "usage", "pullRequests", "threads", "bots"],
      ["threads", "usage", "pullRequests", "kanban", "bots"],
    ];
    for (const order of orders) {
      const { tabs, moreTabs } = androidNavigationTabs({
        order,
        hidden: [],
        rail: false,
        selected: "threads",
      });
      expect([...tabs, ...moreTabs].toSorted()).toEqual(
        [...sections, "more", "settings"].toSorted(),
      );
      expect(tabs).toHaveLength(5);
    }
  });

  it("selects More for Settings and for a section in its menu", () => {
    const order = ["threads", "pullRequests", "usage", "kanban", "bots"];
    // selectedNavigationTab answers "settings" for a section out of view.
    expect(
      androidNavigationTabs({ order, hidden: [], rail: false, selected: "settings" }).selectedTab,
    ).toBe("more");
  });

  it("gives the rail five sections and Settings, without More", () => {
    expect(
      androidNavigationTabs({ order: [], hidden: ["usage"], rail: true, selected: "settings" }),
    ).toEqual({
      tabs: ["threads", "bots", "kanban", "pullRequests", "settings"],
      moreTabs: [],
      selectedTab: "settings",
    });
  });
});
