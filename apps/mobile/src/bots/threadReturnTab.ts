import type { WorkspaceTab } from "../features/workspace/workspace-tabs-state";

/**
 * A thread opened from a top-level tab other than Chats names that tab in its route params, so
 * Android Back (and the header's up arrow) return to it. Only the Kanban tab does this.
 */
export type ThreadReturnTab = Extract<WorkspaceTab, "kanban">;

/** The tab a thread route returns to; Chats unless the route says otherwise. */
export function threadReturnTab(params: object | undefined): WorkspaceTab {
  const value = (params as { readonly returnTab?: unknown } | undefined)?.returnTab;
  return value === "kanban" ? "kanban" : "threads";
}
