/**
 * The Android Workflows screen's choices: the filter pills each tab shows (the shared filters in
 * `workflows.filters.ts`, as native menus), what a menu pick does to them, and the words a row or a
 * "Needs you" card shows for a run.
 */
import type {
  WorkflowRunSummary,
  WorkflowStepAttemptView,
  WorkflowStepStatus,
  WorkflowSummary,
} from "@t3tools/contracts";
import {
  describeTrigger,
  formatUsd,
  stepDurationMs,
  stepStatusLabel,
  formatDuration,
  formatTokens,
  hasTabFilters,
  liveActiveMs,
  RUN_PERIOD_LABELS,
  RUN_STATE_FILTER_LABELS,
  type RunPeriod,
  type RunStateFilter,
  type WorkflowsFilterOption,
  type WorkflowsFilters,
  type WorkflowsTab,
  type WorkflowTone,
} from "@t3tools/client-runtime/workflows";

interface FilterMenuAction {
  readonly id: string;
  readonly title: string;
  readonly state?: "on" | "off";
  readonly attributes?: { readonly disabled?: boolean };
}

interface FilterPill {
  readonly key: string;
  readonly label: string;
  readonly active: boolean;
  readonly accessibilityLabel: string;
  readonly actions: ReadonlyArray<FilterMenuAction>;
}

type ListField = "bots" | "triggers" | "workflows" | "states";
type Choice =
  | readonly [ListField, string]
  | readonly ["enabled", "on" | "off" | ""]
  | readonly ["period", RunPeriod | ""]
  | readonly ["reset", ""];

const choiceId = (choice: Choice) => JSON.stringify(choice);

const isPeriod = (value: string): value is RunPeriod => Object.hasOwn(RUN_PERIOD_LABELS, value);
const isState = (value: string): value is RunStateFilter =>
  Object.hasOwn(RUN_STATE_FILTER_LABELS, value);

function parseChoice(id: string): Choice | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(id);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) return null;
  const [field, value] = parsed as [unknown, unknown];
  if (typeof value !== "string") return null;
  switch (field) {
    case "bots":
    case "triggers":
    case "workflows":
      return [field, value];
    case "states":
      return isState(value) ? [field, value] : null;
    case "enabled":
      return value === "on" || value === "off" || value === "" ? [field, value] : null;
    case "period":
      return value === "" || isPeriod(value) ? [field, value] : null;
    case "reset":
      return ["reset", ""];
    default:
      return null;
  }
}

const toggle = <A extends string>(values: ReadonlyArray<A>, value: A): A[] =>
  values.includes(value) ? values.filter((item) => item !== value) : [...values, value];

/**
 * The filters after a menu pick: list filters toggle the picked value, the switch and the period
 * replace theirs, and reset clears every filter on the tab but keeps the search text. An id this
 * screen did not make changes nothing.
 */
export function applyFilterChoice(
  tab: WorkflowsTab,
  filters: WorkflowsFilters,
  id: string,
): WorkflowsFilters {
  const choice = parseChoice(id);
  if (choice === null) return filters;
  switch (choice[0]) {
    case "reset":
      return tab === "workflows"
        ? { ...filters, bots: [], triggers: [], enabled: null }
        : { ...filters, bots: [], triggers: [], workflows: [], states: [], period: null };
    case "enabled":
      return { ...filters, enabled: choice[1] === "" ? null : choice[1] };
    case "period":
      return { ...filters, period: choice[1] === "" ? null : choice[1] };
    case "states":
      return isState(choice[1])
        ? { ...filters, states: toggle(filters.states, choice[1]) }
        : filters;
    default:
      return { ...filters, [choice[0]]: toggle(filters[choice[0]], choice[1]) };
  }
}

/** The filters set on this tab, the search text aside: the count on the reset pill. */
export function activeFilterCount(tab: WorkflowsTab, filters: WorkflowsFilters): number {
  const common = filters.bots.length + filters.triggers.length;
  return tab === "workflows"
    ? common + Number(filters.enabled !== null)
    : common + filters.workflows.length + filters.states.length + Number(filters.period !== null);
}

