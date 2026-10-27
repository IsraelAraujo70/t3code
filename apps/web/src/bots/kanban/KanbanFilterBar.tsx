/**
 * The kanban's Linear-style filters: an "Add filter" menu (fields, values, dates, flags, AI
 * filter), one chip per clause, and the issue search. Controlled: the page owns the filters.
 */
import {
  KANBAN_LIMITS,
  type KanbanDateFilterField,
  type KanbanFilterClause,
  type KanbanFlagFilterField,
  type KanbanSetFilterField,
  type KanbanSnapshot,
  type ProjectId,
} from "@t3tools/contracts";
import {
  describeClause,
  filterOptions,
  KANBAN_FILTER_FIELD_LABELS,
  type KanbanFilterOption,
  type KanbanViewContext,
} from "@t3tools/client-runtime/kanban-board";
import {
  AtSignIcon,
  BotIcon,
  BoxIcon,
  Building2Icon,
  CalendarIcon,
  CircleDashedIcon,
  CircleXIcon,
  FolderGit2Icon,
  LinkIcon,
  ListFilterIcon,
  MessageSquareIcon,
  MilestoneIcon,
  NetworkIcon,
  RefreshCcwIcon,
  SearchIcon,
  SignalHighIcon,
  SparklesIcon,
  TagIcon,
  TextSearchIcon,
  UserRoundIcon,
  UserRoundPenIcon,
  XIcon,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { Calendar } from "~/components/ui/calendar";
import { InputGroup, InputGroupAddon, InputGroupInput } from "~/components/ui/input-group";
import { Kbd } from "~/components/ui/kbd";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSearchInput,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { useStableCallback } from "~/hooks/useStableCallback";
import { isEditableFocused } from "~/lib/editableFocus";
import { weekStartsOn } from "~/timestampFormat";

import {
  datePresets,
  isoDay,
  mergeClauses,
  removeClause,
  replaceClause,
  selectedSetValues,
  setClauseOp,
  setDateClause,
  setDateClauseAt,
  setFlag,
  setText,
  toggleClauseValue,
  toggleSetValue,
  type KanbanDateOp,
} from "./kanbanFilterEdit";
import type { KanbanLookups } from "./kanbanLookups";
import { KanbanGroupIconView } from "./KanbanPrimitives";

export type KanbanAiFilterOutcome =
  | { readonly ok: true; readonly filters: KanbanFilterClause[] }
  | { readonly ok: false; readonly message: string };

export interface KanbanFilterBarProps {
  readonly snapshot: KanbanSnapshot;
  readonly projectId: ProjectId | null;
  readonly lookups: KanbanLookups;
  readonly context: Pick<KanbanViewContext, "personName">;
  readonly filters: ReadonlyArray<KanbanFilterClause>;
  readonly onChange: (filters: KanbanFilterClause[]) => void;
  readonly search: string;
  readonly onSearch: (text: string) => void;
  readonly onAiFilter: (text: string) => Promise<KanbanAiFilterOutcome>;
}

type FieldEntry =
  | { readonly kind: "set"; readonly field: KanbanSetFilterField; readonly Icon: LucideIcon }
  | { readonly kind: "date"; readonly field: KanbanDateFilterField; readonly Icon: LucideIcon }
  | { readonly kind: "flag"; readonly field: KanbanFlagFilterField; readonly Icon: LucideIcon }
  | { readonly kind: "content"; readonly Icon: LucideIcon }
  | {
      readonly kind: "group";
      readonly label: string;
      readonly Icon: LucideIcon;
      readonly entries: ReadonlyArray<FieldEntry>;
    };

const MENU_SECTIONS: ReadonlyArray<ReadonlyArray<FieldEntry>> = [
  [
    { kind: "set", field: "status", Icon: CircleDashedIcon },
    { kind: "set", field: "assignee", Icon: UserRoundIcon },
    { kind: "set", field: "creator", Icon: UserRoundPenIcon },
    { kind: "set", field: "priority", Icon: SignalHighIcon },
    { kind: "set", field: "label", Icon: TagIcon },
  ],
  [
    { kind: "set", field: "project", Icon: BoxIcon },
    { kind: "set", field: "milestone", Icon: MilestoneIcon },
    { kind: "set", field: "cycle", Icon: RefreshCcwIcon },
  ],
  [
    {
      kind: "group",
      label: "Dates",
      Icon: CalendarIcon,
      entries: [
        { kind: "date", field: "createdAt", Icon: CalendarIcon },
        { kind: "date", field: "updatedAt", Icon: CalendarIcon },
        { kind: "date", field: "dueDate", Icon: CalendarIcon },
        { kind: "date", field: "closedAt", Icon: CalendarIcon },
      ],
    },
    {
      kind: "group",
      label: "Relations",
      Icon: NetworkIcon,
      entries: [
        { kind: "flag", field: "isSubIssue", Icon: NetworkIcon },
        { kind: "flag", field: "hasSubIssues", Icon: NetworkIcon },
      ],
    },
    {
      kind: "group",
      label: "Links",
      Icon: LinkIcon,
      entries: [
        { kind: "set", field: "pullRequest", Icon: PullRequestGlyph.pullRequest },
        { kind: "flag", field: "hasPullRequests", Icon: PullRequestGlyph.pullRequest },
      ],
    },
    { kind: "content", Icon: TextSearchIcon },
    { kind: "flag", field: "autoClosed", Icon: CircleXIcon },
  ],
  [
    {
      kind: "group",
      label: "T3",
      Icon: BotIcon,
      entries: [
        { kind: "set", field: "bot", Icon: BotIcon },
        { kind: "set", field: "threadStatus", Icon: MessageSquareIcon },
        { kind: "flag", field: "hasThreads", Icon: MessageSquareIcon },
      ],
    },
  ],
  [
    { kind: "set", field: "workspace", Icon: Building2Icon },
    { kind: "set", field: "account", Icon: AtSignIcon },
    { kind: "set", field: "t3Project", Icon: FolderGit2Icon },
  ],
];

const leafEntries = (entries: ReadonlyArray<FieldEntry>): FieldEntry[] =>
  entries.flatMap((entry) => (entry.kind === "group" ? leafEntries(entry.entries) : [entry]));

const LEAF_ENTRIES = leafEntries(MENU_SECTIONS.flat());

const entryLabel = (entry: FieldEntry) =>
  entry.kind === "group"
    ? entry.label
    : entry.kind === "content"
      ? KANBAN_FILTER_FIELD_LABELS.content
      : KANBAN_FILTER_FIELD_LABELS[entry.field];

const SET_FIELD_ICONS = new Map(
  LEAF_ENTRIES.flatMap((entry) =>
    entry.kind === "set"
      ? [[entry.field, <entry.Icon key={entry.field} aria-hidden />] as const]
      : [],
  ),
);

const MAX_VALUE_MATCHES = 40;
const OPTION_SEARCH_MIN = 8;

const matches = (text: string, needle: string) => text.toLowerCase().includes(needle);

type OptionsFor = (field: KanbanSetFilterField) => ReadonlyArray<KanbanFilterOption>;

/** A field's options are counted on first use and kept until the board scope changes. */
function optionCache(
  snapshot: KanbanSnapshot,
  projectId: ProjectId | null,
  context: Pick<KanbanViewContext, "personName">,
): OptionsFor {
  const cache = new Map<KanbanSetFilterField, ReadonlyArray<KanbanFilterOption>>();
  return (field) => {
    let options = cache.get(field);
    if (options === undefined) {
      options = filterOptions(snapshot, projectId, field, context);
      cache.set(field, options);
    }
    return options;
  };
}

/** What a set field's value menu needs: the board scope and how values draw. */
interface OptionScope {
  readonly snapshot: KanbanSnapshot;
  readonly lookups: KanbanLookups;
  readonly context: Pick<KanbanViewContext, "personName">;
  readonly optionsFor: OptionsFor;
}

function OptionCheckbox(props: {
  readonly option: KanbanFilterOption;
  readonly lookups: KanbanLookups;
  readonly checked: boolean;
  readonly onToggle: () => void;
  readonly prefix?: string;
}) {
  return (
    <MenuCheckboxItem checked={props.checked} onCheckedChange={props.onToggle}>
      <span className="flex min-w-0 items-center gap-2">
        <KanbanGroupIconView icon={props.option.icon} lookups={props.lookups} size={14} />
        <span className="min-w-0 flex-1 truncate">
          {props.prefix ? <span className="text-muted-foreground">{props.prefix} </span> : null}
          {props.option.label}
        </span>
        <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
          {props.option.count}
        </span>
      </span>
    </MenuCheckboxItem>
  );
}

function SetOptionItems(
  props: OptionScope & {
    readonly field: KanbanSetFilterField;
    readonly selected: ReadonlySet<string>;
    readonly onToggle: (value: string) => void;
  },
) {
  const [query, setQuery] = useState("");
  const options = props.optionsFor(props.field);
  const needle = query.trim().toLowerCase();
  const visible = needle ? options.filter((option) => matches(option.label, needle)) : options;
  const label = KANBAN_FILTER_FIELD_LABELS[props.field];
  return (
    <>
      {options.length > OPTION_SEARCH_MIN ? (
        <MenuSearchInput
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder={`${label}…`}
          aria-label={`Search ${label.toLowerCase()}`}
        />
      ) : null}
      {visible.map((option) => (
        <OptionCheckbox
          key={option.value}
          option={option}
          lookups={props.lookups}
          checked={props.selected.has(option.value)}
          onToggle={() => props.onToggle(option.value)}
        />
      ))}
      {visible.length === 0 ? <MenuItem disabled>No matches</MenuItem> : null}
    </>
  );
}

function DateItems(props: {
  readonly field: KanbanDateFilterField;
  readonly onPick: (op: KanbanDateOp, value: string | number | null) => void;
}) {
  return (
    <>
      {datePresets(props.field).map((preset) => (
        <MenuItem key={preset.label} onClick={() => props.onPick(preset.op, preset.days)}>
          {preset.label}
        </MenuItem>
      ))}
      <MenuSeparator />
      {(["before", "after"] as const).map((op) => (
        <MenuSub key={op}>
          <MenuSubTrigger>{op === "before" ? "Before…" : "After…"}</MenuSubTrigger>
          <MenuSubPopup>
            <Calendar
              mode="single"
              {...(weekStartsOn === undefined ? {} : { weekStartsOn })}
              onSelect={(date) => {
                if (date) props.onPick(op, isoDay(date));
              }}
            />
          </MenuSubPopup>
        </MenuSub>
      ))}
      <MenuSeparator />
      <MenuItem onClick={() => props.onPick("isSet", null)}>Is set</MenuItem>
      <MenuItem onClick={() => props.onPick("isEmpty", null)}>Is empty</MenuItem>
    </>
  );
}

function FlagItems(props: { readonly onPick: (value: boolean) => void }) {
  return (
    <>
      <MenuItem onClick={() => props.onPick(true)}>Yes</MenuItem>
      <MenuItem onClick={() => props.onPick(false)}>No</MenuItem>
    </>
  );
}

function FieldEntryItem(
  props: OptionScope & {
    readonly entry: FieldEntry;
    readonly filters: ReadonlyArray<KanbanFilterClause>;
    readonly onChange: (filters: KanbanFilterClause[]) => void;
    readonly onContent: () => void;
    readonly close: () => void;
  },
) {
  const { entry, filters, onChange, close } = props;
  const label = entryLabel(entry);
  const trigger = (
    <>
      <entry.Icon aria-hidden />
      <span className="flex-1">{label}</span>
    </>
  );
  switch (entry.kind) {
    case "content":
      return (
        <MenuItem closeOnClick={false} onClick={props.onContent}>
          {trigger}
        </MenuItem>
      );
    case "group":
      return (
        <MenuSub>
          <MenuSubTrigger>{trigger}</MenuSubTrigger>
          <MenuSubPopup>
            {entry.entries.map((child) => (
              <FieldEntryItem key={entryLabel(child)} {...props} entry={child} />
            ))}
          </MenuSubPopup>
        </MenuSub>
      );
    case "set":
      return (
        <MenuSub>
          <MenuSubTrigger>{trigger}</MenuSubTrigger>
          <MenuSubPopup>
            <SetOptionItems
              {...props}
              field={entry.field}
              selected={selectedSetValues(filters, entry.field)}
              onToggle={(value) => onChange(toggleSetValue(filters, entry.field, value))}
            />
          </MenuSubPopup>
        </MenuSub>
      );
    case "date":
      return (
        <MenuSub>
          <MenuSubTrigger>{trigger}</MenuSubTrigger>
          <MenuSubPopup>
            <DateItems
              field={entry.field}
              onPick={(op, value) => {
                onChange(setDateClause(filters, entry.field, op, value));
                close();
              }}
            />
          </MenuSubPopup>
        </MenuSub>
      );
    case "flag":
      return (
        <MenuSub>
          <MenuSubTrigger>{trigger}</MenuSubTrigger>
          <MenuSubPopup>
            <FlagItems onPick={(value) => onChange(setFlag(filters, entry.field, value))} />
          </MenuSubPopup>
        </MenuSub>
      );
  }
}

/** Typing in "Add filter…" lists the fields and, Linear-style, the values that match. */
function SearchResults(
  props: OptionScope & {
    readonly needle: string;
    readonly filters: ReadonlyArray<KanbanFilterClause>;
    readonly onChange: (filters: KanbanFilterClause[]) => void;
    readonly onContent: () => void;
    readonly close: () => void;
  },
) {
  const fields = LEAF_ENTRIES.filter((entry) => matches(entryLabel(entry), props.needle));
  let budget = MAX_VALUE_MATCHES;
  const values: Array<{ field: KanbanSetFilterField; option: KanbanFilterOption }> = [];
  for (const entry of LEAF_ENTRIES) {
    if (entry.kind !== "set" || budget === 0) continue;
    for (const option of props.optionsFor(entry.field))
      if (budget > 0 && matches(option.label, props.needle)) {
        values.push({ field: entry.field, option });
        budget -= 1;
      }
  }
  if (fields.length === 0 && values.length === 0) return <MenuItem disabled>No matches</MenuItem>;
  return (
    <>
      {fields.map((entry) => (
        <FieldEntryItem key={entryLabel(entry)} {...props} entry={entry} />
      ))}
      {fields.length > 0 && values.length > 0 ? <MenuSeparator /> : null}
      {values.map(({ field, option }) => (
        <OptionCheckbox
          key={`${field}:${option.value}`}
          option={option}
          lookups={props.lookups}
          prefix={KANBAN_FILTER_FIELD_LABELS[field]}
          checked={selectedSetValues(props.filters, field).has(option.value)}
          onToggle={() => props.onChange(toggleSetValue(props.filters, field, option.value))}
        />
      ))}
    </>
  );
}

type InputMode = "search" | "ai" | "content";

const INPUT_PLACEHOLDERS: Record<InputMode, string> = {
  search: "Add filter…",
  ai: "Describe the issues to show…",
  content: "Title, identifier or label contains…",
};

function AddFilterMenu(
  props: Omit<KanbanFilterBarProps, "search" | "onSearch" | "projectId"> & {
    readonly optionsFor: OptionsFor;
  },
) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<InputMode>("search");
  const [query, setQuery] = useState("");
  const [aiBusy, setAiBusy] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  // Bumped when an AI request is abandoned (menu closed, input changed, unmounted).
  const aiRequest = useRef(0);
  const abandonAi = () => {
    aiRequest.current += 1;
    setAiBusy(false);
  };
  // oxlint-disable-next-line t3code/react-effect-budget -- an AI answer that lands after unmount must not edit the filters.
  useEffect(
    () => () => {
      aiRequest.current += 1;
    },
    [],
  );
  const applyAiFilters = useStableCallback((clauses: ReadonlyArray<KanbanFilterClause>) =>
    props.onChange(mergeClauses(props.filters, clauses)),
  );
  const onOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      abandonAi();
      setMode("search");
      setQuery("");
      setAiError(null);
    }
  };
  const close = () => onOpenChange(false);
  const switchMode = (next: InputMode) => {
    abandonAi();
    setMode(next);
    setQuery("");
    setAiError(null);
  };

  const submit = async () => {
    const text = query.trim();
    if (mode === "content") {
      props.onChange(setText(props.filters, text));
      close();
      return;
    }
    if (mode !== "ai" || text === "" || aiBusy) return;
    const request = ++aiRequest.current;
    setAiBusy(true);
    setAiError(null);
    try {
      const result = await props.onAiFilter(text);
      if (request !== aiRequest.current) return;
      if (result.ok) {
        applyAiFilters(result.filters);
        close();
      } else setAiError(result.message);
    } catch (error) {
      if (request === aiRequest.current)
        setAiError(error instanceof Error ? error.message : "The AI filter failed.");
    } finally {
      if (request === aiRequest.current) setAiBusy(false);
    }
  };

  const needle = mode === "search" ? query.trim().toLowerCase() : "";
  const fieldProps = {
    snapshot: props.snapshot,
    lookups: props.lookups,
    context: props.context,
    optionsFor: props.optionsFor,
    filters: props.filters,
    onChange: props.onChange,
    onContent: () => switchMode("content"),
    close,
  };

  return (
    <Menu open={open} onOpenChange={onOpenChange}>
      <MenuTrigger
        render={<Button variant="ghost" size="icon-sm" aria-label="Add filter" title="Filter" />}
      >
        <ListFilterIcon />
      </MenuTrigger>
      <MenuPopup align="start" className="w-64">
        <MenuSearchInput
          autoFocus
          busy={aiBusy}
          value={query}
          maxLength={mode === "ai" ? KANBAN_LIMITS.aiFilterText : undefined}
          onChange={(event) => {
            if (aiBusy) abandonAi();
            setQuery(event.currentTarget.value);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) void submit();
          }}
          placeholder={INPUT_PLACEHOLDERS[mode]}
          aria-label={INPUT_PLACEHOLDERS[mode]}
        />
        {mode !== "search" ? (
          <>
            {aiError ? <MenuItem disabled>{aiError}</MenuItem> : null}
            <MenuItem closeOnClick={false} onClick={() => void submit()}>
              {mode === "ai" ? <SparklesIcon aria-hidden /> : <TextSearchIcon aria-hidden />}
              {mode === "ai" ? "Apply AI filter" : "Filter by content"}
            </MenuItem>
            <MenuItem closeOnClick={false} onClick={() => switchMode("search")}>
              Back
            </MenuItem>
          </>
        ) : needle ? (
          <SearchResults {...fieldProps} needle={needle} />
        ) : (
          <>
            <MenuItem closeOnClick={false} onClick={() => switchMode("ai")}>
              <SparklesIcon aria-hidden />
              AI filter
            </MenuItem>
            {MENU_SECTIONS.map((section) => (
              <SectionItems key={entryLabel(section[0]!)}>
                {section.map((entry) => (
                  <FieldEntryItem key={entryLabel(entry)} {...fieldProps} entry={entry} />
                ))}
              </SectionItems>
            ))}
          </>
        )}
      </MenuPopup>
    </Menu>
  );
}

