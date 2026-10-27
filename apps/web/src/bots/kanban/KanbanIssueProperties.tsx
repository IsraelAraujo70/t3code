import {
  type EnvironmentId,
  type KanbanLabel,
  type KanbanSnapshot,
  type KanbanTicket,
  type KanbanTicketPatch,
  type KanbanTicketStatus,
} from "@t3tools/contracts";
import { KANBAN_PRIORITY_LABELS, sameStatus } from "@t3tools/client-runtime/kanban-board";
import {
  BotIcon,
  CalendarIcon,
  CheckIcon,
  CircleUserIcon,
  IterationCwIcon,
  MilestoneIcon,
  PlusIcon,
  TagIcon,
  TriangleIcon,
} from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Button } from "../../components/ui/button";
import { Calendar } from "../../components/ui/calendar";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSearchInput,
  MenuSeparator,
  MenuTrigger,
} from "../../components/ui/menu";
import { Popover, PopoverPopup, PopoverTrigger } from "../../components/ui/popover";
import { useNowMinute } from "../../hooks/useNowMinute";
import { botsEnvironment, useBotDirectory } from "../../state/bots";
import { useAtomCommand } from "../../state/use-atom-command";
import { BotAvatar } from "../BotAvatar";
import { reportCommandResult } from "../botsSettingsShared";
import {
  assigneeOptions,
  cycleOptions,
  dateFromKey,
  dateKey,
  isOverdue,
  labelOptions,
  matchesQuery,
  nextLabelColor,
  statusOptions,
  statusPresentation,
  ticketOrganizationId,
} from "./kanbanIssue.logic";
import { personDisplay, type KanbanLookups } from "./kanbanLookups";
import {
  KanbanAvatar,
  KanbanGroupIconView,
  KanbanLabelPill,
  KanbanPriorityIcon,
  KanbanStatusIcon,
} from "./KanbanPrimitives";

const PRIORITY_ORDER = [0, 1, 2, 3, 4] as const;
const ESTIMATES = [0, 1, 2, 3, 5, 8] as const;

/**
 * A ticket's properties as Linear lays them out, each a picker when the user may edit: status,
 * priority, assignee, responsible bot, labels, and for synced tickets project, milestone, cycle
 * and estimate. `sidebar` stacks them under headings; `compact` wraps them under the title.
 */