function listPill(
  field: ListField,
  name: string,
  options: ReadonlyArray<WorkflowsFilterOption>,
  selected: ReadonlyArray<string>,
): FilterPill {
  const picked = options.filter((option) => selected.includes(option.value));
  // A value the host no longer offers stays listed while it is selected, so it can be cleared.
  const stale = selected
    .filter((value) => !options.some((option) => option.value === value))
    .map((value) => ({ value, label: value, count: null }));
  return {
    key: field,
    label:
      selected.length === 0
        ? name
        : selected.length === 1
          ? (picked[0]?.label ?? selected[0]!)
          : `${name} · ${selected.length}`,
    active: selected.length > 0,
    accessibilityLabel: `Filter by ${name.toLowerCase()}`,
    actions: [...stale, ...options].map((option) => ({
      id: choiceId([field, option.value]),
      title: option.count === null ? option.label : `${option.label} (${option.count})`,
      state: selected.includes(option.value) ? "on" : "off",
    })),
  };
}

function singlePill<V extends string>(
  field: "enabled" | "period",
  name: string,
  anyLabel: string,
  labels: Readonly<Record<V, string>>,
  selected: V | null,
): FilterPill {
  const entries = Object.entries(labels) as [V, string][];
  return {
    key: field,
    label: selected === null ? name : labels[selected],
    active: selected !== null,
    accessibilityLabel: `Filter by ${name.toLowerCase()}`,
    actions: [
      {
        id: choiceId([field, ""] as Choice),
        title: anyLabel,
        state: selected === null ? "on" : "off",
      },
      ...entries.map(([value, title]) => ({
        id: choiceId([field, value] as Choice),
        title,
        state: value === selected ? ("on" as const) : ("off" as const),
      })),
    ],
  };
}

/** The pills a tab shows, in order, each with its menu. */
export function filterPills(
  tab: WorkflowsTab,
  filters: WorkflowsFilters,
  options: {
    readonly bots: ReadonlyArray<WorkflowsFilterOption>;
    readonly triggers: ReadonlyArray<WorkflowsFilterOption>;
    readonly workflows: ReadonlyArray<WorkflowsFilterOption>;
  },
): FilterPill[] {
  const bot = listPill("bots", "Bot", options.bots, filters.bots);
  const trigger = listPill("triggers", "Trigger", options.triggers, filters.triggers);
  if (tab === "workflows")
    return [
      bot,
      singlePill("enabled", "Switch", "On and off", { on: "On", off: "Off" }, filters.enabled),
      trigger,
    ];
  const states = Object.entries(RUN_STATE_FILTER_LABELS).map(([value, label]) => ({
    value,
    label,
    count: null,
  }));
  return [
    listPill("states", "Status", states, filters.states),
    bot,
    listPill("workflows", "Workflow", options.workflows, filters.workflows),
    singlePill("period", "Started", "Any time", RUN_PERIOD_LABELS, filters.period),
    trigger,
  ];
}

/** The reset choice's id, for a pill that clears the tab's filters. */
export const RESET_FILTERS_ID = choiceId(["reset", ""]);

/** Whether the tab shows the "no match" empty state rather than "nothing yet". */
export const isFiltered = (tab: WorkflowsTab, filters: WorkflowsFilters) =>
  hasTabFilters(tab, filters) || filters.query.trim() !== "";

const PAUSE_WORDS = {
  fatigue: "Paused after too many failures in a row",
  ambiguous: "Paused: a step's outcome needs review",
  user: "Paused at your request",
  daily_cap: "Paused: the host's daily token limit was reached",
} as const;

/** What a run waits on, in a line: the gate's short reason, else why it paused. */
export function needsYouLine(
  run: Pick<WorkflowRunSummary, "gate" | "openGates" | "pausedFor">,
): string {
  if (run.gate) return run.gate.reason;
  if (run.openGates > 0) return "Waiting for your decision";
  return run.pausedFor === null ? "Needs you" : PAUSE_WORDS[run.pausedFor];
}

