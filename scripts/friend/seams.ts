/**
 * Every place the friend fork edits an upstream file. Each listed file must carry exactly
 * `markers` occurrences of FORK_MARKER, and no other tracked file may carry it. A merge that
 * drops or duplicates a fork hunk fails `check-seams` instead of shipping silently.
 *
 * Fork-owned files (see FORK_OWNED_PREFIXES) are not listed: upstream never touches them.
 */
export const FORK_MARKER = "Fork (friend)";

export interface Seam {
  readonly file: string;
  readonly markers: number;
  readonly why: string;
}

export const SEAMS: readonly Seam[] = [
  {
    file: "packages/contracts/src/settings.ts",
    markers: 1,
    why: "sidebarBotsLayout client setting",
  },
  {
    file: "apps/web/src/components/Sidebar.tsx",
    markers: 2,
    why: "Bots block, tabs, bot threads kept out of the thread list",
  },
  {
    file: "apps/web/src/components/settings/SettingsPanels.tsx",
    markers: 1,
    why: "Bots in sidebar setting row",
  },
  {
    file: "apps/web/src/components/settings/settingsSearch.ts",
    markers: 1,
    why: "Bots in sidebar search entry",
  },
];

/** Paths the fork owns outright; markers there are allowed and not counted. */
export const FORK_OWNED_PREFIXES: readonly string[] = [
  "apps/web/src/friend/",
  "apps/server/src/friend/",
  "packages/contracts/src/friend.ts",
  "scripts/friend/",
  "FORK.md",
];
