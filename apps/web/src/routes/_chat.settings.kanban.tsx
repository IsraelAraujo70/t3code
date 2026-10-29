import { createFileRoute } from "@tanstack/react-router";

import { KanbanSettingsPage } from "../bots/kanban/KanbanSettingsPage";

function SettingsKanbanRoute() {
  return <KanbanSettingsPage />;
}

export const Route = createFileRoute("/_chat/settings/kanban")({
  component: SettingsKanbanRoute,
});
