import { createFileRoute } from "@tanstack/react-router";

import { KanbanPage } from "../bots/kanban/KanbanPage";
import { parseKanbanSearch } from "../bots/kanban/kanbanPageState";

export const Route = createFileRoute("/_chat/kanban")({
  validateSearch: parseKanbanSearch,
  component: KanbanPage,
});
