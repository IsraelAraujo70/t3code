import type { ReactNode } from "react";

import { isElectron } from "~/env";
import { WorkspacePageHeader } from "../../components/WorkspacePageHeader";
import { SidebarInset, SidebarTrigger } from "../../components/ui/sidebar";

/** Page chrome shared by the Workflows list, editor and run pages, like the kanban's. */
export function WorkflowsPageFrame(props: {
  title: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
        <WorkspacePageHeader
          electron={isElectron}
          reserveNativeControls={isElectron}
          className="relative bg-background"
        >
          <SidebarTrigger className="md:hidden" />
          <div className="flex min-w-0 items-center gap-1">
            {typeof props.title === "string" ? (
              <h1 className="shrink-0 truncate font-medium text-sm">{props.title}</h1>
            ) : (
              props.title
            )}
          </div>
          <div className="min-w-0 flex-1" />
          {props.actions}
        </WorkspacePageHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">{props.children}</div>
      </div>
    </SidebarInset>
  );
}

/** A muted line in place of content: loading, unavailable, not found. */
export function WorkflowsNotice(props: { children: ReactNode }) {
  return <p className="px-6 py-8 text-center text-sm text-muted-foreground">{props.children}</p>;
}
