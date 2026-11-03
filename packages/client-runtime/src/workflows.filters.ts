/**
 * The Workflows page's tabs and Linear-style filters: what the URL carries, which workflows a
 * filter keeps, and the run-list query the host answers. Shared by web and Android.
 */
import type {
  WorkflowRunListState,
  WorkflowRunsListInput,
  WorkflowRunSummary,
  WorkflowSummary,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { runNeedsYou } from "./workflows.run.ts";

export type WorkflowsTab = "workflows" | "runs";

/** The run filter's status choices and the list states each stands for. */
const RUN_STATE_FILTERS = {
  running: ["queued", "running", "paused"],
  needs_you: ["needs_you"],
  succeeded: ["succeeded"],
  failed: ["failed", "budget_exhausted"],
  cancelled: ["cancelled"],
  skipped: ["skipped"],
} as const satisfies Record<string, ReadonlyArray<WorkflowRunListState>>;
export type RunStateFilter = keyof typeof RUN_STATE_FILTERS;

export const RUN_STATE_FILTER_LABELS: Readonly<Record<RunStateFilter, string>> = {
  running: "Running",
  needs_you: "Needs you",
  succeeded: "Succeeded",
  failed: "Failed",
  cancelled: "Cancelled",
  skipped: "Skipped",
};

const HOUR_MS = 3_600_000;
const RUN_PERIODS = {
  "24h": 24 * HOUR_MS,
  "7d": 7 * 24 * HOUR_MS,
  "30d": 30 * 24 * HOUR_MS,
};
export type RunPeriod = keyof typeof RUN_PERIODS;

export const RUN_PERIOD_LABELS: Readonly<Record<RunPeriod, string>> = {
  "24h": "Last 24 hours",
  "7d": "Last 7 days",
  "30d": "Last 30 days",
};

/** Trigger kinds in words; a kind this client does not know shows as itself. */
const TRIGGER_KIND_LABELS: Readonly<Record<string, string>> = {
  manual: "Run now",
  bot: "Bot",
  call: "Another workflow",
  webhook: "Webhook",
  cron: "Schedule",
  upstreamTag: "New upstream tag",
  prMerged: "PR merged",
  threadSettled: "Thread finished",
  workflowFailed: "Workflow failed",
};
const triggerKindLabel = (kind: string): string => TRIGGER_KIND_LABELS[kind] ?? kind;

/** The bot filter's value for workflows that work for no bot. */
export const NO_BOT = "none";
const workflowBotKey = (workflow: Pick<WorkflowSummary, "bot">): string =>
  workflow.bot?.id ?? NO_BOT;

export interface WorkflowsFilters {
  /** Bot ids, or `NO_BOT`. Both tabs. */
  readonly bots: ReadonlyArray<string>;
  /** Trigger kinds. Both tabs: a workflow that has one, a run that one started. */
  readonly triggers: ReadonlyArray<string>;
  /** Both tabs: title or description of a workflow, title or trigger of a run. */
  readonly query: string;
  /** Workflows tab only. */
  readonly enabled: "on" | "off" | null;
  /** Runs tab only. */
  readonly workflows: ReadonlyArray<string>;
  readonly states: ReadonlyArray<RunStateFilter>;
  readonly period: RunPeriod | null;
}

export const EMPTY_WORKFLOWS_FILTERS: WorkflowsFilters = {
  bots: [],
  triggers: [],
  query: "",
  enabled: null,
  workflows: [],
  states: [],
  period: null,
};

/** Whether any filter but the search box is set on this tab. */
export const hasTabFilters = (tab: WorkflowsTab, filters: WorkflowsFilters): boolean =>
  filters.bots.length > 0 ||
  filters.triggers.length > 0 ||
  (tab === "workflows"
    ? filters.enabled !== null
    : filters.workflows.length > 0 || filters.states.length > 0 || filters.period !== null);

/** `/workflows/<env>` search params; lists are comma-separated so links stay readable. */
export interface WorkflowsSearch {
  readonly tab?: "runs";
  readonly bot?: string;
  readonly trigger?: string;
  readonly q?: string;
  readonly on?: "on" | "off";
  readonly workflow?: string;
  readonly status?: string;
  readonly period?: RunPeriod;
}

const LIST_VALUE = /^[A-Za-z0-9_.:-]{1,128}$/;
const listOf = (value: unknown): string[] =>
  typeof value === "string"
    ? [...new Set(value.split(",").filter((item) => LIST_VALUE.test(item)))].slice(0, 50)
    : [];
const isState = (value: string): value is RunStateFilter => Object.hasOwn(RUN_STATE_FILTERS, value);
const isPeriod = (value: unknown): value is RunPeriod =>
  typeof value === "string" && Object.hasOwn(RUN_PERIODS, value);

/** Reads the URL leniently: unknown values are dropped, never an error page. */
export function parseWorkflowsSearch(raw: Record<string, unknown>): WorkflowsSearch {
  const bots = listOf(raw.bot);
  const triggers = listOf(raw.trigger);
  const workflows = listOf(raw.workflow);
  const states = listOf(raw.status).filter(isState);
  const q = typeof raw.q === "string" ? raw.q.slice(0, 200) : "";
  return {
    ...(raw.tab === "runs" ? { tab: "runs" as const } : {}),
    ...(bots.length > 0 ? { bot: bots.join(",") } : {}),
    ...(triggers.length > 0 ? { trigger: triggers.join(",") } : {}),
    ...(q.trim() !== "" ? { q } : {}),
    ...(raw.on === "on" || raw.on === "off" ? { on: raw.on } : {}),
    ...(workflows.length > 0 ? { workflow: workflows.join(",") } : {}),
    ...(states.length > 0 ? { status: states.join(",") } : {}),
    ...(isPeriod(raw.period) ? { period: raw.period } : {}),
  };
}

export const workflowsTabOf = (search: WorkflowsSearch): WorkflowsTab =>
  search.tab === "runs" ? "runs" : "workflows";

export function workflowsFiltersOf(search: WorkflowsSearch): WorkflowsFilters {
  return {
    bots: listOf(search.bot),
    triggers: listOf(search.trigger),
    query: search.q ?? "",
    enabled: search.on ?? null,
    workflows: listOf(search.workflow),
    states: listOf(search.status).filter(isState),
    period: search.period ?? null,
  };
}

/** The URL for a tab and its filters; a tab drops the other tab's filters. */
export function workflowsSearchOf(tab: WorkflowsTab, filters: WorkflowsFilters): WorkflowsSearch {
  const list = (values: ReadonlyArray<string>) =>
    values.length > 0 ? values.join(",") : undefined;
  const entries = {
    tab: tab === "runs" ? ("runs" as const) : undefined,
    bot: list(filters.bots),
    trigger: list(filters.triggers),
    q: filters.query.trim() === "" ? undefined : filters.query,
    ...(tab === "workflows"
      ? { on: filters.enabled ?? undefined }
      : {
          workflow: list(filters.workflows),
          status: list(filters.states),
          period: filters.period ?? undefined,
        }),
  };
  return parseWorkflowsSearch(
    Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined)),
  );
}

