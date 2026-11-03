import type {
  EnvironmentId,
  WorkflowDeletedSummary,
  WorkflowId,
  WorkflowRunSummary,
  WorkflowSummary,
  WorkflowTemplateSummary,
} from "@t3tools/contracts";
import {
  activeWorkflowRuns,
  filterWorkflows,
  hasTabFilters,
  runHistoryKey,
  runsFilterInput,
  workflowsFiltersOf,
  workflowsSearchOf,
  workflowsTabOf,
  type WorkflowsFilters,
  type WorkflowsTab,
} from "@t3tools/client-runtime/workflows";
import { useDebouncedValue } from "@tanstack/react-pacer";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FlaskConicalIcon,
  PlusIcon,
  WorkflowIcon,
} from "lucide-react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../../components/ui/empty";
import { Group, GroupSeparator } from "../../components/ui/group";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "../../components/ui/menu";
import { Skeleton } from "../../components/ui/skeleton";
import { Toggle, ToggleGroup } from "../../components/ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { reportCommandResult } from "../botsSettingsShared";
import { NewWorkflowDialog } from "./NewWorkflowDialog";
import { RunNowDialog } from "./RunNowDialog";
import { useWorkflowsSnapshot, workflowsEnvironment } from "./state";
import { newerRun, useNowMs, WorkflowListRow } from "./WorkflowListRow";
import { useLiveWorkflowRuns, WorkflowRunsTab } from "./WorkflowRunsTab";
import { WorkflowsFilterBar } from "./WorkflowsFilterBar";
import { WorkflowsNotice, WorkflowsPageFrame, WorkflowsSection } from "./WorkflowsPageFrame";

type Creating = { readonly template: WorkflowTemplateSummary | null } | null;

const needsAttention = (workflow: WorkflowSummary) =>
  !workflow.valid || workflow.suspended || (workflow.lastRun?.openGates ?? 0) > 0;

