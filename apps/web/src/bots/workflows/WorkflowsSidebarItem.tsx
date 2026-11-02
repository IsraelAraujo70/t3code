import { useNavigate } from "@tanstack/react-router";
import { WorkflowIcon } from "lucide-react";
import type { ComponentType, ReactNode } from "react";

import { useSidebar } from "../../components/ui/sidebar";
import { useBotsEnvironmentId } from "../../state/bots";

/**
 * The sidebar footer's Workflows button, after Kanban. Like Kanban it shows only while a bots host
 * is connected, so Workflows is reachable in every sidebar layout and with no bots yet.
 */
export function WorkflowsSidebarItem({
  Item,
}: {
  readonly Item: ComponentType<{ icon: ReactNode; label: string; onClick: () => void }>;
}) {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const environmentId = useBotsEnvironmentId();
  if (environmentId === null) return null;
  return (
    <Item
      icon={<WorkflowIcon />}
      label="Workflows"
      onClick={() => {
        if (isMobile) setOpenMobile(false);
        void navigate({ to: "/workflows/$environmentId", params: { environmentId } });
      }}
    />
  );
}
