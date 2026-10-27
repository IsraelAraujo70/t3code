/**
 * What one sync of a project link writes, decided without I/O.
 *
 * A full sync asks Linear for the board's window (open issues plus recently updated ones). Synced
 * tickets outside it are dropped, except tickets with linked threads: those are refreshed by id
 * and kept while they stay unarchived in the link's team, so a finished ticket keeps its threads.
 * An incremental sync asks only for issues updated since the cursor and drops the archived ones.
 */
import type { KanbanTicket } from "@t3tools/contracts";

import type { LinearIssue } from "./LinearClient.ts";

export interface SyncPlan {
  readonly upserts: ReadonlyArray<LinearIssue>;
  /** Issue ids whose synced tickets go. */
  readonly drops: ReadonlyArray<string>;
  /** The greatest `updatedAt` seen; null when nothing came back. */
  readonly cursor: string | null;
}

const maxUpdatedAt = (issues: ReadonlyArray<LinearIssue>): string | null =>
  issues.reduce<string | null>(
    (max, issue) => (max === null || issue.updatedAt > max ? issue.updatedAt : max),
    null,
  );

const belongs = (issue: LinearIssue, teamId: string) =>
  issue.archivedAt === null && issue.teamId === teamId;

/** Incremental: every fetched issue is either refreshed or, once it left the board, dropped. */
export function planIncrementalSync(teamId: string, fetched: ReadonlyArray<LinearIssue>): SyncPlan {
  return {
    upserts: fetched.filter((issue) => belongs(issue, teamId)),
    drops: fetched.filter((issue) => !belongs(issue, teamId)).map((issue) => issue.id),
    cursor: maxUpdatedAt(fetched),
  };
}

/** The synced tickets a full sync did not see and that have threads, to refresh by id. */
export function ticketsToRefresh(
  existing: ReadonlyArray<KanbanTicket>,
  window: ReadonlyArray<LinearIssue>,
): ReadonlyArray<string> {
  const seen = new Set(window.map((issue) => issue.id));
  return existing.flatMap((ticket) =>
    ticket.linear !== null && !seen.has(ticket.linear.issueId) && ticket.threadIds.length > 0
      ? [ticket.linear.issueId]
      : [],
  );
}

/**
 * Full: the window's issues plus the refreshed ones that still belong are kept; every other
 * synced ticket of the project is dropped.
 */
export function planFullSync(
  teamId: string,
  existing: ReadonlyArray<KanbanTicket>,
  window: ReadonlyArray<LinearIssue>,
  refreshed: ReadonlyArray<LinearIssue>,
): SyncPlan {
  const upserts = [...window, ...refreshed].filter((issue) => belongs(issue, teamId));
  const kept = new Set(upserts.map((issue) => issue.id));
  const drops = existing.flatMap((ticket) =>
    ticket.linear !== null && !kept.has(ticket.linear.issueId) ? [ticket.linear.issueId] : [],
  );
  return { upserts, drops, cursor: maxUpdatedAt(window) };
}
