/**
 * The Workflows page's filters, like the kanban's: an "Add filter" menu, a chip per field with its
 * values, Clear and the search box. Controlled: the page keeps the filters in the URL.
 */
import {
  EMPTY_WORKFLOWS_FILTERS,
  NO_BOT,
  RUN_PERIOD_LABELS,
  RUN_STATE_FILTER_LABELS,
  type RunPeriod,
  type RunStateFilter,
  type WorkflowsFilterOption,
  type WorkflowsFilters,
  type WorkflowsTab,
  workflowsFilterOptions,
} from "@t3tools/client-runtime/workflows";
import type { WorkflowSummary } from "@t3tools/contracts";
import {
  BotIcon,
  CalendarIcon,
  CircleDashedIcon,
  HandIcon,
  ListFilterIcon,
  PowerIcon,
  WorkflowIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSearchInput,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";

import { BotAvatar } from "../BotAvatar";
import { FILTER_CHIP_PART, FilterChip, FilterOptionItem, FilterSearch } from "../FilterBarParts";
import { TriggerIcon } from "./run/TriggerIcon";
import { RunStatusIcon } from "./WorkflowStatusBadge";

interface FieldOption extends WorkflowsFilterOption {
  readonly icon?: ReactNode;
}

/** One filter field: its values, which are set, and how to set them. */
interface Field {
  readonly key: string;
  readonly label: string;
  /** "bots", for a chip with several values. */
  readonly plural: string;
  readonly Icon: LucideIcon;
  /** One value at a time (the switch, the period). */
  readonly single: boolean;
  readonly options: ReadonlyArray<FieldOption>;
  readonly selected: ReadonlyArray<string>;
  readonly set: (values: string[]) => void;
}

const OPTION_SEARCH_MIN = 8;

const STATE_ICONS: Readonly<Record<RunStateFilter, ReactNode>> = {
  running: <RunStatusIcon status="running" />,
  needs_you: <HandIcon aria-hidden className="size-3.5 text-warning" />,
  succeeded: <RunStatusIcon status="succeeded" />,
  failed: <RunStatusIcon status="failed" />,
  cancelled: <RunStatusIcon status="cancelled" />,
  skipped: <RunStatusIcon status="skipped" />,
};

function fieldsFor(
  tab: WorkflowsTab,
  workflows: ReadonlyArray<WorkflowSummary>,
  filters: WorkflowsFilters,
  onChange: (filters: WorkflowsFilters) => void,
): Field[] {
  const options = workflowsFilterOptions(workflows);
  const forRuns = (option: WorkflowsFilterOption) =>
    tab === "runs" ? { ...option, count: null } : option;
  const bot: Field = {
    key: "bot",
    label: "Bot",
    plural: "bots",
    Icon: BotIcon,
    single: false,
    options: options.bots.map((option) => ({
      ...forRuns(option),
      icon:
        option.value === NO_BOT ? (
          <BotIcon aria-hidden className="size-3.5 text-muted-foreground" />
        ) : (
          <BotAvatar botId={option.value} size={14} />
        ),
    })),
    selected: filters.bots,
    set: (bots) => onChange({ ...filters, bots }),
  };
  const trigger: Field = {
    key: "trigger",
    label: "Trigger",
    plural: "triggers",
    Icon: ZapIcon,
    single: false,
    options: options.triggers.map((option) => ({
      ...forRuns(option),
      icon: <TriggerIcon kind={option.value} />,
    })),
    selected: filters.triggers,
    set: (triggers) => onChange({ ...filters, triggers }),
  };
  if (tab === "workflows") {
    const on = workflows.filter((workflow) => workflow.enabled).length;
    return [
      bot,
      trigger,
      {
        key: "on",
        label: "Switch",
        plural: "states",
        Icon: PowerIcon,
        single: true,
        options: [
          { value: "on", label: "On", count: on },
          { value: "off", label: "Off", count: workflows.length - on },
        ],
        selected: filters.enabled === null ? [] : [filters.enabled],
        set: ([value]) =>
          onChange({ ...filters, enabled: value === "on" || value === "off" ? value : null }),
      },
    ];
  }
  return [
    {
      key: "status",
      label: "Status",
      plural: "statuses",
      Icon: CircleDashedIcon,
      single: false,
      options: (Object.keys(RUN_STATE_FILTER_LABELS) as RunStateFilter[]).map((state) => ({
        value: state,
        label: RUN_STATE_FILTER_LABELS[state],
        count: null,
        icon: STATE_ICONS[state],
      })),
      selected: filters.states,
      set: (states) =>
        onChange({
          ...filters,
          states: states.filter((state): state is RunStateFilter => state in STATE_ICONS),
        }),
    },
    bot,
    {
      key: "workflow",
      label: "Workflow",
      plural: "workflows",
      Icon: WorkflowIcon,
      single: false,
      options: options.workflows,
      selected: filters.workflows,
      set: (selected) => onChange({ ...filters, workflows: selected }),
    },
    trigger,
    {
      key: "period",
      label: "Started",
      plural: "periods",
      Icon: CalendarIcon,
      single: true,
      options: (Object.keys(RUN_PERIOD_LABELS) as RunPeriod[]).map((period) => ({
        value: period,
        label: RUN_PERIOD_LABELS[period],
        count: null,
      })),
      selected: filters.period === null ? [] : [filters.period],
      set: ([value]) =>
        onChange({
          ...filters,
          period: value !== undefined && value in RUN_PERIOD_LABELS ? (value as RunPeriod) : null,
        }),
    },
  ];
}

const toggled = (field: Field, value: string): string[] =>
  field.single
    ? field.selected.includes(value)
      ? []
      : [value]
    : field.selected.includes(value)
      ? field.selected.filter((item) => item !== value)
      : [...field.selected, value];

function FieldOptions(props: { readonly field: Field }) {
  const { field } = props;
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? field.options.filter((option) => option.label.toLowerCase().includes(needle))
    : field.options;
  return (
    <>
      {field.options.length > OPTION_SEARCH_MIN ? (
        <MenuSearchInput
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder={`${field.label}…`}
          aria-label={`Search ${field.label.toLowerCase()}`}
        />
      ) : null}
      {visible.map((option) => (
        <FilterOptionItem
          key={option.value}
          icon={option.icon}
          label={option.label}
          count={option.count}
          checked={field.selected.includes(option.value)}
          onToggle={() => field.set(toggled(field, option.value))}
        />
      ))}
      {visible.length === 0 ? <MenuItem disabled>No matches</MenuItem> : null}
    </>
  );
}

function AddFilterMenu(props: { readonly fields: ReadonlyArray<Field> }) {
  return (
    <Menu>
      <MenuTrigger
        render={<Button variant="ghost" size="icon-sm" aria-label="Add filter" title="Filter" />}
      >
        <ListFilterIcon />
      </MenuTrigger>
      <MenuPopup align="start" className="w-56">
        {props.fields.map((field) => (
          <MenuSub key={field.key}>
            <MenuSubTrigger>
              <field.Icon aria-hidden />
              <span className="flex-1">{field.label}</span>
            </MenuSubTrigger>
            <MenuSubPopup className="max-w-80">
              <FieldOptions field={field} />
            </MenuSubPopup>
          </MenuSub>
        ))}
      </MenuPopup>
    </Menu>
  );
}

function FieldChip(props: { readonly field: Field }) {
  const { field } = props;
  const labels = field.selected.map(
    (value) => field.options.find((option) => option.value === value)?.label ?? value,
  );
  const value = labels.length <= 2 ? labels.join(", ") : `${labels.length} ${field.plural}`;
  return (
    <FilterChip
      icon={<field.Icon aria-hidden />}
      field={field.label}
      op={labels.length > 1 ? "is any of" : "is"}
      value={
        <Menu>
          <MenuTrigger render={<button type="button" className={FILTER_CHIP_PART} />}>
            <span className="max-w-48 truncate">{value}</span>
          </MenuTrigger>
          <MenuPopup align="start" className="max-w-80">
            <FieldOptions field={field} />
          </MenuPopup>
        </Menu>
      }
      onRemove={() => field.set([])}
    />
  );
}

export function WorkflowsFilterBar(props: {
  readonly tab: WorkflowsTab;
  readonly workflows: ReadonlyArray<WorkflowSummary>;
  readonly filters: WorkflowsFilters;
  readonly onChange: (filters: WorkflowsFilters) => void;
}) {
  const fields = fieldsFor(props.tab, props.workflows, props.filters, props.onChange);
  const active = fields.filter((field) => field.selected.length > 0);
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
      <AddFilterMenu fields={fields} />
      {active.map((field) => (
        <FieldChip key={field.key} field={field} />
      ))}
      {active.length > 0 ? (
        <Button
          variant="ghost-muted"
          size="xs"
          onClick={() => props.onChange({ ...EMPTY_WORKFLOWS_FILTERS, query: props.filters.query })}
        >
          Clear
        </Button>
      ) : null}
      <FilterSearch
        value={props.filters.query}
        onChange={(query) => props.onChange({ ...props.filters, query })}
        placeholder={props.tab === "runs" ? "Search runs…" : "Search workflows…"}
      />
    </div>
  );
}
