import { botGroupKey, botSignal, groupBotRows } from "@t3tools/client-runtime/bot-directory";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { ChevronsLeftIcon, ChevronsRightIcon, PlusIcon } from "lucide-react";
import { useRef, useState, type KeyboardEvent } from "react";

import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useNowMinute } from "../hooks/useNowMinute";
import { BotAvatar } from "./BotAvatar";
import {
  BotsSidebarSection,
  BotStatusDot,
  compactTimeLabel,
  countRowsNeedingYou,
  useBotMenu,
  useBotsArrangement,
  useOpenBotsSettings,
} from "./BotsSidebarSection";
import type { BotRowModel, BotThreadShell } from "@t3tools/client-runtime/bot-directory";

const RAIL_ITEM = "data-bot-rail-item";

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

function RailBot(props: {
  row: BotRowModel;
  selected: boolean;
  onOpen: () => void;
  onContextMenu: (position: { x: number; y: number }) => void;
}) {
  const { bot, status, preview, activityAt } = props.row;
  const signal = botSignal(status);
  const timeLabel =
    signal === "working" || activityAt === null ? null : compactTimeLabel(activityAt);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            {...{ [RAIL_ITEM]: "" }}
            aria-label={preview === null ? bot.name : `${bot.name}, ${preview}`}
            aria-current={props.selected ? "page" : undefined}
            onClick={props.onOpen}
            onContextMenu={(event) => {
              event.preventDefault();
              props.onContextMenu({ x: event.clientX, y: event.clientY });
            }}
            className={cn(
              "group/bot relative flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
              props.selected ? "bg-sidebar-row-selected" : "hover:bg-sidebar-row-hover",
            )}
          />
        }
      >
        {props.selected ? (
          <span
            aria-hidden
            className="absolute top-1/2 -left-1 h-5 w-1 -translate-y-1/2 rounded-r-full bg-sidebar-foreground"
          />
        ) : null}
        <span className={cn("relative flex", status.kind === "settled" && "opacity-50")}>
          <BotAvatar botId={bot.id} size={30} alert={signal === "request"} />
          <BotStatusDot row={props.row} />
        </span>
      </TooltipTrigger>
      <TooltipPopup side="right">
        <span className="block font-medium">{bot.name}</span>
        {preview !== null || timeLabel !== null ? (
          <span
            className={cn(
              "block text-xs",
              signal === "request" ? "text-warning-foreground" : "text-muted-foreground",
            )}
          >
            {[preview, timeLabel].filter((part) => part !== null).join(" · ")}
          </span>
        ) : null}
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * The "rail" layout: bot avatars in the user's order and sections beside the thread list, so bots
 * and threads that need the user are on screen together. The top button opens the named list over
 * the threads, where sections and order are edited; picking a bot closes it.
 */
export function BotsRail(props: {
  threads: ReadonlyArray<BotThreadShell>;
  activeThreadRef: ScopedThreadRef | null;
  onOpenThread: (threadRef: ScopedThreadRef) => void;
}) {
  const view = useBotsArrangement(props.threads);
  const showBotMenu = useBotMenu(view, null);
  const openBotsSettings = useOpenBotsSettings();
  const [expanded, setExpanded] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  // Re-renders the relative times in the tooltips once a minute.
  useNowMinute();

  // Without a bots host there is nothing to show; the thread list keeps the whole width.
  if (view.environmentId === null) return null;

  const { shown, rows } = view;
  const groups =
    shown === null || rows === null ? [] : groupBotRows(shown.sections, rows, "arranged");
  const needsYou = countRowsNeedingYou(view.liveRows);
  const active = props.activeThreadRef;
  const collapse = () => {
    setExpanded(false);
    toggleRef.current?.focus();
  };

  return (
    <>
      <nav
        aria-label="Bots"
        onKeyDown={(event) => {
          if (event.key === "Escape" && expanded) collapse();
          else moveRailFocus(event);
        }}
        className="flex w-12 shrink-0 flex-col items-center gap-0.5 overflow-y-auto border-r border-sidebar-border py-1.5 [scrollbar-width:none]"
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                ref={toggleRef}
                type="button"
                {...{ [RAIL_ITEM]: "" }}
                aria-expanded={expanded}
                aria-label={
                  needsYou > 0
                    ? `${expanded ? "Hide" : "Show"} bot list, ${needsYou} need you`
                    : `${expanded ? "Hide" : "Show"} bot list`
                }
                onClick={() => setExpanded((value) => !value)}
                className={cn(
                  "relative flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-lg text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
                  expanded && "bg-sidebar-row-selected text-sidebar-foreground",
                )}
              />
            }
          >
            {expanded ? (
              <ChevronsLeftIcon className="size-4" />
            ) : (
              <ChevronsRightIcon className="size-4" />
            )}
            {needsYou > 0 ? (
              <span className="absolute top-0.5 right-0.5 min-w-4 rounded-full bg-warning-surface px-1 text-center text-3xs leading-4 font-medium text-warning-foreground">
                {needsYou}
              </span>
            ) : null}
          </TooltipTrigger>
          <TooltipPopup side="right">{expanded ? "Hide bot list" : "Show bot list"}</TooltipPopup>
        </Tooltip>
        {groups.map((group, index) => (
          <div key={botGroupKey(group.section)} className="flex flex-col items-center gap-0.5">
            {index > 0 || group.section !== null ? (
              <span
                role="separator"
                aria-label={group.section?.name ?? "Bots"}
                className="my-1 h-px w-6 bg-sidebar-border"
              />
            ) : null}
            {group.rows.map((row) => (
              <RailBot
                key={row.bot.id}
                row={row}
                selected={
                  active !== null &&
                  active.environmentId === row.threadRef.environmentId &&
                  active.threadId === row.threadRef.threadId
                }
                onOpen={() => {
                  setExpanded(false);
                  props.onOpenThread(row.threadRef);
                }}
                onContextMenu={(position) => void showBotMenu(row, position)}
              />
            ))}
          </div>
        ))}
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                {...{ [RAIL_ITEM]: "" }}
                aria-label="New bot"
                onClick={openBotsSettings}
                className="mt-1 flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-lg text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
              />
            }
          >
            <PlusIcon className="size-4" />
          </TooltipTrigger>
          <TooltipPopup side="right">New bot</TooltipPopup>
        </Tooltip>
      </nav>
      {expanded ? (
        <div
          role="dialog"
          aria-label="Bots"
          onKeyDown={(event) => {
            if (event.key === "Escape") collapse();
          }}
          className="absolute inset-y-0 right-0 left-12 z-20 overflow-y-auto border-l border-sidebar-border bg-sidebar p-2"
        >
          <BotsSidebarSection
            collapsible={false}
            threads={props.threads}
            activeThreadRef={props.activeThreadRef}
            onOpenThread={(threadRef) => {
              setExpanded(false);
              props.onOpenThread(threadRef);
            }}
          />
        </div>
      ) : null}
    </>
  );
}