function SectionItems(props: { readonly children: ReactNode }) {
  return (
    <>
      <MenuSeparator />
      {props.children}
    </>
  );
}

const CHIP_PART =
  "flex h-full min-w-0 items-center gap-1 border-input border-s px-1.5 outline-none hover:bg-accent focus-visible:bg-accent";

/** The chip's value: reopens the field's value menu (set and date clauses). */
function ChipValueMenu(
  props: OptionScope & {
    readonly clause: KanbanFilterClause;
    readonly index: number;
    readonly value: string;
    readonly filters: ReadonlyArray<KanbanFilterClause>;
    readonly onChange: (filters: KanbanFilterClause[]) => void;
  },
) {
  const [open, setOpen] = useState(false);
  const { clause, index, filters, onChange } = props;
  const value = <span className="max-w-48 truncate">{props.value}</span>;
  if (clause.kind === "flag")
    return (
      <button
        type="button"
        className={CHIP_PART}
        onClick={() => onChange(setFlag(filters, clause.field, !clause.value))}
      >
        {value}
      </button>
    );
  if (clause.kind === "text")
    return props.value ? <span className={CHIP_PART}>{value}</span> : null;
  if (clause.kind === "date" && props.value === "") return null;
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger render={<button type="button" className={CHIP_PART} />}>{value}</MenuTrigger>
      <MenuPopup align="start">
        {clause.kind === "set" ? (
          <SetOptionItems
            {...props}
            field={clause.field}
            selected={new Set(clause.values)}
            onToggle={(next) => onChange(toggleClauseValue(filters, index, next))}
          />
        ) : (
          <DateItems
            field={clause.field}
            onPick={(op, next) => {
              onChange(setDateClauseAt(filters, index, op, next));
              setOpen(false);
            }}
          />
        )}
      </MenuPopup>
    </Menu>
  );
}

