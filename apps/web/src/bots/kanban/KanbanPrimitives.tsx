/**
 * The kanban's small Linear-style pieces: status and priority icons, avatars, label pills and PR
 * badges. Shared by cards, list rows, column headers, pickers and the issue view.
 */
import type {
  BotDirectoryEntry,
  KanbanPullRequestRef,
  LinearStateType,
  ThreadId,
} from "@t3tools/contracts";
import {
  THREAD_CARD_STATUS_LABELS,
  type KanbanGroupIcon,
  type ThreadCardStatus,
} from "@t3tools/client-runtime/kanban-board";
import { IterationCcwIcon, MessagesSquareIcon, XIcon } from "lucide-react";
import { useId, type ComponentProps, type PointerEvent, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuTrigger,
} from "../../components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { PullRequestActorAvatar } from "../../components/pullRequest/pullRequestPresentation";
import { PULL_REQUEST_STATE_PRESENTATION } from "../../components/pullRequest/pullRequestIcons";
import { BotAvatar } from "../BotAvatar";
import { personDisplay, type KanbanLookups, type KanbanPersonDisplay } from "./kanbanLookups";

const round = (value: number) => Math.round(value * 1000) / 1000;

/** Inner controls of a draggable card must not start a drag. */
export const stopDragStart = (event: PointerEvent) => event.stopPropagation();

function SvgIcon(props: ComponentProps<"svg"> & { readonly size: number }) {
  const { size, className, ...rest } = props;
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      className={cn("shrink-0", className)}
      {...rest}
    />
  );
}

/** A mask that keeps the 14×14 box and cuts out `children`, drawn in currentColor. */
function CutoutMask(props: { readonly id: string; readonly children: ReactNode }) {
  return (
    <mask id={props.id}>
      {/* oxlint-disable-next-line shadcn/no-raw-colors -- mask luminance (white keeps), not a color */}
      <rect width="14" height="14" fill="white" />
      {/* oxlint-disable-next-line shadcn/no-raw-colors -- mask luminance (black cuts), not a color */}
      <g color="black">{props.children}</g>
    </mask>
  );
}

const STATUS_MARKS: Partial<Record<LinearStateType, string>> = {
  completed: "M4.4 7.3 6.2 9.1 9.7 5.3",
  canceled: "M5 5 9 9M9 5 5 9",
  duplicate: "M4.3 7h5.2M7.6 5l2 2-2 2",
};

/** Linear's status glyphs: dotted circle (backlog/triage), empty, half-filled, check, x, duplicate. */
export function KanbanStatusIcon(props: {
  readonly stateType: LinearStateType;
  readonly color: string;
  /** 0..1 fill for started states; Linear draws In Review fuller than In Progress. */
  readonly progress?: number;
  readonly size?: number;
}) {
  const maskId = useId();
  const size = props.size ?? 14;
  const { color } = props;
  switch (props.stateType) {
    case "triage":
    case "backlog":
      return (
        <SvgIcon size={size}>
          <circle cx="7" cy="7" r="6" stroke={color} strokeWidth="1.5" strokeDasharray="1.4 1.74" />
        </SvgIcon>
      );
    case "unstarted":
      return (
        <SvgIcon size={size}>
          <circle cx="7" cy="7" r="6" stroke={color} strokeWidth="1.5" />
        </SvgIcon>
      );
    case "started": {
      const progress = Math.min(1, Math.max(0, props.progress ?? 0.5));
      const angle = progress * 2 * Math.PI;
      const end = `${round(7 + 3.5 * Math.sin(angle))} ${round(7 - 3.5 * Math.cos(angle))}`;
      return (
        <SvgIcon size={size}>
          <circle cx="7" cy="7" r="6" stroke={color} strokeWidth="1.5" />
          {progress >= 1 ? (
            <circle cx="7" cy="7" r="3.5" fill={color} />
          ) : progress > 0 ? (
            <path d={`M7 7V3.5A3.5 3.5 0 ${progress > 0.5 ? 1 : 0} 1 ${end}Z`} fill={color} />
          ) : null}
        </SvgIcon>
      );
    }
    case "completed":
    case "canceled":
    case "duplicate":
      return (
        <SvgIcon size={size}>
          <CutoutMask id={maskId}>
            <path
              d={STATUS_MARKS[props.stateType]}
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </CutoutMask>
          <circle cx="7" cy="7" r="6.75" fill={color} mask={`url(#${maskId})`} />
        </SvgIcon>
      );
  }
}

