import { Schema } from "effect";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { CollapsibleSectionHeader } from "../components/ui/collapsible-section-header";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { cn } from "~/lib/utils";

type BotStatus =
  | { readonly kind: "needs-you"; readonly detail: string }
  | { readonly kind: "working"; readonly detail: string }
  | { readonly kind: "idle" };

interface PrototypeBot {
  readonly id: string;
  readonly emoji: string;
  readonly name: string;
  readonly model: string;
  readonly status: BotStatus;
  readonly lastActivityLabel: string;
}

/**
 * Prototype roster: names, emojis and models come from the user's friend database;
 * statuses are fixed. Replaced by the server bot directory in plan phase 1.
 */
const PROTOTYPE_BOTS: readonly PrototypeBot[] = [
  {
    id: "moneria-pm",
    emoji: "🏦",
    name: "Moneria PM",
    model: "Claude Opus 5.5",
    status: { kind: "idle" },
    lastActivityLabel: "4h",
  },
  {
    id: "space-limp-po",
    emoji: "🧽",
    name: "Space Limp PO",
    model: "Claude Opus 5.5",
    status: { kind: "needs-you", detail: "Terminou · 3 PRs para revisar" },
    lastActivityLabel: "1h",
  },
  {
    id: "secretario",
    emoji: "🗂️",
    name: "Secretário",
    model: "Claude Sonnet 5.5",
    status: { kind: "idle" },
    lastActivityLabel: "11h",
  },
  {
    id: "financeiro",
    emoji: "💸",
    name: "Financeiro",
    model: "GPT-6.1-Sol",
    status: { kind: "idle" },
    lastActivityLabel: "5d",
  },
  {
    id: "linkedin",
    emoji: "💼",
    name: "LinkedIn",
    model: "Claude Opus 5.5",
    status: { kind: "idle" },
    lastActivityLabel: "10h",
  },
  {
    id: "insiderxl-pm",
    emoji: "📈",
    name: "InsiderXL PM",
    model: "Claude Opus 5.5",
    status: { kind: "needs-you", detail: "✋ Qual sprint eu fecho?" },
    lastActivityLabel: "agora",
  },
  {
    id: "father-bot",
    emoji: "🛠️",
    name: "FATHER BOT",
    model: "Claude Opus 5.5",
    status: { kind: "working", detail: "Rodando 2 tarefas" },
    lastActivityLabel: "",
  },
];

const BOT_THREAD_ID_PREFIX = "bot:";
const BOTS_SECTION_EXPANDED_KEY = "t3code:bots:bots-section-expanded";
const BOTS_TAB_KEY = "t3code:bots:sidebar-tab";

const SidebarBotsTab = Schema.Literals(["bots", "threads"]);
type SidebarBotsTab = typeof SidebarBotsTab.Type;

/** A bot's main conversation is a thread whose id starts with `bot:`; thread lists skip it. */
export function isBotThreadId(threadId: string): boolean {
  return threadId.startsWith(BOT_THREAD_ID_PREFIX);
}

/** How many bots are waiting on the user, for tab badges and the section header. */
export function countBotsNeedingYou(): number {
  return PROTOTYPE_BOTS.filter((bot) => bot.status.kind === "needs-you").length;
}

/** The selected sidebar tab in the "tabs" layout, kept per device. */
export function useSidebarBotsTab() {
  return useLocalStorage<SidebarBotsTab, SidebarBotsTab>(BOTS_TAB_KEY, "bots", SidebarBotsTab);
}

function BotStatusMark(props: { status: BotStatus }) {
  if (props.status.kind === "idle") return null;
  return (
    <span
      aria-label={props.status.kind === "needs-you" ? "Precisa de você" : "Trabalhando"}
      className={cn(
        "size-2 shrink-0 rounded-full",
        props.status.kind === "needs-you" ? "bg-warning" : "bg-primary",
      )}
    />
  );
}

function BotRow(props: { bot: PrototypeBot; selected: boolean; onSelect: () => void }) {
  const { bot } = props;
  const detail = bot.status.kind === "idle" ? null : bot.status.detail;
  return (
    <li>
      <button
        type="button"
        onClick={props.onSelect}
        className={cn(
          "flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
          props.selected
            ? "bg-sidebar-row-selected text-sidebar-foreground"
            : "hover:bg-sidebar-row-hover",
          bot.status.kind === "idle" && !props.selected
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
          {detail !== null ? (
            <span className="block truncate text-2xs text-sidebar-muted-foreground">{detail}</span>
          ) : null}
        </span>
        <BotStatusMark status={bot.status} />
        {bot.lastActivityLabel !== "" ? (
          <span className="shrink-0 text-2xs text-sidebar-muted-foreground">
            {bot.lastActivityLabel}
          </span>
        ) : null}
      </button>
    </li>
  );
}

/**
 * The Bots block of the sidebar: a fixed-order roster of long-lived bots. A bot never moves
 * between shelves; its mark says whether it needs the user or is working. The "tabs" layout
 * hides the collapsible header because the tab already names the list.
 */
export function BotsSidebarSection(props: { collapsible: boolean }) {
  const [storedExpanded, setExpanded] = useLocalStorage(
    BOTS_SECTION_EXPANDED_KEY,
    true,
    Schema.Boolean,
  );
  const [selectedBotId, setSelectedBotId] = useState<string | null>(null);
  const needsYou = countBotsNeedingYou();
  const expanded = !props.collapsible || storedExpanded;
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
                aria-label="Novo bot"
                onClick={(event) => event.stopPropagation()}
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
      {expanded ? (
        <ul className="flex flex-col gap-px">
          {PROTOTYPE_BOTS.map((bot) => (
            <BotRow
              key={bot.id}
              bot={bot}
              selected={selectedBotId === bot.id}
              onSelect={() => setSelectedBotId(bot.id)}
            />
          ))}
        </ul>
      ) : null}
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
  threadsNeedingYou: number;
}) {
  const tabs = [
    { id: "bots", label: "Bots", badge: countBotsNeedingYou() },
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
