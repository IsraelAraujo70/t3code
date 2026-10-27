import { useNavigate } from "@tanstack/react-router";
import { SquareKanbanIcon } from "lucide-react";
import type { ComponentType, ReactNode } from "react";

import { useSidebar } from "../../components/ui/sidebar";
import { useBotsEnvironmentId } from "../../state/bots";

/**
 * The sidebar footer's Kanban button, right after Pull Requests. It renders through the footer's
 * own item so it looks like its neighbours, and only while a bots host is connected.
 */
export function KanbanSidebarItem({
  Item,
}: {
  readonly Item: ComponentType<{ icon: ReactNode; label: string; onClick: () => void }>;
}) {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  if (useBotsEnvironmentId() === null) return null;
  return (
    <Item
      icon={<SquareKanbanIcon />}
      label="Kanban"
      onClick={() => {
        if (isMobile) setOpenMobile(false);
        void navigate({ to: "/kanban" });
      }}
    />
  );
}
