import { ScrollView, View } from "react-native";

import { AndroidScreenHeader } from "../components/ui/AndroidScreenHeader";
import { EmptyState } from "../components/ui/EmptyState";
import { ScreenContent } from "../components/ui/ScreenContent";
import { useHomeRouteVisible } from "../features/home/home-route-visibility";
import { useWorkspaceTabs } from "../features/workspace/WorkspaceTabsContext";
import { BotsHostMissingNotice, BotsList } from "./BotsList";
import { useBotsEnvironmentId } from "./state";

/** The Android Bots tab: the bots host's bots, grouped as in the desktop sidebar. */
export function BotsTabScreen(props: {
  /** In the split sidebar the list is always on screen while its tab is selected. */
  readonly sidebar?: boolean;
}) {
  const environmentId = useBotsEnvironmentId();
  const workspace = useWorkspaceTabs();
  const routeVisible = useHomeRouteVisible();
  const visible =
    (props.sidebar === true || routeVisible) && workspace?.state.selectedTab === "bots";
  return (
    <>
      <AndroidScreenHeader title="Bots" />
      <ScreenContent insetHorizontal={props.sidebar}>
        <ScrollView
          contentContainerStyle={{ paddingBottom: (workspace?.bottomClearance ?? 0) + 8 }}
        >
          {environmentId === null ? (
            <BotsHostMissingNotice />
          ) : (
            <BotsList environmentId={environmentId} visible={visible} />
          )}
        </ScrollView>
      </ScreenContent>
    </>
  );
}

/** The split view's detail pane before a bot is opened from the sidebar. */
export function BotsTabDetailPlaceholder() {
  return (
    <>
      <AndroidScreenHeader title="Bots" />
      <View className="flex-1 items-center justify-center px-10">
        <EmptyState
          title="Select a bot"
          detail="Choose a bot from the sidebar to open its conversation."
          variant="plain"
        />
      </View>
    </>
  );
}