const PRIORITY_BARS = [
  { x: 1.5, y: 8, height: 4.5 },
  { x: 5.5, y: 5, height: 7.5 },
  { x: 9.5, y: 1.5, height: 11 },
];

/** Linear's priority glyphs: three bars filled by level, the exclamation box for urgent, dashes for none. */
export function KanbanPriorityIcon(props: { readonly priority: number; readonly size?: number }) {
  const maskId = useId();
  const size = props.size ?? 14;
  if (props.priority === 1) {
    return (
      <SvgIcon size={size} className="text-warning">
        <CutoutMask id={maskId}>
          <rect x="6.25" y="3" width="1.5" height="5" rx="0.75" fill="currentColor" />
          <circle cx="7" cy="10.25" r="0.9" fill="currentColor" />
        </CutoutMask>
        <rect
          x="0.5"
          y="0.5"
          width="13"
          height="13"
          rx="3"
          fill="currentColor"
          mask={`url(#${maskId})`}
        />
      </SvgIcon>
    );
  }
  if (props.priority < 2 || props.priority > 4) {
    return (
      <SvgIcon size={size} className="text-muted-foreground" fill="currentColor">
        {PRIORITY_BARS.map((bar) => (
          <rect key={bar.x} x={bar.x} y="6.25" width="3" height="1.5" rx="0.5" />
        ))}
      </SvgIcon>
    );
  }
  const filled = 5 - props.priority;
  return (
    <SvgIcon size={size} className="text-muted-foreground" fill="currentColor">
      {PRIORITY_BARS.map((bar, index) => (
        <rect
          key={bar.x}
          x={bar.x}
          y={bar.y}
          width="3"
          height={bar.height}
          rx="1"
          opacity={index < filled ? 1 : 0.3}
        />
      ))}
    </SvgIcon>
  );
}

const AVATAR_SIZE_CLASS: Record<number, string> = {
  14: "size-3.5",
  16: "size-4",
  18: "size-4.5",
  20: "size-5",
  24: "size-6",
};

/** An image avatar with initials fallback, or the bot's face for a bot. */
export function KanbanAvatar(props: {
  readonly person: KanbanPersonDisplay | null;
  readonly size?: number;
}) {
  const size = props.size ?? 16;
  const { person } = props;
  if (person === null) {
    return (
      <SvgIcon size={size} className="text-muted-foreground">
        <circle
          cx="7"
          cy="7"
          r="6.25"
          stroke="currentColor"
          strokeWidth="1.2"
          strokeDasharray="2 1.6"
        />
      </SvgIcon>
    );
  }
  if (person.botId !== null) return <BotAvatar botId={person.botId} size={size} />;
  return (
    <PullRequestActorAvatar
      actor={{ login: person.name || "?", name: person.name, avatarUrl: person.avatarUrl }}
      className={AVATAR_SIZE_CLASS[size] ?? "size-4"}
    />
  );
}

const CHIP_CLASS =
  "inline-flex h-5 min-w-0 shrink-0 items-center gap-1 rounded-full border px-1.5 text-2xs text-muted-foreground";

/** The outline pill every card property sits in; `danger` for an overdue date. */
export function KanbanChip(
  props: ComponentProps<"span"> & { readonly tone?: "default" | "danger" },
) {
  const { tone, className, ...rest } = props;
  return (
    <span
      className={cn(
        CHIP_CLASS,
        tone === "danger" && "border-destructive/40 text-destructive",
        className,
      )}
      {...rest}
    />
  );
}

