import { WorkspaceNoTabs } from "./WorkspaceNoTabs";
import { useEnabledNavigationTabs } from "./navigation-tabs";
import { NAVIGATION_TAB_ORDER } from "./navigation-tab-order";
import { useMemo, type ReactNode } from "react";
import { View } from "react-native";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { PullRequestsScreen } from "../pull-requests/PullRequestsScreen";
import { PullRequestToolbar } from "../pull-requests/PullRequestToolbar.android";
import { WorkspaceTabsContext, useWorkspaceTabs } from "./WorkspaceTabsContext";
import { WorkspaceTabPanes } from "./WorkspaceTabPanes";
// Fork (friend): the Bots tab.
import { BotsTabScreen } from "../../bots/BotsTabScreen";

export function AndroidWorkspaceSidebar(props: {
  readonly children: ReactNode;
  readonly onRequestVisibility: () => void;
  readonly selectedPullRequestKey: string | null;
}) {
  const workspace = useWorkspaceTabs()!;
  const enabled = useEnabledNavigationTabs();
  const context = useMemo(() => ({ ...workspace, bottomClearance: 16 }), [workspace]);
  if (enabled.length === 0) return <WorkspaceNoTabs />;
  return (
    <WorkspaceTabPanes
      tabs={NAVIGATION_TAB_ORDER}
      selected={workspace.state.selectedTab}
      renderTab={(tab) =>
        tab === "threads" ? (
          props.children
        ) : tab === "bots" ? (
          // Fork (friend): the Bots tab lists its bots in the sidebar.
          <WorkspaceTabsContext value={context}>
            <View className="flex-1 bg-header">
              <BotsTabScreen sidebar />
            </View>
          </WorkspaceTabsContext>
        ) : tab !== "pullRequests" ? (
          <View className="flex-1 bg-screen" />
        ) : (
          <WorkspaceTabsContext value={context}>
            <PullRequestsScreen
              sidebar
              selectedPullRequestKey={props.selectedPullRequestKey}
              renderFrame={(filters, list) => (
                <View className="flex-1 bg-header">
                  <PullRequestToolbar
                    filters={filters}
                    onRequestVisibility={props.onRequestVisibility}
                  />
                  <ScreenContent insetHorizontal>{list}</ScreenContent>
                </View>
              )}
            />
          </WorkspaceTabsContext>
        )
      }
    />
  );
}
