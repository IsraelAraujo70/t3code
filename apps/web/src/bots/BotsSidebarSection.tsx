import { parseBotThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { Schema } from "effect";
import { PlusIcon } from "lucide-react";
import { useMemo, type ReactNode } from "react";

import { CollapsibleSectionHeader } from "../components/ui/collapsible-section-header";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useNowMinute } from "../hooks/useNowMinute";
import { useBotDirectory, useBotsEnvironmentId } from "../state/bots";
import { formatRelativeTimeLabel } from "../timestampFormat";
import { cn } from "~/lib/utils";
import {
  countBotsNeedingYou,
  resolveBotRows,
  type BotRowModel,
  type BotStatus,
  type BotThreadShell,
} from "./BotsSidebarSection.logic";

const BOTS_SECTION_EXPANDED_KEY = "t3code:bots:bots-section-expanded";
const BOTS_TAB_KEY = "t3code:bots:sidebar-tab";
const SidebarBotsTab = Schema.Literals(["bots", "threads"]);
type SidebarBotsTab = typeof SidebarBotsTab.Type;

/** A bot's main conversation is a `bot:<botId>:<generation>` thread; thread lists skip it. */
export function isBotThreadId(threadId: string): boolean {
  return parseBotThreadId(threadId) !== null;
}

/** The selected sidebar tab in the "tabs" layout, kept per device. */
export function useSidebarBotsTab() {
  return useLocalStorage<SidebarBotsTab, SidebarBotsTab>(BOTS_TAB_KEY, "bots", SidebarBotsTab);
}

/**
 * The bots host environment's bots matched to their main thread shells. `rows` is null until the
 * directory loads; `hostConnected` is false when no connected environment hosts bots. The section
 * and the tabs both call this; they share one directory subscription.
 */
function useBotRows(threads: ReadonlyArray<BotThreadShell>): {
  readonly rows: ReadonlyArray<BotRowModel> | null;
  readonly error: string | null;
  readonly hostConnected: boolean;
} {
  const environmentId = useBotsEnvironmentId();
  const { directory, error } = useBotDirectory(environmentId);
  const rows = useMemo(
    () =>
      environmentId === null || directory === null
        ? null
        : resolveBotRows(directory.bots, environmentId, threads),
    [directory, environmentId, threads],
  );
  return { rows, error, hostConnected: environmentId !== null };
}

function countRowsNeedingYou(rows: ReadonlyArray<BotRowModel> | null): number {
  return rows === null ? 0 : countBotsNeedingYou(rows.map((row) => row.status));
}

function compactTimeLabel(isoDate: string): string {
  const label = formatRelativeTimeLabel(isoDate);
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
}

function useOpenBotsSettings() {
  const navigate = useNavigate();
  return () => void navigate({ to: "/settings/bots" });
}

function BotStatusMark(props: { status: BotStatus }) {
  if (props.status.kind === "idle") return null;
  return (
    <span
      aria-label={props.status.kind === "needs-you" ? "Needs you" : "Working"}
      className={cn(
        "size-2 shrink-0 rounded-full",
        props.status.kind === "needs-you" ? "bg-warning" : "bg-primary",
      )}
    />
  );
}

function BotRow(props: { row: BotRowModel; selected: boolean; onOpen: () => void }) {
  const { bot, status, activityAt } = props.row;
  const timeLabel =
    status.kind === "working" || activityAt === null ? "" : compactTimeLabel(activityAt);
  return (
    <li>
      <button
        type="button"
        onClick={props.onOpen}
        aria-current={props.selected ? "page" : undefined}
        className={cn(
          "flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
          props.selected
            ? "bg-sidebar-row-selected text-sidebar-foreground"
            : "hover:bg-sidebar-row-hover",
          status.kind === "idle" && !props.selected
            ? "text-sidebar-muted-foreground"
            : "text-sidebar-foreground",
        )}
      >
        <span
          aria-hidden
          className="flex size-6 shrink-0 items-center justify-center rounded-md bg-sidebar-control-surface text-sm leading-none"
        >
          {bot.emoji}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{bot.name}</span>
          {status.detail !== null ? (
            <span className="block truncate text-2xs text-sidebar-muted-foreground">
              {status.detail}
            </span>
          ) : null}
        </span>
        <BotStatusMark status={status} />
        {timeLabel !== "" ? (
          <span className="shrink-0 text-2xs text-sidebar-muted-foreground">{timeLabel}</span>
        ) : null}
      </button>
    </li>
  );
}

function BotsNotice(props: { children: ReactNode }) {
  return <p className="px-2 py-1.5 text-xs text-sidebar-muted-foreground">{props.children}</p>;
}