const contains = (text: string | null | undefined, needle: string) =>
  text != null && text.toLowerCase().includes(needle);

/** The workflows the Workflows tab's filters keep, in their order. */
export function filterWorkflows(
  workflows: ReadonlyArray<WorkflowSummary>,
  filters: WorkflowsFilters,
): WorkflowSummary[] {
  const needle = filters.query.trim().toLowerCase();
  return workflows.filter(
    (workflow) =>
      (filters.bots.length === 0 || filters.bots.includes(workflowBotKey(workflow))) &&
      (filters.triggers.length === 0 ||
        workflow.triggers.some((trigger) => filters.triggers.includes(trigger.kind))) &&
      (filters.enabled === null || workflow.enabled === (filters.enabled === "on")) &&
      (needle === "" || contains(workflow.title, needle) || contains(workflow.description, needle)),
  );
}

export type WorkflowRunsFilterInput = Omit<WorkflowRunsListInput, "cursor" | "limit">;

/**
 * The Runs tab's filters as a run-list query. A bot stands for the workflows that work for it
 * now, so runs from before a workflow changed bots follow the workflow. A period starts on the
 * hour, which keeps the query stable while the page stays open.
 */
export function runsFilterInput(
  filters: WorkflowsFilters,
  workflows: ReadonlyArray<WorkflowSummary>,
  nowMs: number,
): WorkflowRunsFilterInput {
  const picked = filters.workflows.length === 0 ? null : new Set(filters.workflows);
  const workflowIds =
    filters.bots.length === 0
      ? picked === null
        ? undefined
        : workflows
            .filter((workflow) => picked.has(workflow.workflowId))
            .map((workflow) => workflow.workflowId)
      : workflows
          .filter(
            (workflow) =>
              filters.bots.includes(workflowBotKey(workflow)) &&
              (picked === null || picked.has(workflow.workflowId)),
          )
          .map((workflow) => workflow.workflowId);
  const query = filters.query.trim();
  return {
    ...(workflowIds === undefined ? {} : { workflowIds }),
    ...(filters.states.length === 0
      ? {}
      : { states: [...new Set(filters.states.flatMap((state) => RUN_STATE_FILTERS[state]))] }),
    ...(filters.triggers.length === 0 ? {} : { triggerKinds: [...filters.triggers] }),
    ...(filters.period === null
      ? {}
      : {
          startedAfter: DateTime.formatIso(
            DateTime.makeUnsafe(
              Math.floor(nowMs / HOUR_MS) * HOUR_MS - RUN_PERIODS[filters.period],
            ),
          ),
        }),
    ...(query === "" ? {} : { query }),
  };
}

