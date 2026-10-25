import { useMemo, type ReactNode } from "react";
import { View } from "react-native";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { PullRequestFilterMenuProvider } from "../pull-requests/PullRequestFilterMenuContext";
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
  const context = useMemo(() => ({ ...workspace, bottomClearance: 16 }), [workspace]);
  return (
    <WorkspaceTabPanes
      // Fork (friend): the Bots tab.
      tabs={["threads", "bots", "pullRequests"]}
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
        ) : (
          <WorkspaceTabsContext value={context}>
            <PullRequestFilterMenuProvider>
              <View className="flex-1 bg-header">
                <PullRequestToolbar onRequestVisibility={props.onRequestVisibility} />
                <ScreenContent insetHorizontal>
                  <PullRequestsScreen
                    sidebar
                    selectedPullRequestKey={props.selectedPullRequestKey}
                  />
                </ScreenContent>
              </View>
            </PullRequestFilterMenuProvider>
          </WorkspaceTabsContext>
        )
      }
    />
  );
}