/**
 * The Bots block of the sidebar: the primary environment's bots in their fixed order. A bot
 * never moves between shelves; its mark says whether it needs the user or is working. Each row
 * opens the bot's main conversation. The "tabs" layout hides the collapsible header because the
 * tab already names the list.
 */
export function BotsSidebarSection(props: {
  collapsible: boolean;
  threads: ReadonlyArray<BotThreadShell>;
  activeThreadRef: ScopedThreadRef | null;
  onOpenThread: (threadRef: ScopedThreadRef) => void;
}) {
  const [storedExpanded, setExpanded] = useLocalStorage(
    BOTS_SECTION_EXPANDED_KEY,
    true,
    Schema.Boolean,
  );
  const { rows, error, hostConnected } = useBotRows(props.threads);
  const openBotsSettings = useOpenBotsSettings();
  // Re-renders the relative times once a minute.
  useNowMinute();
  const needsYou = countRowsNeedingYou(rows);
  const expanded = !props.collapsible || storedExpanded;
  const activeThreadRef = props.activeThreadRef;
  return (
    <section aria-label="Bots" className="flex flex-col gap-px">
      {props.collapsible ? (
        <CollapsibleSectionHeader
          expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          tone="emphasized"
          accessory={
            <span className="flex items-center gap-1.5">
              {needsYou > 0 ? (
                <span className="rounded-full bg-warning-surface px-1.5 text-3xs leading-4 text-warning-foreground">
                  {needsYou}
                </span>
              ) : null}
              <span
                role="button"
                tabIndex={-1}
                aria-label="New bot"
                onClick={(event) => {
                  event.stopPropagation();
                  openBotsSettings();
                }}
                className="flex size-4 items-center justify-center rounded hover:bg-sidebar-row-hover"
              >
                <PlusIcon className="size-3" />
              </span>
            </span>
          }
        >
          Bots
        </CollapsibleSectionHeader>
      ) : null}
      {!expanded ? null : rows === null ? (
        <BotsNotice>
          {!hostConnected
            ? "Bots live on another machine that is not connected."
            : error === null
              ? "Loading bots…"
              : `Bots unavailable: ${error}`}
        </BotsNotice>
      ) : rows.length === 0 ? (
        <BotsNotice>
          No bots yet.{" "}
          <button
            type="button"
            onClick={openBotsSettings}
            className="cursor-pointer text-sidebar-foreground underline underline-offset-2"
          >
            Create one
          </button>
        </BotsNotice>
      ) : (
        <ul className="flex flex-col gap-px">
          {rows.map((row) => (
            <BotRow
              key={row.bot.id}
              row={row}
              selected={
                activeThreadRef !== null &&
                activeThreadRef.environmentId === row.threadRef.environmentId &&
                activeThreadRef.threadId === row.threadRef.threadId
              }
              onOpen={() => props.onOpenThread(row.threadRef)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

/** Heading that separates the Bots block from the thread list in the "sections" layout. */
export function SidebarThreadsHeading() {
  return (
    <div className="flex h-8 items-center gap-2 px-2 text-xs font-medium text-sidebar-foreground/80">
      <span className="shrink-0">Threads</span>
      <span aria-hidden className="h-px min-w-2 flex-1 bg-sidebar-foreground/25" />
    </div>
  );
}

/** Bots | Threads switch for the "tabs" layout, with a needs-you badge on each side. */
export function SidebarBotsTabs(props: {
  value: SidebarBotsTab;
  onChange: (tab: SidebarBotsTab) => void;
  threads: ReadonlyArray<BotThreadShell>;
  threadsNeedingYou: number;
}) {
  const { rows } = useBotRows(props.threads);
  const tabs = [
    { id: "bots", label: "Bots", badge: countRowsNeedingYou(rows) },
    { id: "threads", label: "Threads", badge: props.threadsNeedingYou },
  ] as const;
  return (
    <div
      role="tablist"
      className="mt-1.5 grid grid-cols-2 gap-0.5 rounded-md bg-sidebar-control-surface p-0.5"
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={props.value === tab.id}
          onClick={() => props.onChange(tab.id)}
          className={cn(
            "flex cursor-pointer items-center justify-center gap-1.5 rounded px-2 py-1 text-xs font-medium",
            props.value === tab.id
              ? "bg-sidebar text-sidebar-foreground shadow-xs"
              : "text-sidebar-muted-foreground hover:text-sidebar-foreground",
          )}
        >
          {tab.label}
          {tab.badge > 0 ? (
            <span className="rounded-full bg-warning-surface px-1.5 text-3xs leading-4 text-warning-foreground">
              {tab.badge}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