/** A run's state as the list filters it. */
const runListState = (run: WorkflowRunSummary): WorkflowRunListState =>
  runNeedsYou(run) ? "needs_you" : run.status;

/**
 * The host's run-list filter on the client. Older hosts ignore the newer fields and answer with
 * unfiltered runs, so the page re-applies the query to what it gets.
 */
export function runMatchesListInput(
  run: WorkflowRunSummary,
  input: WorkflowRunsFilterInput,
): boolean {
  // The host folds ASCII case only (SQLite `lower`), so the client does the same.
  const fold = (text: string) => text.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const needle = fold(input.query?.trim() ?? "");
  const has = (text: string) => fold(text).includes(needle);
  return (
    (input.workflowId === undefined || run.workflowId === input.workflowId) &&
    (input.status === undefined || run.status === input.status) &&
    (input.workflowIds === undefined || input.workflowIds.includes(run.workflowId)) &&
    (input.states === undefined || input.states.includes(runListState(run))) &&
    (input.triggerKinds === undefined || input.triggerKinds.includes(run.trigger.kind)) &&
    (input.startedAfter === undefined ||
      Date.parse(run.startedAt) >= Date.parse(input.startedAfter)) &&
    (needle === "" || has(run.title) || has(run.trigger.label))
  );
}

export interface WorkflowsFilterOption {
  readonly value: string;
  readonly label: string;
  /** Workflows with this value; null where the count would need the host (runs). */
  readonly count: number | null;
}

/** The values each filter offers, drawn from the host's workflows, with workflow counts. */
export function workflowsFilterOptions(workflows: ReadonlyArray<WorkflowSummary>): {
  readonly bots: ReadonlyArray<WorkflowsFilterOption>;
  readonly triggers: ReadonlyArray<WorkflowsFilterOption>;
  readonly workflows: ReadonlyArray<WorkflowsFilterOption>;
} {
  const bots = new Map<string, { label: string; count: number }>();
  const triggers = new Map<string, number>();
  for (const workflow of workflows) {
    const key = workflowBotKey(workflow);
    const label = workflow.bot ? (workflow.bot.name ?? workflow.bot.id) : "No bot";
    bots.set(key, { label, count: (bots.get(key)?.count ?? 0) + 1 });
    for (const kind of new Set(workflow.triggers.map((trigger) => trigger.kind)))
      triggers.set(kind, (triggers.get(kind) ?? 0) + 1);
  }
  const byLabel = (a: WorkflowsFilterOption, b: WorkflowsFilterOption) =>
    a.value === NO_BOT ? 1 : b.value === NO_BOT ? -1 : a.label.localeCompare(b.label);
  return {
    bots: [...bots].map(([value, { label, count }]) => ({ value, label, count })).sort(byLabel),
    triggers: [...triggers]
      .map(([value, count]) => ({ value, label: triggerKindLabel(value), count }))
      .sort(byLabel),
    workflows: workflows.map((workflow) => ({
      value: workflow.workflowId,
      label: workflow.title,
      count: null,
    })),
  };
}
