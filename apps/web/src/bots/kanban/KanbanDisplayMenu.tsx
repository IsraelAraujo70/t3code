/**
 * The kanban's display panel, laid out like Linear's: layout, grouping, ordering, which closed
 * tickets show, and the card properties. Controlled: the page owns the config.
 */
import {
  KANBAN_DISPLAY_PROPERTIES,
  KANBAN_GROUPINGS,
  KANBAN_ORDERINGS,
  type KanbanDisplayProperty,
  type KanbanGrouping,
  type KanbanOrdering,
  type KanbanViewConfig,
} from "@t3tools/contracts";
import { Columns3Icon, ListIcon, SlidersHorizontalIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch } from "~/components/ui/switch";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";

export interface KanbanDisplayMenuProps {
  readonly config: KanbanViewConfig;
  readonly onChange: (config: KanbanViewConfig) => void;
  /** Back to the saved view; offered while the view has unsaved changes. */
  readonly onReset?: () => void;
  /** The display differs from the saved view. */
  readonly dirty?: boolean;
}

const GROUPING_LABELS: Record<KanbanGrouping, string> = {
  status: "Status",
  assignee: "Assignee",
  priority: "Priority",
  label: "Label",
  project: "Project",
  cycle: "Cycle",
  threadStatus: "Thread status",
  none: "No grouping",
};

const ORDERING_LABELS: Record<KanbanOrdering, string> = {
  priority: "Priority",
  updated: "Updated",
  created: "Created",
  manual: "Manual",
  dueDate: "Due date",
  threadStatus: "Thread status",
};

const COMPLETED_LABELS: Record<KanbanViewConfig["completed"], string> = {
  all: "All",
  pastWeek: "Past week",
  pastMonth: "Past month",
  none: "None",
};

const PROPERTY_LABELS: Record<KanbanDisplayProperty, string> = {
  id: "ID",
  status: "Status",
  assignee: "Assignee",
  priority: "Priority",
  project: "Project",
  dueDate: "Due date",
  milestone: "Milestone",
  cycle: "Cycle",
  labels: "Labels",
  estimate: "Estimate",
  subIssues: "Sub-issues",
  pullRequests: "Pull requests",
  threads: "Threads",
  bot: "Bot",
  created: "Created",
  updated: "Updated",
};

function Row(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex min-h-8 items-center justify-between gap-3 text-sm">
      <span className="text-muted-foreground">{props.label}</span>
      {props.children}
    </div>
  );
}

function OptionSelect<Value extends string>(props: {
  readonly label: string;
  readonly value: Value;
  readonly options: ReadonlyArray<Value>;
  readonly labels: Record<Value, string>;
  readonly onChange: (value: Value) => void;
}) {
  return (
    <Row label={props.label}>
      <Select
        value={props.value}
        onValueChange={(value) => {
          const next = props.options.find((option) => option === value);
          if (next !== undefined && next !== props.value) props.onChange(next);
        }}
      >
        <SelectTrigger aria-label={props.label} className="w-40" size="xs">
          <SelectValue>{props.labels[props.value]}</SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {props.options.map((option) => (
            <SelectItem key={option} value={option}>
              {props.labels[option]}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </Row>
  );
}

function SwitchRow(props: {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <Row label={props.label}>
      <Switch
        size="sm"
        aria-label={props.label}
        checked={props.checked}
        onCheckedChange={props.onChange}
      />
    </Row>
  );
}

const COLUMN_GROUPINGS = KANBAN_GROUPINGS.filter((grouping) => grouping !== "none");
const COMPLETED_OPTIONS = ["all", "pastWeek", "pastMonth", "none"] as const;

export function KanbanDisplayMenu(props: KanbanDisplayMenuProps) {
  const { config } = props;
  const set = (patch: Partial<KanbanViewConfig>) => props.onChange({ ...config, ...patch });
  const board = config.layout === "board";
  return (
    <Popover>
      <PopoverTrigger
        render={<Button variant="ghost" size="icon-sm" aria-label="Display options" />}
      >
        <SlidersHorizontalIcon />
        {props.dirty ? (
          <span aria-hidden className="absolute top-1 right-1 size-1.5 rounded-full bg-primary" />
        ) : null}
      </PopoverTrigger>
      <PopoverPopup align="end" width="md" padding="compact">
        <div className="flex flex-col gap-1">
          <ToggleGroup
            className="mb-2 w-full"
            value={[config.layout]}
            onValueChange={(values) => {
              const layout = values.find((value) => value === "board" || value === "list");
              if (layout !== undefined && layout !== config.layout) set({ layout });
            }}
          >
            <Toggle className="flex-1" value="list" aria-label="List">
              <ListIcon aria-hidden />
              List
            </Toggle>
            <Toggle className="flex-1" value="board" aria-label="Board">
              <Columns3Icon aria-hidden />
              Board
            </Toggle>
          </ToggleGroup>
          <OptionSelect
            label={board ? "Columns" : "Grouping"}
            value={config.groupBy}
            options={COLUMN_GROUPINGS}
            labels={GROUPING_LABELS}
            onChange={(groupBy) => set({ groupBy })}
          />
          {board ? (
            <OptionSelect
              label="Rows"
              value={config.subGroupBy}
              options={KANBAN_GROUPINGS}
              labels={GROUPING_LABELS}
              onChange={(subGroupBy) => set({ subGroupBy })}
            />
          ) : null}
          <OptionSelect
            label="Ordering"
            value={config.orderBy}
            options={KANBAN_ORDERINGS}
            labels={ORDERING_LABELS}
            onChange={(orderBy) => set({ orderBy })}
          />
          <SwitchRow
            label="Order completed by recency"
            checked={config.completedByRecency}
            onChange={(completedByRecency) => set({ completedByRecency })}
          />
          <div className="my-1.5 h-px bg-border" />
          <OptionSelect
            label="Completed issues"
            value={config.completed}
            options={COMPLETED_OPTIONS}
            labels={COMPLETED_LABELS}
            onChange={(completed) => set({ completed })}
          />
          <SwitchRow
            label="Show sub-issues"
            checked={config.showSubIssues}
            onChange={(showSubIssues) => set({ showSubIssues })}
          />
          <div className="my-1.5 h-px bg-border" />
          {board ? (
            <>
              <span className="font-medium text-sm">Board options</span>
              <SwitchRow
                label="Show empty columns"
                checked={config.showEmptyColumns}
                onChange={(showEmptyColumns) => set({ showEmptyColumns })}
              />
            </>
          ) : null}
          <span className="py-1 text-muted-foreground text-sm">Display properties</span>
          <ToggleGroup
            className="flex-wrap"
            variant="pill"
            size="compact"
            multiple
            value={[...config.properties]}
            onValueChange={(values) =>
              set({
                properties: KANBAN_DISPLAY_PROPERTIES.filter((property) =>
                  values.includes(property),
                ),
              })
            }
          >
            {KANBAN_DISPLAY_PROPERTIES.map((property) => (
              <Toggle key={property} value={property}>
                {PROPERTY_LABELS[property]}
              </Toggle>
            ))}
          </ToggleGroup>
          <div className="mt-2 flex justify-end">
            <Button
              variant="ghost"
              size="xs"
              disabled={!props.dirty || props.onReset === undefined}
              onClick={props.onReset}
            >
              Reset
            </Button>
          </div>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
