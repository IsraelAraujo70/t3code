import type { EnvironmentId } from "@t3tools/contracts";

import { AndroidScreenHeader } from "../components/ui/AndroidScreenHeader";
import { ScreenContent } from "../components/ui/ScreenContent";
import { useHomeRouteVisible } from "../features/home/home-route-visibility";
import { useWorkspaceTabs } from "../features/workspace/WorkspaceTabsContext";
import { KanbanBoardContent, useKanbanSyncActions } from "./BotsKanbanRouteScreen";
import { BotsHostMissingNotice } from "./BotsList";
import { useBotsEnvironmentId, useKanbanSnapshot } from "./state";

/** The Android Kanban tab: the bots host's board. A thread opened from it returns here. */
export function KanbanTabScreen() {
  const environmentId = useBotsEnvironmentId();
  const workspace = useWorkspaceTabs();
  const routeVisible = useHomeRouteVisible();
  const visible = routeVisible && workspace?.state.selectedTab === "kanban";
  const bottomPadding = workspace?.bottomClearance ?? 0;
  if (environmentId === null) {
    return (
      <>
        <AndroidScreenHeader title="Kanban" />
        <ScreenContent>
          <BotsHostMissingNotice />
        </ScreenContent>
      </>
    );
  }
  return (
    <KanbanTabBoard environmentId={environmentId} visible={visible} bottomPadding={bottomPadding} />
  );
}

function KanbanTabBoard(props: {
  readonly environmentId: EnvironmentId;
  readonly visible: boolean;
  readonly bottomPadding: number;
}) {
  const { snapshot, error } = useKanbanSnapshot(props.environmentId, props.visible);
  const actions = useKanbanSyncActions(props.environmentId, snapshot);
  return (
    <>
      <AndroidScreenHeader title="Kanban" actions={actions} />
      <ScreenContent>
        <KanbanBoardContent
          environmentId={props.environmentId}
          snapshot={snapshot}
          error={error}
          returnTab="kanban"
          bottomPadding={props.bottomPadding}
        />
      </ScreenContent>
    </>
  );
}
