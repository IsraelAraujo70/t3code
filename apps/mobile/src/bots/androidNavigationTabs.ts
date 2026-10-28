import type { AndroidWorkspaceNavigationTab } from "../features/workspace/android-workspace-tabs";
import {
  overflowNavigationTabs,
  visibleNavigationTabs,
} from "../features/workspace/navigation-tab-order";

/**
 * What the Android navigation shows. The rail fits five sections and Settings. A phone's bar and
 * its floating pill fit four and end in More, a menu of the rest and Settings, so Bots and Kanban
 * stay reachable however the user orders the sections. More is selected for what it holds.
 */
export function androidNavigationTabs(input: {
  readonly order: readonly unknown[];
  readonly hidden: readonly unknown[];
  readonly rail: boolean;
  /** `selectedNavigationTab`'s answer: "settings" also stands for a section out of view. */
  readonly selected: AndroidWorkspaceNavigationTab;
}): {
  readonly tabs: readonly string[];
  readonly moreTabs: readonly AndroidWorkspaceNavigationTab[];
  readonly selectedTab: AndroidWorkspaceNavigationTab | "more";
} {
  if (input.rail) {
    return {
      tabs: [...visibleNavigationTabs(input.order, input.hidden, 5), "settings"],
      moreTabs: [],
      selectedTab: input.selected,
    };
  }
  return {
    tabs: [...visibleNavigationTabs(input.order, input.hidden, 4), "more"],
    moreTabs: [...overflowNavigationTabs(input.order, input.hidden), "settings"],
    selectedTab: input.selected === "settings" ? "more" : input.selected,
  };
}
