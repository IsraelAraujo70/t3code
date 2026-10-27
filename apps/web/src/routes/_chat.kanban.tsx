import { createFileRoute } from "@tanstack/react-router";

import { KanbanPage } from "../bots/kanban/KanbanPage";

export const Route = createFileRoute("/_chat/kanban")({
  component: KanbanPage,
});