/** A label as Linear draws it: a colored dot and the name in a rounded outline pill. */
export function KanbanLabelPill(props: {
  readonly name: string;
  readonly color: string;
  readonly onRemove?: () => void;
}) {
  return (
    <KanbanChip className="max-w-40 px-2">
      <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: props.color }} />
      <span className="truncate">{props.name}</span>
      {props.onRemove ? (
        <button
          type="button"
          aria-label={`Remove ${props.name}`}
          className="-mr-0.5 inline-flex shrink-0 cursor-pointer rounded-full hover:text-foreground"
          onPointerDown={stopDragStart}
          onClick={props.onRemove}
        >
          <XIcon className="size-3" />
        </button>
      ) : null}
    </KanbanChip>
  );
}

const PULL_REQUEST_RANK: Record<KanbanPullRequestRef["state"], number> = {
  merged: 3,
  open: 2,
  draft: 1,
  closed: 0,
};

/** The PR number for one PR, "N PRs" for several, colored by the most advanced state. */
export function KanbanPullRequestBadge(props: {
  readonly pullRequests: ReadonlyArray<KanbanPullRequestRef>;
}) {
  const { pullRequests } = props;
  const lead = pullRequests.reduce<KanbanPullRequestRef | null>(
    (best, pullRequest) =>
      best === null || PULL_REQUEST_RANK[pullRequest.state] > PULL_REQUEST_RANK[best.state]
        ? pullRequest
        : best,
    null,
  );
  if (lead === null) return null;
  const presentation = PULL_REQUEST_STATE_PRESENTATION[lead.state];
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={CHIP_CLASS} />}>
        <presentation.Icon
          aria-hidden
          className={cn("size-3 shrink-0", presentation.toneClassName)}
        />
        <span>{pullRequests.length === 1 ? `#${lead.number}` : `${pullRequests.length} PRs`}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">
        {pullRequests.map((pullRequest) => (
          <div key={pullRequest.attachmentId} className="max-w-72 truncate">
            {pullRequest.repository}#{pullRequest.number} · {pullRequest.title} ·{" "}
            {PULL_REQUEST_STATE_PRESENTATION[pullRequest.state].label}
          </div>
        ))}
      </TooltipPopup>
    </Tooltip>
  );
}

/** A label or project color swatch: dot for labels, rounded square for projects. */
export function KanbanSwatch(props: {
  readonly color: string | null;
  readonly shape: "dot" | "square";
  readonly size?: number;
}) {
  const size = props.size ?? 10;
  return (
    <span
      aria-hidden
      className={cn(
        "shrink-0",
        props.shape === "dot" ? "rounded-full" : "rounded-xs",
        props.color === null && "bg-muted-foreground/50",
      )}
      style={{
        width: size,
        height: size,
        ...(props.color === null ? {} : { backgroundColor: props.color }),
      }}
    />
  );
}

/** A group's leading icon (columns, list sections, swimlanes, filter options). */
export function KanbanGroupIconView(props: {
  readonly icon: KanbanGroupIcon;
  readonly lookups: KanbanLookups;
  readonly size?: number;
}) {
  const { icon } = props;
  const size = props.size ?? 14;
  switch (icon.kind) {
    case "status":
      return <KanbanStatusIcon stateType={icon.stateType} color={icon.color} size={size} />;
    case "person":
      return (
        <KanbanAvatar
          person={icon.personId === null ? null : personDisplay(props.lookups, icon.personId)}
          size={size}
        />
      );
    case "priority":
      return <KanbanPriorityIcon priority={icon.priority} size={size} />;
    case "label":
      return <KanbanSwatch color={icon.color} shape="dot" size={Math.round(size * 0.65)} />;
    case "project":
      return <KanbanSwatch color={icon.color} shape="square" size={Math.round(size * 0.8)} />;
    case "cycle":
      return (
        <IterationCcwIcon
          aria-hidden
          className="shrink-0 text-muted-foreground"
          style={{ width: size, height: size }}
        />
      );
    case "threadStatus":
      return (
        <span
          aria-hidden
          className={cn(
            "shrink-0 rounded-full",
            icon.status === null
              ? "border border-muted-foreground/60"
              : THREAD_STATUS_DOT[icon.status],
          )}
          style={{ width: Math.round(size * 0.55), height: Math.round(size * 0.55) }}
        />
      );
    case "none":
      return null;
  }
}