export function KanbanIssueProperties(props: {
  readonly environmentId: EnvironmentId;
  readonly ticket: KanbanTicket;
  readonly snapshot: KanbanSnapshot;
  readonly lookups: KanbanLookups;
  readonly canEdit: boolean;
  readonly layout: "sidebar" | "compact";
  readonly onPatch: (patch: KanbanTicketPatch) => Promise<boolean>;
  readonly onMove: (to: KanbanTicketStatus) => Promise<boolean>;
}) {
  const { ticket, snapshot, lookups, canEdit, onPatch } = props;
  const synced = ticket.linear !== null;
  const { directory } = useBotDirectory(props.environmentId);
  const bots = directory?.bots ?? [];
  const now = Date.parse(useNowMinute());

  const status = statusPresentation(ticket.status, lookups.statesById);
  const assignee = ticket.assigneeId === null ? null : personDisplay(lookups, ticket.assigneeId);
  const bot = ticket.botId === null ? null : (lookups.botsById.get(ticket.botId) ?? null);
  const project =
    ticket.linearProjectId === null
      ? null
      : (lookups.projectsById.get(ticket.linearProjectId) ?? null);
  const milestone =
    ticket.milestoneId === null ? null : (lookups.milestonesById.get(ticket.milestoneId) ?? null);
  const cycles = synced && ticket.linear ? cycleOptions(snapshot, ticket.linear.teamId, now) : [];
  const cycle = cycles.find((option) => option.cycle.id === ticket.cycleId) ?? null;
  const organizationId = ticketOrganizationId(snapshot, ticket);
  const overdue = ticket.closedAt === null && isOverdue(ticket.dueDate, now);

  const rows = (
    <>
      <PropertyPicker
        label="Status"
        canEdit={canEdit}
        icon={
          status ? (
            <KanbanStatusIcon
              stateType={status.stateType}
              color={status.color}
              {...(status.progress === undefined ? {} : { progress: status.progress })}
            />
          ) : null
        }
        value={status?.name ?? "Unknown status"}
      >
        {statusOptions(snapshot, ticket).map((option) => {
          const presentation = statusPresentation(option, lookups.statesById);
          const key = option.kind === "local" ? option.state : option.stateId;
          return (
            <MenuItem key={key} onClick={() => void props.onMove(option)}>
              {presentation ? (
                <KanbanStatusIcon
                  stateType={presentation.stateType}
                  color={presentation.color}
                  {...(presentation.progress === undefined
                    ? {}
                    : { progress: presentation.progress })}
                />
              ) : null}
              <span className="flex-1">{presentation?.name ?? key}</span>
              {sameStatus(option, ticket.status) ? <CheckIcon /> : null}
            </MenuItem>
          );
        })}
      </PropertyPicker>

      <PropertyPicker
        label="Priority"
        canEdit={canEdit}
        icon={<KanbanPriorityIcon priority={ticket.priority} />}
        value={KANBAN_PRIORITY_LABELS[ticket.priority] ?? "No priority"}
      >
        {PRIORITY_ORDER.map((priority) => (
          <MenuItem key={priority} onClick={() => void onPatch({ priority })}>
            <KanbanPriorityIcon priority={priority} />
            <span className="flex-1">{KANBAN_PRIORITY_LABELS[priority]}</span>
            {ticket.priority === priority ? <CheckIcon /> : null}
          </MenuItem>
        ))}
      </PropertyPicker>

      <SearchPicker
        label="Assignee"
        canEdit={canEdit}
        icon={
          assignee ? (
            <KanbanAvatar person={assignee} size={16} />
          ) : (
            <CircleUserIcon className="size-4 text-muted-foreground" />
          )
        }
        value={assignee?.name ?? "No assignee"}
        muted={assignee === null}
      >
        {(query) => (
          <>
            {matchesQuery("No assignee", query) ? (
              <MenuItem onClick={() => void onPatch({ assigneeId: null })}>
                <CircleUserIcon />
                <span className="flex-1">No assignee</span>
                {ticket.assigneeId === null ? <CheckIcon /> : null}
              </MenuItem>
            ) : null}
            {assigneeOptions(snapshot, ticket, bots, lookups.ownerName)
              .filter((option) => matchesQuery(option.name, query))
              .map((option) => (
                <MenuItem key={option.id} onClick={() => void onPatch({ assigneeId: option.id })}>
                  <KanbanAvatar person={option} size={16} />
                  <span className="flex-1 truncate">
                    {option.name}
                    {option.isMe && synced ? (
                      <span className="text-muted-foreground"> (me)</span>
                    ) : null}
                  </span>
                  {ticket.assigneeId === option.id ? <CheckIcon /> : null}
                </MenuItem>
              ))}
          </>
        )}
      </SearchPicker>

      <PropertyPicker
        label="Responsible bot"
        canEdit={canEdit}
        icon={
          bot ? (
            <BotAvatar botId={bot.id} size={16} />
          ) : (
            <BotIcon className="size-4 text-muted-foreground" />
          )
        }
        value={bot?.name ?? "No bot"}
        muted={bot === null}
      >
        <MenuItem onClick={() => void onPatch({ botId: null })}>
          <BotIcon />
          <span className="flex-1">None</span>
          {ticket.botId === null ? <CheckIcon /> : null}
        </MenuItem>
        {bots.map((candidate) => (
          <MenuItem key={candidate.id} onClick={() => void onPatch({ botId: candidate.id })}>
            <BotAvatar botId={candidate.id} size={16} />
            <span className="flex-1 truncate">{candidate.name}</span>
            {ticket.botId === candidate.id ? <CheckIcon /> : null}
          </MenuItem>
        ))}
      </PropertyPicker>

      {synced ? (
        <PropertyPicker
          label="Cycle"
          canEdit={canEdit}
          icon={<IterationCwIcon className="size-4 text-muted-foreground" />}
          value={cycle?.title ?? "No cycle"}
          muted={cycle === null}
        >
          <MenuItem onClick={() => void onPatch({ cycleId: null })}>
            <span className="flex-1">No cycle</span>
            {ticket.cycleId === null ? <CheckIcon /> : null}
          </MenuItem>
          {cycles.map((option) => (
            <MenuItem
              key={option.cycle.id}
              onClick={() => void onPatch({ cycleId: option.cycle.id })}
            >
              <IterationCwIcon />
              <span className="flex-1 truncate">
                {option.title}
                {option.current ? <span className="text-muted-foreground"> · Current</span> : null}
              </span>
              {ticket.cycleId === option.cycle.id ? <CheckIcon /> : null}
            </MenuItem>
          ))}
        </PropertyPicker>
      ) : null}

      <DueDatePicker
        dueDate={ticket.dueDate}
        overdue={overdue}
        canEdit={canEdit}
        onChange={(dueDate) => void onPatch({ dueDate })}
      />

      {synced ? (
        <PropertyPicker
          label="Estimate"
          canEdit={canEdit}
          icon={<TriangleIcon className="size-4 text-muted-foreground" />}
          value={ticket.estimate === null ? "No estimate" : `${ticket.estimate} points`}
          muted={ticket.estimate === null}
        >
          <MenuItem onClick={() => void onPatch({ estimate: null })}>
            <span className="flex-1">No estimate</span>
            {ticket.estimate === null ? <CheckIcon /> : null}
          </MenuItem>
          {ESTIMATES.map((estimate) => (
            <MenuItem key={estimate} onClick={() => void onPatch({ estimate })}>
              <span className="flex-1">{estimate} points</span>
              {ticket.estimate === estimate ? <CheckIcon /> : null}
            </MenuItem>
          ))}
        </PropertyPicker>
      ) : null}
    </>
  );

  const labels = (
    <LabelsField
      environmentId={props.environmentId}
      ticket={ticket}
      snapshot={snapshot}
      lookups={lookups}
      canEdit={canEdit}
      onPatch={onPatch}
    />
  );

  const projectRows = synced ? (
    <>
      <SearchPicker
        label="Project"
        canEdit={canEdit}
        icon={
          <KanbanGroupIconView
            icon={{ kind: "project", color: project?.color ?? null, icon: project?.icon ?? null }}
            lookups={lookups}
            size={16}
          />
        }
        value={project?.name ?? "No project"}
        muted={project === null}
      >
        {(query) => (
          <>
            {matchesQuery("No project", query) ? (
              <MenuItem onClick={() => void onPatch({ linearProjectId: null })}>
                <span className="flex-1">No project</span>
                {ticket.linearProjectId === null ? <CheckIcon /> : null}
              </MenuItem>
            ) : null}
            {snapshot.linearProjects
              .filter(
                (candidate) =>
                  candidate.organizationId === organizationId &&
                  matchesQuery(candidate.name, query),
              )
              .map((candidate) => (
                <MenuItem
                  key={candidate.id}
                  onClick={() => void onPatch({ linearProjectId: candidate.id })}
                >
                  <KanbanGroupIconView
                    icon={{ kind: "project", color: candidate.color, icon: candidate.icon }}
                    lookups={lookups}
                    size={16}
                  />
                  <span className="flex-1 truncate">{candidate.name}</span>
                  {ticket.linearProjectId === candidate.id ? <CheckIcon /> : null}
                </MenuItem>
              ))}
          </>
        )}
      </SearchPicker>
      {project !== null ? (
        <PropertyPicker
          label="Milestone"
          canEdit={canEdit}
          icon={<MilestoneIcon className="size-4 text-muted-foreground" />}
          value={milestone?.name ?? "No milestone"}
          muted={milestone === null}
        >
          <MenuItem onClick={() => void onPatch({ milestoneId: null })}>
            <span className="flex-1">No milestone</span>
            {ticket.milestoneId === null ? <CheckIcon /> : null}
          </MenuItem>
          {snapshot.milestones
            .filter((candidate) => candidate.projectId === project.id)
            .map((candidate) => (
              <MenuItem
                key={candidate.id}
                onClick={() => void onPatch({ milestoneId: candidate.id })}
              >
                <MilestoneIcon />
                <span className="flex-1 truncate">{candidate.name}</span>
                {ticket.milestoneId === candidate.id ? <CheckIcon /> : null}
              </MenuItem>
            ))}
        </PropertyPicker>
      ) : null}
    </>
  ) : null;

  if (props.layout === "compact") {
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-1">
          {rows}
          {projectRows}
        </div>
        {labels}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      <PropertySection title="Properties">{rows}</PropertySection>
      <PropertySection title="Labels">{labels}</PropertySection>
      {projectRows ? <PropertySection title="Project">{projectRows}</PropertySection> : null}
    </div>
  );
}