/** The bots host's workflows and their runs, as two tabs with filters kept in the URL. */
export function WorkflowsPage(props: { environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const search = useSearch({ from: "/_chat/workflows/$environmentId/" });
  const navigate = useNavigate({ from: "/workflows/$environmentId/" });
  const tab = workflowsTabOf(search);
  const filters = workflowsFiltersOf(search);
  const snapshot = useWorkflowsSnapshot(environmentId);
  const [creating, setCreating] = useState<Creating>(null);
  const [running, setRunning] = useState<WorkflowId | null>(null);
  const templates = snapshot.data?.templates ?? [];
  const workflows = snapshot.data?.workflows ?? [];
  const historyKey = snapshot.data === null ? null : runHistoryKey(snapshot.data);
  const needsYou =
    snapshot.data === null ? 0 : activeWorkflowRuns(snapshot.data).filter((r) => r.needsYou).length;
  const now = useNowMs();
  // Typing in the search box asks the host once the text settles, not on every key.
  const [query] = useDebouncedValue(filters.query, { wait: 250 });
  const runsFilter = runsFilterInput({ ...filters, query }, workflows, now);

  const show = (nextTab: WorkflowsTab, next: WorkflowsFilters, replace: boolean) =>
    void navigate({ search: workflowsSearchOf(nextTab, next), replace });

  const newWorkflow = (
    <Group aria-label="New workflow">
      <Button size="xs" onClick={() => setCreating({ template: null })}>
        <PlusIcon />
        New workflow
      </Button>
      {templates.length > 0 ? (
        <>
          <GroupSeparator />
          <Menu>
            <MenuTrigger render={<Button size="icon-xs" aria-label="New from a template" />}>
              <ChevronDownIcon />
            </MenuTrigger>
            <MenuPopup align="end" className="max-w-80">
              <MenuGroup>
                <MenuGroupLabel>Start from a template</MenuGroupLabel>
                {templates.map((template) => (
                  <MenuItem key={template.templateId} onClick={() => setCreating({ template })}>
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate">{template.title}</span>
                      {template.description ? (
                        <span className="line-clamp-2 text-muted-foreground text-xs">
                          {template.description}
                        </span>
                      ) : null}
                    </span>
                  </MenuItem>
                ))}
              </MenuGroup>
            </MenuPopup>
          </Menu>
        </>
      ) : null}
    </Group>
  );

  return (
    <WorkflowsPageFrame
      title={
        <>
          <h1 className="shrink-0 truncate font-medium text-sm">Workflows</h1>
          <ToggleGroup
            className="ms-3 shrink-0"
            variant="segmented"
            size="segmented"
            aria-label="Workflows tabs"
            value={[tab]}
            onValueChange={(next) => {
              const picked = next[0];
              if (picked === "workflows" || picked === "runs") show(picked, filters, false);
            }}
          >
            <Toggle value="workflows">Workflows</Toggle>
            <Toggle value="runs">
              Runs
              {needsYou > 0 ? (
                <span className="text-warning tabular-nums">
                  {needsYou}
                  <span className="sr-only"> need you</span>
                </span>
              ) : null}
            </Toggle>
          </ToggleGroup>
        </>
      }
      actions={
        <div className="flex items-center gap-1.5">
          <Button
            size="xs"
            variant="ghost-muted"
            render={<Link to="/workflows/$environmentId/ledger" params={{ environmentId }} />}
          >
            <FlaskConicalIcon />
            Ledger
          </Button>
          {newWorkflow}
        </div>
      }
    >
      {snapshot.data === null ? (
        snapshot.error === null ? (
          <ListSkeleton />
        ) : (
          <div className="flex flex-col items-center gap-3 py-12">
            <WorkflowsNotice tone="error">Workflows unavailable: {snapshot.error}</WorkflowsNotice>
            <Button size="xs" variant="outline" onClick={snapshot.refresh}>
              Try again
            </Button>
          </div>
        )
      ) : workflows.length === 0 ? (
        <>
          <EmptyWorkflows templates={templates} onCreate={setCreating} />
          {snapshot.data.deleted.length > 0 ? (
            <DeletedSection environmentId={environmentId} deleted={snapshot.data.deleted} />
          ) : null}
        </>
      ) : (
        <div className="flex flex-col">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2 pr-(--workspace-gutter-end) pl-(--workspace-gutter-start)">
            {tab === "workflows" ? (
              <StatusLine workflows={workflows} repoPath={snapshot.data.repoPath} />
            ) : null}
            <div className="min-w-0 flex-1">
              <WorkflowsFilterBar
                tab={tab}
                workflows={workflows}
                filters={filters}
                onChange={(next) => show(tab, next, true)}
              />
            </div>
          </div>
          {tab === "workflows" ? (
            <WorkflowsTabContent
              environmentId={environmentId}
              workflows={workflows}
              filters={filters}
              historyKey={historyKey}
              onRun={setRunning}
            />
          ) : (
            <WorkflowRunsTab
              key={JSON.stringify(runsFilter)}
              environmentId={environmentId}
              filter={runsFilter}
              historyKey={historyKey}
              filtered={hasTabFilters("runs", filters) || query.trim() !== ""}
            />
          )}
          {tab === "workflows" && snapshot.data.deleted.length > 0 ? (
            <>
              <div className="h-6" />
              <DeletedSection environmentId={environmentId} deleted={snapshot.data.deleted} />
            </>
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

/** The Workflows tab: the filtered definitions, each with its newest known run. */
function WorkflowsTabContent(props: {
  environmentId: EnvironmentId;
  workflows: ReadonlyArray<WorkflowSummary>;
  filters: WorkflowsFilters;
  historyKey: string | null;
  onRun: (workflowId: WorkflowId) => void;
}) {
  const shown = filterWorkflows(props.workflows, props.filters);
  const runs = useLiveWorkflowRuns(props.environmentId, { limit: 20 }, props.historyKey);
  // An older host's snapshot does not move on run events, so a freshly fetched run list can be newer.
  const listedLastRun = new Map<string, WorkflowRunSummary>();
  for (const run of runs.data?.runs ?? []) {
    listedLastRun.set(run.workflowId, newerRun(listedLastRun.get(run.workflowId), run) ?? run);
  }
  return (
    <WorkflowsSection title="Workflows" count={shown.length}>
      {shown.length === 0 ? (
        <p className="px-(--workspace-gutter-start) py-3 text-muted-foreground text-sm">
          No workflows match these filters.
        </p>
      ) : (
        shown.map((workflow) => (
          <WorkflowListRow
            key={workflow.workflowId}
            environmentId={props.environmentId}
            workflow={workflow}
            lastRun={newerRun(workflow.lastRun, listedLastRun.get(workflow.workflowId))}
            onRun={() => props.onRun(workflow.workflowId)}
          />
        ))
      )}
    </WorkflowsSection>
  );
}

/** One line of counts under the header, like the kanban's; the repository path sits in a tooltip. */
function StatusLine(props: { workflows: ReadonlyArray<WorkflowSummary>; repoPath: string }) {
  const on = props.workflows.filter((workflow) => workflow.enabled).length;
  const attention = props.workflows.filter(needsAttention).length;
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 text-muted-foreground text-xs">
      <span>
        {on} of {props.workflows.length} on
      </span>
      {attention > 0 ? (
        <>
          <span aria-hidden>·</span>
          <span className="text-warning">
            {attention} need{attention === 1 ? "s" : ""} attention
          </span>
        </>
      ) : null}
      <span aria-hidden>·</span>
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="cursor-default underline decoration-dotted underline-offset-2" />
          }
        >
          YAML files on the bots host
        </TooltipTrigger>
        <TooltipPopup>
          <span className="font-mono text-xs">{props.repoPath}</span>
        </TooltipPopup>
      </Tooltip>
    </p>
  );
}

function EmptyWorkflows(props: {
  templates: ReadonlyArray<WorkflowTemplateSummary>;
  onCreate: (creating: Creating) => void;
}) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <WorkflowIcon />
        </EmptyMedia>
        <EmptyTitle>No workflows yet</EmptyTitle>
        <EmptyDescription>
          A workflow runs agent and command steps on the bots host when a schedule, a new release, a
          webhook or a bot starts it.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button size="sm" onClick={() => props.onCreate({ template: null })}>
          <PlusIcon />
          New workflow
        </Button>
        {props.templates.length > 0 ? (
          <div className="flex w-full max-w-md flex-col gap-1.5 pt-2">
            <span className="text-muted-foreground text-xs">Or start from a template</span>
            {props.templates.map((template) => (
              <button
                key={template.templateId}
                type="button"
                className="flex cursor-pointer flex-col rounded-lg border px-3 py-2 text-left hover:bg-accent/50"
                onClick={() => props.onCreate({ template })}
              >
                <span className="font-medium text-sm">{template.title}</span>
                {template.description ? (
                  <span className="line-clamp-2 text-muted-foreground text-xs">
                    {template.description}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        ) : null}
      </EmptyContent>
    </Empty>
  );
}

/** Deleted workflows, folded away until opened; each one restores its last committed file. */
function DeletedSection(props: {
  environmentId: EnvironmentId;
  deleted: ReadonlyArray<WorkflowDeletedSummary>;
}) {
  const [open, setOpen] = useState(false);
  const restore = useAtomCommand(workflowsEnvironment.restore, { label: "workflow restore" });
  const Caret = open ? ChevronDownIcon : ChevronRightIcon;
  return (
    <WorkflowsSection
      title={
        <button
          type="button"
          aria-expanded={open}
          className="flex cursor-pointer items-center gap-2"
          onClick={() => setOpen((value) => !value)}
        >
          <Caret aria-hidden className="size-3.5 text-muted-foreground" />
          Deleted
        </button>
      }
      count={props.deleted.length}
    >
      {open
        ? props.deleted.map((deleted) => (
            <div
              key={deleted.workflowId}
              className="flex h-10 items-center gap-3 border-b pr-(--workspace-gutter-end) pl-(--workspace-gutter-start) text-sm"
            >
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{deleted.title}</span>
              <span className="text-muted-foreground text-xs">
                deleted {formatRelativeTimeLabel(deleted.deletedAt)}
              </span>
              <Button
                size="xs"
                variant="outline"
                onClick={async () =>
                  reportCommandResult(
                    "Could not restore the workflow",
                    await restore({
                      environmentId: props.environmentId,
                      input: { workflowId: deleted.workflowId },
                    }),
                  )
                }
              >
                Restore
              </Button>
            </div>
          ))
        : null}
    </WorkflowsSection>
  );
}

function ListSkeleton() {
  return (
    <div aria-busy className="flex flex-col">
      <p className="sr-only" role="status">
        Loading workflows…
      </p>
      <div className="px-(--workspace-gutter-start) pb-2">
        <Skeleton className="h-3 w-40" />
      </div>
      <div className="h-9 border-b bg-muted/40" />
      {[0, 1, 2, 3].map((index) => (
        <div
          key={index}
          className="flex h-14 items-center gap-3 border-b pr-(--workspace-gutter-end) pl-(--workspace-gutter-start)"
        >
          <Skeleton shape="pill" className="size-2" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton className="h-3 w-64" />
            <Skeleton className="h-2.5 w-40" />
          </div>
          <Skeleton className="h-3 w-20" />
          <Skeleton shape="pill" className="h-4 w-7" />
        </div>
      ))}
    </div>
  );
}
