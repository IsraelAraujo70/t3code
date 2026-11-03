import { activeWorkflowRuns, runStatusLabel } from "@t3tools/client-runtime/workflows";
import { Link } from "@tanstack/react-router";
import { HandIcon } from "lucide-react";

import { ThreadDetailsSection } from "../../components/chat/ThreadDetailsSection";
import { THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS } from "../../components/chat/threadDetailsPanelStyles";
import { cn } from "../../lib/utils";
import { useBotsEnvironmentId } from "../../state/bots";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { BotAvatar } from "../BotAvatar";
import { useWorkflowsSnapshot } from "./state";
import { useNowMs } from "./WorkflowListRow";
import { RunStatusIcon } from "./WorkflowStatusBadge";

/** The bots host's runs that have not ended, from the live workflows snapshot. */
function useActiveWorkflowRuns() {
  const environmentId = useBotsEnvironmentId();
  const snapshot = useWorkflowsSnapshot(environmentId).data;
  return { environmentId, runs: snapshot ? activeWorkflowRuns(snapshot) : [] };
}

/** A dot on the thread details toggle while a run waits for the user. */
export function WorkflowsAttentionDot() {
  const waiting = useActiveWorkflowRuns().runs.filter((r) => r.needsYou).length;
  if (waiting === 0) return null;
  return (
    <>
      <span
        aria-hidden
        className="pointer-events-none absolute top-1 right-1 size-2 rounded-full bg-warning ring-2 ring-background"
      />
      <span className="sr-only">
        {waiting === 1 ? "A workflow run needs you" : `${waiting} workflow runs need you`}
      </span>
    </>
  );
}

/** The thread details card's Workflows section: active runs, those that need the user first. */
export function WorkflowsActiveSection() {
  const { environmentId, runs } = useActiveWorkflowRuns();
  const now = useNowMs();
  if (environmentId === null || runs.length === 0) return null;
  return (
    <ThreadDetailsSection
      headingId="thread-details-workflows-heading"
      title="Workflows"
      data-thread-workflows-panel
    >
      <ul className="m-0 list-none p-0">
        {runs.map(({ run, workflow, needsYou, since }) => (
          <li key={run.runId}>
            <Link
              to="/workflows/$environmentId/runs/$runId"
              params={{ environmentId, runId: run.runId }}
              className={cn(
                "flex flex-col gap-0.5 rounded-lg py-1.5 hover:bg-black/[0.035] dark:hover:bg-white/[0.08]",
                THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
                needsYou && "bg-warning/8",
              )}
            >
              <span className="flex min-w-0 items-center gap-1.5">
                {workflow?.bot ? <BotAvatar botId={workflow.bot.id} size={14} /> : null}
                <span className="min-w-0 flex-1 truncate font-medium text-foreground/80 text-sm">
                  {run.title}
                </span>
                <time dateTime={since} className="shrink-0 text-2xs text-muted-foreground">
                  {formatRelativeTimeLabel(since, now)}
                </time>
              </span>
              {needsYou ? (
                <span className="flex min-w-0 items-start gap-1.5 text-2xs text-warning-foreground">
                  <HandIcon aria-hidden className="mt-px size-3 shrink-0 text-warning" />
                  <span className="line-clamp-2">
                    {run.gate?.reason ?? (run.openGates > 0 ? "Needs you" : "Paused, needs you")}
                  </span>
                </span>
              ) : (
                <span className="flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
                  <RunStatusIcon status={run.status} className="size-3" />
                  <span className="truncate">{runStatusLabel(run.status)}</span>
                </span>
              )}
            </Link>
          </li>
        ))}
      </ul>
    </ThreadDetailsSection>
  );
}
