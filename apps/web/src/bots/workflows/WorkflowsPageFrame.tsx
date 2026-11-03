import type { EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";

import { isElectron } from "~/env";
import { WorkspacePageHeader } from "../../components/WorkspacePageHeader";
import { Button } from "../../components/ui/button";
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

/** `Workflows › <page>`: the way back to the list from an editor, run or ledger page. */
export function WorkflowsBreadcrumb(props: { environmentId: EnvironmentId; children: ReactNode }) {
  return (
    <>
      <Button
        size="xs"
        variant="ghost-muted"
        render={
          <Link to="/workflows/$environmentId" params={{ environmentId: props.environmentId }} />
        }
      >
        Workflows
      </Button>
      <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      <h1 className="flex min-w-0 items-center gap-2 truncate font-medium text-sm">
        {props.children}
      </h1>
    </>
  );
}

/** A muted line in place of content: loading, unavailable, not found. */
export function WorkflowsNotice(props: { children: ReactNode; tone?: "muted" | "error" }) {
  return (
    <p
      role={props.tone === "error" ? "alert" : "status"}
      className={
        props.tone === "error"
          ? "px-(--workspace-gutter-start) py-8 text-center text-destructive text-sm"
          : "px-(--workspace-gutter-start) py-8 text-center text-muted-foreground text-sm"
      }
    >
      {props.children}
    </p>
  );
}

/** A titled block of a workflows page: a small muted heading, an optional count and actions. */
export function WorkflowsSection(props: {
  title: ReactNode;
  count?: number;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex flex-col">
      <div className="flex h-9 items-center gap-2 border-b bg-muted/40 px-(--workspace-gutter-start) pr-(--workspace-gutter-end) text-sm">
        <h2 className="font-medium">{props.title}</h2>
        {props.count === undefined ? null : (
          <span className="text-muted-foreground tabular-nums">{props.count}</span>
        )}
        <div className="ml-auto flex items-center gap-1">{props.actions}</div>
      </div>
      {props.children}
    </section>
  );
}
