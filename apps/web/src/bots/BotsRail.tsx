import {
  botGroupKey,
  botSignal,
  groupBotRows,
  type BotRowModel,
  type BotThreadShell,
} from "@t3tools/client-runtime/bot-directory";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { BellIcon, ListTreeIcon, PlusIcon } from "lucide-react";
import { useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../components/ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useNowMinute } from "../hooks/useNowMinute";
import { BotAvatar } from "./BotAvatar";
import {
  BotsSidebarSection,
  BotStatusDot,
  compactTimeLabel,
  useBotMenu,
  useBotsArrangement,
  useOpenBotsSettings,
} from "./BotsSidebarSection";

const RAIL_ITEM = "data-bot-rail-item";
/** How long the pointer rests on the rail before the names slide out. */
const PEEK_DELAY_MS = 300;

/** Up and down move between the rail's buttons, wrapping at the ends. */
function moveRailFocus(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(`[${RAIL_ITEM}]`));
  const from = items.findIndex((item) => item === document.activeElement);
  if (from === -1) return;
  event.preventDefault();
  const step = event.key === "ArrowDown" ? 1 : -1;
  items[(from + step + items.length) % items.length]?.focus();
}

/** The line under a bot's name: what it waits on or does, and when it last acted. */
function statusLine(row: BotRowModel): string | null {
  const time =
    botSignal(row.status) === "working" || row.activityAt === null
      ? null
      : compactTimeLabel(row.activityAt);
  const parts = [row.preview, time].filter((part) => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}

/** A bot's face with its signal: amber body for a request or failure, a dot for the rest. */
function RailAvatar(props: { row: BotRowModel; size: number }) {
  const { row } = props;
  return (
    <span className={cn("relative flex shrink-0", row.status.kind === "settled" && "opacity-50")}>
      <BotAvatar botId={row.bot.id} size={props.size} alert={botSignal(row.status) === "request"} />
      <BotStatusDot row={row} />
    </span>
  );
}

function BotNameLines(props: { row: BotRowModel }) {
  const line = statusLine(props.row);
  return (
    <span className="min-w-0 flex-1 text-left">
      <span className="block truncate text-sm font-medium text-sidebar-foreground">
        {props.row.bot.name}
      </span>
      {line !== null ? (
        <span
          className={cn(
            "block truncate text-xs",
            botSignal(props.row.status) === "request"
              ? "text-warning-foreground"
              : "text-sidebar-muted-foreground",
          )}
        >
          {line}
        </span>
      ) : null}
    </span>
  );
}

const railButton =
  "group/bot relative flex h-10 w-full shrink-0 cursor-pointer items-center gap-2.5 rounded-lg px-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70";

function RailIconButton(props: {
  label: string;
  onClick: () => void;
  peek: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip disabled={props.peek}>
      <TooltipTrigger
        render={
          <button
            type="button"
            {...{ [RAIL_ITEM]: "" }}
            aria-label={props.label}
            onClick={props.onClick}
            className={cn(
              railButton,
              "h-8 text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
            )}
          />
        }
      >
        <span className="flex size-7.5 shrink-0 items-center justify-center">{props.children}</span>
        <span className={cn("truncate text-xs", !props.peek && "sr-only")}>{props.label}</span>
      </TooltipTrigger>
      <TooltipPopup side="right">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * The "rail" layout: bot avatars in the user's order and sections beside the thread list, so bots
 * and threads that need the user are on screen together. Resting the pointer on the rail slides
 * the names out over the threads; the bell lists the bots that need the user.
 */
export function BotsRail(props: {
  threads: ReadonlyArray<BotThreadShell>;
  activeThreadRef: ScopedThreadRef | null;
  onOpenThread: (threadRef: ScopedThreadRef) => void;
}) {
  const view = useBotsArrangement(props.threads);
  const showBotMenu = useBotMenu(view, null);
  const openBotsSettings = useOpenBotsSettings();
  const [peek, setPeek] = useState(false);
  const [organizing, setOrganizing] = useState(false);
  const [attentionOpen, setAttentionOpen] = useState(false);
  const peekTimer = useRef<number | null>(null);
  // Re-renders the relative times once a minute.
  useNowMinute();

  // Without a bots host there is nothing to show; the thread list keeps the whole width.
  if (view.environmentId === null) return null;

  const { shown, rows } = view;
  const groups =
    shown === null || rows === null ? [] : groupBotRows(shown.sections, rows, "arranged");
  const attention = (rows ?? []).filter((row) => {
    const signal = botSignal(row.status);
    return signal === "request" || signal === "unseen";
  });
  const active = props.activeThreadRef;
  const isActive = (row: BotRowModel) =>
    active !== null &&
    active.environmentId === row.threadRef.environmentId &&
    active.threadId === row.threadRef.threadId;

  const cancelPeekTimer = () => {
    if (peekTimer.current !== null) window.clearTimeout(peekTimer.current);
    peekTimer.current = null;
  };
  const closePeek = () => {
    cancelPeekTimer();
    setPeek(false);
  };
  const open = (row: BotRowModel) => {
    closePeek();
    setOrganizing(false);
    setAttentionOpen(false);
    props.onOpenThread(row.threadRef);
  };

  return (
    <>
      <div aria-hidden className="w-12 shrink-0" />
      <nav
        aria-label="Bots"
        onPointerEnter={(event) => {
          if (event.pointerType !== "mouse" || organizing) return;
          cancelPeekTimer();
          peekTimer.current = window.setTimeout(() => setPeek(true), PEEK_DELAY_MS);
        }}
        onPointerLeave={closePeek}
        onFocus={(event) => {
          if (!organizing && event.target.matches(":focus-visible")) setPeek(true);
        }}
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) closePeek();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") closePeek();
          else moveRailFocus(event);
        }}
        className={cn(
          "absolute inset-y-0 left-0 z-20 flex flex-col gap-0.5 overflow-x-hidden overflow-y-auto border-r border-sidebar-border bg-sidebar p-1 [scrollbar-width:none]",
          peek ? "right-0 max-w-64 shadow-lg" : "w-12",
        )}
      >
        <Popover open={attentionOpen} onOpenChange={setAttentionOpen}>
          <PopoverTrigger
            render={
              <button
                type="button"
                {...{ [RAIL_ITEM]: "" }}
                disabled={attention.length === 0}
                aria-label={
                  attention.length === 0
                    ? "No bot needs you"
                    : `${attention.length} ${attention.length === 1 ? "bot needs" : "bots need"} you`
                }
                className={cn(
                  railButton,
                  "h-8 text-sidebar-muted-foreground enabled:hover:bg-sidebar-row-hover enabled:hover:text-sidebar-foreground disabled:cursor-default disabled:opacity-50",
                )}
              />
            }
          >
            <span className="relative flex size-7.5 shrink-0 items-center justify-center">
              <BellIcon className="size-4" />
              {attention.length > 0 ? (
                <span className="absolute -top-0.5 -right-0.5 min-w-4 rounded-full bg-warning-surface px-1 text-center text-3xs leading-4 font-medium text-warning-foreground">
                  {attention.length}
                </span>
              ) : null}
            </span>
            <span className={cn("truncate text-xs", !peek && "sr-only")}>
              {attention.length === 0 ? "Nothing needs you" : "Needs you"}
            </span>
          </PopoverTrigger>
          <PopoverPopup side="right" align="start" width="sm" padding="compact">
            <PopoverTitle className="mb-1">Needs you</PopoverTitle>
            <ul className="flex flex-col gap-px">
              {attention.map((row) => (
                <li key={row.bot.id}>
                  <button
                    type="button"
                    onClick={() => open(row)}
                    className="group/bot flex w-full cursor-pointer items-center gap-2.5 rounded-md p-1 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
                  >
                    <RailAvatar row={row} size={26} />
                    <BotNameLines row={row} />
                  </button>
                </li>
              ))}
            </ul>
          </PopoverPopup>
        </Popover>
        {groups.map((group, index) => (
          <div key={botGroupKey(group.section)} className="flex flex-col gap-0.5">
            {index > 0 || group.section !== null ? (
              peek ? (
                <span className="truncate px-1.5 pt-1.5 text-2xs font-medium text-sidebar-muted-foreground">
                  {group.section?.name ?? "Bots"}
                </span>
              ) : (
                <span
                  role="separator"
                  aria-label={group.section?.name ?? "Bots"}
                  className="mx-auto my-1 h-px w-6 bg-sidebar-border"
                />
              )
            ) : null}
            {group.rows.map((row) => {
              const selected = isActive(row);
              return (
                <button
                  key={row.bot.id}
                  type="button"
                  {...{ [RAIL_ITEM]: "" }}
                  aria-current={selected ? "page" : undefined}
                  onClick={() => open(row)}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    void showBotMenu(row, { x: event.clientX, y: event.clientY });
                  }}
                  className={cn(
                    railButton,
                    selected ? "bg-sidebar-row-selected" : "hover:bg-sidebar-row-hover",
                  )}
                >
                  {selected ? (
                    <span
                      aria-hidden
                      className="absolute top-1/2 -left-1 h-5 w-1 -translate-y-1/2 rounded-r-full bg-sidebar-foreground"
                    />
                  ) : null}
                  <RailAvatar row={row} size={30} />
                  {peek ? (
                    <BotNameLines row={row} />
                  ) : (
                    <span className="sr-only">
                      {row.preview === null ? row.bot.name : `${row.bot.name}, ${row.preview}`}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        ))}
        <div className="mt-auto flex flex-col gap-0.5 pt-1">
          <RailIconButton
            label="Organize bots"
            peek={peek}
            onClick={() => {
              closePeek();
              setOrganizing((value) => !value);
            }}
          >
            <ListTreeIcon className="size-4" />
          </RailIconButton>
          <RailIconButton label="New bot" peek={peek} onClick={openBotsSettings}>
            <PlusIcon className="size-4" />
          </RailIconButton>
        </div>
      </nav>
      {organizing ? (
        <div
          role="dialog"
          aria-label="Organize bots"
          onKeyDown={(event) => {
            if (event.key === "Escape") setOrganizing(false);
          }}
          className="absolute inset-y-0 right-0 left-12 z-10 overflow-y-auto border-l border-sidebar-border bg-sidebar p-2"
        >
          <BotsSidebarSection
            collapsible={false}
            order="arranged"
            threads={props.threads}
            activeThreadRef={props.activeThreadRef}
            onOpenThread={(threadRef) => {
              setOrganizing(false);
              props.onOpenThread(threadRef);
            }}
          />
        </div>
      ) : null}
    </>
  );
}
