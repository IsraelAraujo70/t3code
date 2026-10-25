import { useNavigation } from "@react-navigation/native";
import { useCallback } from "react";
import { Keyboard } from "react-native";
import {
  resetAndroidWorkspace,
  type AndroidWorkspaceDestination,
} from "../../lib/android-workspace-navigation";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";
// Fork (friend): bot conversations open from the Bots tab.
import { workspaceTabForThread } from "../../bots/bots.logic";

export function useAndroidWorkspaceSelection() {
  const navigation = useNavigation();
  const dispatch = useWorkspaceTabs()?.dispatch;
  return useCallback(
    (
      destination: AndroidWorkspaceDestination,
      reviewers?: ReactNavigation.RootParamList["PullRequestReviewers"],
    ) => {
      Keyboard.dismiss();
      dispatch?.({
        type: "select",
        // Fork (friend): a bot's conversation belongs to the Bots tab, so Back returns there.
        tab:
          destination.name === "Thread"
            ? workspaceTabForThread(destination.params.threadId)
            : "pullRequests",
      });
      resetAndroidWorkspace(navigation, destination, reviewers);
    },
    [navigation, dispatch],
  );
}