function PropertySection(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="flex flex-col items-start gap-0.5">
      <h3 className="mb-1.5 px-2 font-medium text-muted-foreground text-xs">{props.title}</h3>
      {props.children}
    </section>
  );
}

function PropertyValue(props: {
  readonly icon: ReactNode;
  readonly value: ReactNode;
  readonly muted?: boolean | undefined;
}) {
  return (
    <>
      <span className="flex size-4 shrink-0 items-center justify-center">{props.icon}</span>
      <span className={cn("truncate", props.muted && "text-muted-foreground")}>{props.value}</span>
    </>
  );
}

/** A property's value as a menu trigger, or plain text when the user may not edit. */
function PropertyPicker(props: {
  readonly label: string;
  readonly canEdit: boolean;
  readonly icon: ReactNode;
  readonly value: ReactNode;
  readonly muted?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly children: ReactNode;
}) {
  if (!props.canEdit) {
    return (
      <span
        className="flex h-7 max-w-full items-center gap-2 px-2 text-sm"
        aria-label={props.label}
      >
        <PropertyValue icon={props.icon} value={props.value} muted={props.muted} />
      </span>
    );
  }
  return (
    <Menu {...(props.onOpenChange ? { onOpenChange: props.onOpenChange } : {})}>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className="max-w-full justify-start"
            aria-label={props.label}
          />
        }
      >
        <PropertyValue icon={props.icon} value={props.value} muted={props.muted} />
      </MenuTrigger>
      <MenuPopup align="start" className="max-h-80 w-64">
        {props.children}
      </MenuPopup>
    </Menu>
  );
}