const flipDateOp = (op: KanbanDateOp): KanbanDateOp | null =>
  op === "before" ? "after" : op === "after" ? "before" : null;

function FilterChip(
  props: OptionScope & {
    readonly clause: KanbanFilterClause;
    readonly index: number;
    readonly filters: ReadonlyArray<KanbanFilterClause>;
    readonly onChange: (filters: KanbanFilterClause[]) => void;
  },
) {
  const { clause, index, filters, onChange } = props;
  const described = describeClause(props.snapshot, clause, props.context);
  const icon = clause.kind === "set" ? SET_FIELD_ICONS.get(clause.field) : undefined;
  const flipOp = (): KanbanFilterClause[] | null => {
    switch (clause.kind) {
      case "set":
        return setClauseOp(filters, index, clause.op === "in" ? "notIn" : "in");
      case "flag":
        return setFlag(filters, clause.field, !clause.value);
      case "date": {
        const op = flipDateOp(clause.op);
        return op === null ? null : replaceClause(filters, index, { ...clause, op });
      }
      case "text":
        return null;
    }
  };
  const flipped = flipOp();
  return (
    <div className="flex h-6 min-w-0 items-center overflow-hidden rounded-md border border-input text-xs">
      <span className="flex items-center gap-1 px-1.5 [&_svg]:size-3 [&_svg]:text-muted-foreground">
        {icon}
        {described.field}
      </span>
      {flipped === null ? (
        <span className="flex h-full items-center border-input border-s px-1.5 text-muted-foreground">
          {described.op}
        </span>
      ) : (
        <button
          type="button"
          className={`${CHIP_PART} text-muted-foreground`}
          onClick={() => onChange(flipped)}
        >
          {described.op}
        </button>
      )}
      <ChipValueMenu {...props} value={described.value} />
      <button
        type="button"
        aria-label={`Remove ${described.field} filter`}
        className={`${CHIP_PART} text-muted-foreground hover:text-foreground`}
        onClick={() => onChange(removeClause(filters, index))}
      >
        <XIcon aria-hidden className="size-3" />
      </button>
    </div>
  );
}