const LOCAL_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** A run's trigger in words: a schedule reads as "Daily at 21:00", not its cron line. */
export const runTriggerText = (run: Pick<WorkflowRunSummary, "trigger">): string =>
  describeTrigger(
    { kind: run.trigger.kind, title: null, label: run.trigger.label },
    LOCAL_TIME_ZONE,
  ).text;

/** A run row's last line: trigger, active time, and tokens when it used any. */
export function runMetaLine(run: WorkflowRunSummary, nowMs: number): string {
  const activeMs = liveActiveMs(run, nowMs);
  return [
    runTriggerText(run),
    activeMs === null || activeMs === 0 ? null : formatDuration(activeMs),
    run.cost.billable > 0 ? `${formatTokens(run.cost.billable)} tokens` : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

/** The one thing a workflow row flags beside its last run, worst first; null when none. */
export function workflowFlag(
  workflow: Pick<WorkflowSummary, "valid" | "suspended" | "enabled">,
): { readonly label: string; readonly tone: WorkflowTone } | null {
  if (!workflow.valid) return { label: "Invalid", tone: "danger" };
  if (workflow.suspended) return { label: "Suspended", tone: "warning" };
  if (!workflow.enabled) return { label: "Off", tone: "muted" };
  return null;
}

/** A workflow's triggers for its row: the first in words, then how many more. */
export function triggersLine(workflow: Pick<WorkflowSummary, "triggers">): string | null {
  const [first, ...rest] = workflow.triggers;
  if (first === undefined) return null;
  const text = describeTrigger(first, LOCAL_TIME_ZONE).text;
  return rest.length === 0 ? text : `${text} +${rest.length}`;
}

/** Why Run now is not offered, or null when it is. */
export function runNowBlocker(
  workflow: Pick<WorkflowSummary, "valid" | "triggers">,
  allowed: boolean,
): string | null {
  if (!workflow.triggers.some((trigger) => trigger.kind === "manual"))
    return "This workflow has no Run now trigger.";
  if (!workflow.valid) return "Fix the workflow on desktop before running it.";
  if (!allowed) return "This device may not start runs.";
  return null;
}

const REFUSAL = /^(no|reject|deny|decline|cancel|abort|stop|skip)\b/i;

/** A gate option's button: a refusal reads as danger, the first other option as the main one. */
export function gateOptionTone(option: string, index: number): "primary" | "secondary" | "danger" {
  if (REFUSAL.test(option.trim())) return "danger";
  return index === 0 ? "primary" : "secondary";
}

/** Whether two texts say the same once whitespace is folded, so the full ask is not repeated. */
export const sameText = (a: string, b: string): boolean =>
  a.replace(/\s+/g, " ").trim() === b.replace(/\s+/g, " ").trim();

const RETRYABLE: ReadonlyArray<WorkflowStepStatus> = ["failed", "lost", "timed_out", "ambiguous"];

/** Whether a step's latest attempt ended in a way the user may retry. */
export const isRetryable = (status: WorkflowStepStatus): boolean => RETRYABLE.includes(status);

/** A step row's meta line: status, how long it ran, and its tokens when it used any. */
export function stepMetaLine(step: WorkflowStepAttemptView, nowMs: number): string {
  const duration = stepDurationMs(step, nowMs);
  return [
    stepStatusLabel(step.status),
    step.attempt > 1 ? `attempt ${step.attempt}` : null,
    duration === null ? null : formatDuration(duration),
    step.cost && step.cost.billable > 0 ? `${formatTokens(step.cost.billable)} tokens` : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

/** The run summary's facts line: when it started, active time, tokens and cost. */
export function runFactsLine(run: WorkflowRunSummary, nowMs: number, started: string): string {
  const activeMs = liveActiveMs(run, nowMs);
  return [
    `Started ${started}`,
    activeMs === null ? null : `active ${formatDuration(activeMs)}`,
    `${formatTokens(run.cost.billable)} tokens`,
    run.cost.usdEstimate === null ? null : formatUsd(run.cost.usdEstimate),
  ]
    .filter((part) => part !== null)
    .join(" · ");
}