/** A picker with a search field; the query resets each time the menu opens. */
function SearchPicker(props: {
  readonly label: string;
  readonly canEdit: boolean;
  readonly icon: ReactNode;
  readonly value: ReactNode;
  readonly muted?: boolean;
  readonly children: (query: string) => ReactNode;
}) {
  const [query, setQuery] = useState("");
  return (
    <PropertyPicker
      label={props.label}
      canEdit={props.canEdit}
      icon={props.icon}
      value={props.value}
      {...(props.muted === undefined ? {} : { muted: props.muted })}
      onOpenChange={(open) => {
        if (open) setQuery("");
      }}
    >
      <MenuSearchInput
        placeholder={`${props.label}…`}
        aria-label={`Search ${props.label.toLowerCase()}`}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      {props.children(query)}
    </PropertyPicker>
  );
}

function DueDatePicker(props: {
  readonly dueDate: string | null;
  readonly overdue: boolean;
  readonly canEdit: boolean;
  readonly onChange: (dueDate: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const label =
    props.dueDate === null
      ? "No due date"
      : dateFromKey(props.dueDate).toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
  const value = (
    <PropertyValue
      icon={
        <CalendarIcon
          className={cn("size-4", props.overdue ? "text-destructive" : "text-muted-foreground")}
        />
      }
      value={<span className={cn(props.overdue && "text-destructive")}>{label}</span>}
      muted={props.dueDate === null}
    />
  );
  if (!props.canEdit) {
    return (
      <span className="flex h-7 max-w-full items-center gap-2 px-2 text-sm" aria-label="Due date">
        {value}
      </span>
    );
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className="max-w-full justify-start"
            aria-label="Due date"
          />
        }
      >
        {value}
      </PopoverTrigger>
      <PopoverPopup align="start" aria-label="Choose a due date">
        <Calendar
          mode="single"
          selected={props.dueDate === null ? undefined : dateFromKey(props.dueDate)}
          {...(props.dueDate === null ? {} : { defaultMonth: dateFromKey(props.dueDate) })}
          onSelect={(selected: Date | undefined) => {
            setOpen(false);
            props.onChange(selected === undefined ? null : dateKey(selected));
          }}
        />
        {props.dueDate !== null ? (
          <div className="flex justify-end pt-2">
            <Button
              size="xs"
              variant="ghost-muted"
              onClick={() => {
                setOpen(false);
                props.onChange(null);
              }}
            >
              Clear
            </Button>
          </div>
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}

/**
 * The ticket's label pills and a multi-select to change them. Toggles made while earlier ones are
 * still saving build on a local draft, so quick clicks never undo each other.
 */
function LabelsField(props: {
  readonly environmentId: EnvironmentId;
  readonly ticket: KanbanTicket;
  readonly snapshot: KanbanSnapshot;
  readonly lookups: KanbanLookups;
  readonly canEdit: boolean;
  readonly onPatch: (patch: KanbanTicketPatch) => Promise<boolean>;
}) {
  const { ticket, snapshot, lookups } = props;
  const createLabel = useAtomCommand(botsEnvironment.kanbanCreateLabel, {
    label: "kanban create label",
  });
  const [draft, setDraft] = useState<ReadonlyArray<string> | null>(null);
  const inFlight = useRef(0);
  const [query, setQuery] = useState("");
  const labelIds = draft ?? ticket.labelIds;
  const options = labelOptions(snapshot, ticket);
  const shown = labelIds.flatMap((id) => {
    const label = lookups.labelsById.get(id);
    return label === undefined ? [] : [label];
  });

  const save = async (next: ReadonlyArray<string>) => {
    setDraft(next);
    inFlight.current += 1;
    await props.onPatch({ labelIds: [...next] });
    inFlight.current -= 1;
    if (inFlight.current === 0) setDraft(null);
  };
  const toggle = (label: KanbanLabel) =>
    void save(
      labelIds.includes(label.id)
        ? labelIds.filter((id) => id !== label.id)
        : [...labelIds, label.id],
    );
  const create = async () => {
    const name = query.trim();
    const result = await createLabel({
      environmentId: props.environmentId,
      input: { name, color: nextLabelColor(snapshot.labels) },
    });
    if (!reportCommandResult("Could not create the label", result)) return;
    if (result._tag !== "Success") return;
    setQuery("");
    await save([...labelIds, result.value.id]);
  };

  const filtered = options.filter((label) => matchesQuery(label.name, query));
  const canCreate =
    ticket.linear === null &&
    query.trim() !== "" &&
    !options.some((label) => label.name.toLowerCase() === query.trim().toLowerCase());

  return (
    <div className="flex flex-wrap items-center gap-1 px-1" aria-busy={draft !== null}>
      {shown.map((label) => (
        <KanbanLabelPill
          key={label.id}
          name={label.name}
          color={label.color}
          {...(props.canEdit ? { onRemove: () => toggle(label) } : {})}
        />
      ))}
      {props.canEdit ? (
        <Menu
          onOpenChange={(open) => {
            if (open) setQuery("");
          }}
        >
          <MenuTrigger
            render={
              <Button
                size={shown.length === 0 ? "sm" : "icon-xs"}
                variant="ghost-muted"
                aria-label="Change labels"
              />
            }
          >
            {shown.length === 0 ? (
              <>
                <TagIcon />
                Add label
              </>
            ) : (
              <PlusIcon />
            )}
          </MenuTrigger>
          <MenuPopup align="start" className="max-h-80 w-64">
            <MenuSearchInput
              placeholder={ticket.linear === null ? "Find or create a label…" : "Labels…"}
              aria-label="Search labels"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {filtered.map((label) => (
              <MenuCheckboxItem
                key={label.id}
                checked={labelIds.includes(label.id)}
                onCheckedChange={() => toggle(label)}
              >
                <span className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="size-2 shrink-0 rounded-full"
                    style={{ backgroundColor: label.color }}
                  />
                  <span className="truncate">{label.name}</span>
                </span>
              </MenuCheckboxItem>
            ))}
            {filtered.length === 0 && !canCreate ? (
              <p className="px-2 py-1.5 text-muted-foreground text-xs">No labels</p>
            ) : null}
            {canCreate ? (
              <>
                {filtered.length > 0 ? <MenuSeparator /> : null}
                <MenuItem onClick={() => void create()}>
                  <PlusIcon />
                  <span className="truncate">Create label "{query.trim()}"</span>
                </MenuItem>
              </>
            ) : null}
          </MenuPopup>
        </Menu>
      ) : shown.length === 0 ? (
        <span className="px-1 text-muted-foreground text-sm">No labels</span>
      ) : null}
    </div>
  );
}