/** Bots responsible for a ticket, as tiny faces; the name only in the tooltip. */
export function KanbanResponsibleBots(props: {
  readonly bots: ReadonlyArray<BotDirectoryEntry>;
  readonly size?: number;
}) {
  if (props.bots.length === 0) return null;
  return (
    <span className="flex shrink-0 items-center -space-x-1">
      {props.bots.map((bot) => (
        <Tooltip key={bot.id}>
          <TooltipTrigger render={<span className="inline-flex rounded-full" />}>
            <BotAvatar botId={bot.id} size={props.size ?? 14} />
          </TooltipTrigger>
          <TooltipPopup side="top">{bot.name} is responsible</TooltipPopup>
        </Tooltip>
      ))}
    </span>
  );
}

const THREAD_STATUS_DOT: Record<ThreadCardStatus, string> = {
  approval: "bg-amber-500 dark:bg-amber-300/90",
  input: "bg-indigo-500 dark:bg-indigo-300/90",
  failed: "bg-red-500 dark:bg-red-400/90",
  working: "bg-sky-500 dark:bg-sky-300/90",
  settled: "bg-emerald-500 dark:bg-emerald-400/80",
};

export interface KanbanLinkedThread {
  readonly id: ThreadId;
  readonly title: string;
  readonly status: ThreadCardStatus;
}

/** Linked threads as an icon, a count and one status dot each; clicking lists them. */
export function KanbanThreadsBadge(props: {
  readonly threads: ReadonlyArray<KanbanLinkedThread>;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { threads } = props;
  if (threads.length === 0) return null;
  return (
    <Menu>
      <MenuTrigger
        render={
          <button
            type="button"
            aria-label={`${threads.length} linked ${threads.length === 1 ? "thread" : "threads"}`}
            className="inline-flex h-5 shrink-0 cursor-pointer items-center gap-1 rounded px-1 text-2xs text-muted-foreground hover:bg-accent hover:text-foreground"
            onPointerDown={stopDragStart}
          />
        }
      >
        <MessagesSquareIcon aria-hidden className="size-3" />
        <span className="tabular-nums">{threads.length}</span>
        <span className="flex items-center gap-0.5">
          {threads.slice(0, 5).map((thread) => (
            <Tooltip key={thread.id}>
              <TooltipTrigger
                render={
                  <span className={cn("size-1.5 rounded-full", THREAD_STATUS_DOT[thread.status])} />
                }
              />
              <TooltipPopup side="top">
                {thread.title} · {THREAD_CARD_STATUS_LABELS[thread.status]}
              </TooltipPopup>
            </Tooltip>
          ))}
        </span>
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuGroup>
          <MenuGroupLabel>Linked threads</MenuGroupLabel>
          {threads.map((thread) => (
            <MenuItem key={thread.id} onClick={() => props.onOpenThread(thread.id)}>
              <span
                className={cn("size-1.5 shrink-0 rounded-full", THREAD_STATUS_DOT[thread.status])}
              />
              <span className="max-w-64 truncate">{thread.title}</span>
              <span className="ml-auto pl-3 text-muted-foreground text-xs">
                {THREAD_CARD_STATUS_LABELS[thread.status]}
              </span>
            </MenuItem>
          ))}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
