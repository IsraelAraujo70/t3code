import { TriggerIcon } from "./run/TriggerIcon";
import { formatTokens, formatUsd } from "@t3tools/client-runtime/workflows";
import type {
  EnvironmentId,
  WorkflowId,
  WorkflowRunSummary,
  WorkflowSummary,
  WorkflowTemplateSummary,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { PlayIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "../../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../components/ui/menu";
import { Switch } from "../../components/ui/switch";
import { useNowMinute } from "../../hooks/useNowMinute";
import { randomUUID } from "~/lib/utils";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { confirmDestructive, reportCommandResult } from "../botsSettingsShared";
import { NewWorkflowDialog } from "./NewWorkflowDialog";
import { RunNowDialog } from "./RunNowDialog";
import { useWorkflowRuns, useWorkflowsSnapshot, workflowsEnvironment } from "./state";
import { RunStatusBadge, WorkflowToneBadge } from "./WorkflowStatusBadge";
import { WorkflowsNotice, WorkflowsPageFrame } from "./WorkflowsPageFrame";

type Creating = { readonly template: WorkflowTemplateSummary | null } | null;

/** The bots host's workflows: definitions, recent runs and deleted files. */
export function WorkflowsPage(props: { environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const snapshot = useWorkflowsSnapshot(environmentId);
  const [creating, setCreating] = useState<Creating>(null);
  const [running, setRunning] = useState<WorkflowId | null>(null);
  const templates = snapshot.data?.templates ?? [];

  return (
    <WorkflowsPageFrame
      title="Workflows"
      actions={
        <div className="flex items-center gap-1.5">
          <Button
            size="xs"
            variant="ghost-muted"
            render={<Link to="/workflows/$environmentId/ledger" params={{ environmentId }} />}
          >
            Ledger
          </Button>
          {templates.length > 0 ? (
            <Menu>
              <MenuTrigger render={<Button size="xs" variant="outline" />}>
                From template
              </MenuTrigger>
              <MenuPopup align="end">
                {templates.map((template) => (
                  <MenuItem key={template.templateId} onClick={() => setCreating({ template })}>
                    {template.title}
                  </MenuItem>
                ))}
              </MenuPopup>
            </Menu>
          ) : null}
          <Button size="xs" onClick={() => setCreating({ template: null })}>
            <PlusIcon className="size-3.5" />
            New workflow
          </Button>
        </div>
      }
    >
      {snapshot.data === null ? (
        <WorkflowsNotice>
          {snapshot.error === null
            ? "Loading workflows…"
            : `Workflows unavailable: ${snapshot.error}`}
        </WorkflowsNotice>
      ) : (
        <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 py-6">
          <p className="text-xs text-muted-foreground">
            Definitions live in <code>{snapshot.data.repoPath}</code> on the bots host.
          </p>
          <Section title="Workflows">
            {snapshot.data.workflows.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No workflows yet. Start a blank one or copy a template.
              </p>
            ) : (
              snapshot.data.workflows.map((workflow) => (
                <WorkflowRow
                  key={workflow.workflowId}
                  environmentId={environmentId}
                  workflow={workflow}
                  onRun={() => setRunning(workflow.workflowId)}
                />
              ))
            )}
          </Section>
          <RecentRuns environmentId={environmentId} />
          {snapshot.data.deleted.length > 0 ? (
            <Section title="Deleted">
              {snapshot.data.deleted.map((deleted) => (
                <DeletedRow
                  key={deleted.workflowId}
                  environmentId={environmentId}
                  workflowId={deleted.workflowId}
                  title={deleted.title}
                  deletedAt={deleted.deletedAt}
                />
              ))}
            </Section>
          ) : null}
        </div>
      )}
      {creating === null ? null : (
        <NewWorkflowDialog
          environmentId={environmentId}
          template={creating.template}
          onClose={() => setCreating(null)}
        />
      )}
      {running === null ? null : (
        <RunNowDialog
          environmentId={environmentId}
          workflowId={running}
          onClose={() => setRunning(null)}
        />
      )}
    </WorkflowsPageFrame>
  );
}

function Section(props: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h2 className="font-medium text-muted-foreground text-xs">{props.title}</h2>
      <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
        {props.children}
      </div>
    </section>
  );
}

function WorkflowRow(props: {
  environmentId: EnvironmentId;
  workflow: WorkflowSummary;
  onRun: () => void;
}) {
  const { environmentId, workflow } = props;
  const setEnabled = useAtomCommand(workflowsEnvironment.setEnabled, {
    label: "workflow enable",
  });
  const remove = useAtomCommand(workflowsEnvironment.remove, { label: "workflow delete" });
  const lastRun = workflow.lastRun;
  return (
    <div className="flex items-start gap-3 px-3 py-2.5">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <Link
            to="/workflows/$environmentId/$workflowId"
            params={{ environmentId, workflowId: workflow.workflowId }}
            className="truncate font-medium text-sm hover:underline"
          >
            {workflow.title}
          </Link>
          <span className="text-muted-foreground text-xs">{workflow.workflowId}</span>
          {!workflow.valid ? (
            <WorkflowToneBadge tone="danger">
              {`${workflow.diagnostics} error${workflow.diagnostics === 1 ? "" : "s"}`}
            </WorkflowToneBadge>
          ) : null}
          {workflow.dirty ? (
            <WorkflowToneBadge tone="warning">Edited by hand</WorkflowToneBadge>
          ) : null}
          {workflow.suspended ? (
            <WorkflowToneBadge tone="warning">Suspended</WorkflowToneBadge>
          ) : null}
          {lastRun !== null && lastRun.openGates > 0 ? (
            <WorkflowToneBadge tone="warning">Needs you</WorkflowToneBadge>
          ) : null}
        </div>
        {workflow.triggers.length > 0 ? (
          <div className="flex flex-wrap gap-1 text-xs text-muted-foreground">
            {workflow.triggers.map((trigger) => {
              return (
                <span
                  key={trigger.id}
                  className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5"
                >
                  <TriggerIcon kind={trigger.kind} />
                  {trigger.title ?? trigger.label}
                  {trigger.enabled === false ? " · off" : null}
                </span>
              );
            })}
          </div>
        ) : null}
        {lastRun === null ? null : (
          <Link
            to="/workflows/$environmentId/runs/$runId"
            params={{ environmentId, runId: lastRun.runId }}
            className="flex items-center gap-1.5 text-muted-foreground text-xs hover:text-foreground"
          >
            <RunStatusBadge status={lastRun.status} />
            <RelativeTime iso={lastRun.startedAt} />
          </Link>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Switch
          aria-label={workflow.enabled ? "Disable workflow" : "Enable workflow"}
          checked={workflow.enabled}
          onCheckedChange={(enabled) =>
            void setEnabled({
              environmentId,
              input: {
                workflowId: workflow.workflowId,
                enabled,
                clientRequestId: randomUUID(),
              },
            }).then((result) => reportCommandResult("Could not change the workflow", result))
          }
        />
        {workflow.triggers.some((trigger) => trigger.kind === "manual") ? (
          <Button
            size="xs"
            variant="outline"
            disabled={!workflow.valid}
            onClick={props.onRun}
            aria-label="Run now"
          >
            <PlayIcon className="size-3.5" />
            Run
          </Button>
        ) : null}
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label="Delete workflow"
          onClick={async () => {
            if (
              !(await confirmDestructive(`Delete "${workflow.title}"?\nYou can restore it later.`))
            )
              return;
            reportCommandResult(
              "Could not delete the workflow",
              await remove({ environmentId, input: { workflowId: workflow.workflowId } }),
            );
          }}
        >
          <Trash2Icon className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

function RecentRuns(props: { environmentId: EnvironmentId }) {
  const runs = useWorkflowRuns(props.environmentId, { limit: 20 });
  return (
    <Section title="Recent runs">
      {runs.data === null ? (
        <p className="px-3 py-2.5 text-muted-foreground text-sm">
          {runs.error === null ? "Loading runs…" : `Runs unavailable: ${runs.error}`}
        </p>
      ) : runs.data.runs.length === 0 ? (
        <p className="px-3 py-2.5 text-muted-foreground text-sm">No runs yet.</p>
      ) : (
        runs.data.runs.map((run) => (
          <RunRow key={run.runId} environmentId={props.environmentId} run={run} />
        ))
      )}
    </Section>
  );
}

function RunRow(props: { environmentId: EnvironmentId; run: WorkflowRunSummary }) {
  const { run } = props;
  return (
    <Link
      to="/workflows/$environmentId/runs/$runId"
      params={{ environmentId: props.environmentId, runId: run.runId }}
      className="flex items-center gap-3 px-3 py-2 text-sm hover:bg-accent/50"
    >
      <RunStatusBadge status={run.status} />
      <span className="min-w-0 flex-1 truncate">{run.title}</span>
      {run.openGates > 0 ? <WorkflowToneBadge tone="warning">Needs you</WorkflowToneBadge> : null}
      <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
        {formatTokens(run.cost.billable)} tokens · {formatUsd(run.cost.usdEstimate)}
      </span>
      <span className="w-20 shrink-0 text-right text-muted-foreground text-xs">
        <RelativeTime iso={run.startedAt} />
      </span>
    </Link>
  );
}

function DeletedRow(props: {
  environmentId: EnvironmentId;
  workflowId: WorkflowId;
  title: string;
  deletedAt: string;
}) {
  const restore = useAtomCommand(workflowsEnvironment.restore, { label: "workflow restore" });
  return (
    <div className="flex items-center gap-3 px-3 py-2 text-sm">
      <span className="min-w-0 flex-1 truncate">{props.title}</span>
      <span className="text-muted-foreground text-xs">
        deleted <RelativeTime iso={props.deletedAt} />
      </span>
      <Button
        size="xs"
        variant="outline"
        onClick={async () =>
          reportCommandResult(
            "Could not restore the workflow",
            await restore({
              environmentId: props.environmentId,
              input: { workflowId: props.workflowId },
            }),
          )
        }
      >
        Restore
      </Button>
    </div>
  );
}

function RelativeTime(props: { iso: string }) {
  useNowMinute();
  return <time dateTime={props.iso}>{formatRelativeTimeLabel(props.iso)}</time>;
}