function IssueSearch(props: { readonly value: string; readonly onChange: (text: string) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  // oxlint-disable-next-line t3code/react-effect-budget -- "/" focuses the search from anywhere on the page (a window key listener).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.defaultPrevented || event.isComposing || isEditableFocused(event.target)) return;
      if (event.target instanceof Element && event.target.closest('[data-slot$="popup"]')) return;
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  return (
    <InputGroup className="w-52">
      <InputGroupAddon>
        <SearchIcon aria-hidden />
      </InputGroupAddon>
      <InputGroupInput
        ref={inputRef}
        type="search"
        size="sm"
        value={props.value}
        maxLength={200}
        onChange={(event) => props.onChange(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            if (props.value) props.onChange("");
            else event.currentTarget.blur();
          }
        }}
        placeholder="Search issues…"
        aria-label="Search issues"
      />
      {props.value ? null : (
        <InputGroupAddon align="inline-end">
          <Kbd>/</Kbd>
        </InputGroupAddon>
      )}
    </InputGroup>
  );
}

export function KanbanFilterBar(props: KanbanFilterBarProps) {
  const { snapshot, projectId, context } = props;
  const optionsFor = optionCache(snapshot, projectId, context);
  const scope = { snapshot, lookups: props.lookups, context, optionsFor };
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <AddFilterMenu {...props} optionsFor={optionsFor} />
      {props.filters.map((clause, index) => (
        <FilterChip
          // oxlint-disable-next-line react/no-array-index-key -- a clause has no id; its index is what every edit addresses.
          key={index}
          {...scope}
          clause={clause}
          index={index}
          filters={props.filters}
          onChange={props.onChange}
        />
      ))}
      {props.filters.length > 0 ? (
        <Button variant="ghost-muted" size="xs" onClick={() => props.onChange([])}>
          Clear
        </Button>
      ) : null}
      <IssueSearch value={props.search} onChange={props.onSearch} />
    </div>
  );
}
