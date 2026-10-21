/**
 * Every place the friend fork edits an upstream file. A source file must carry exactly `markers`
 * occurrences of FORK_MARKER (one per edited hunk), and no unlisted tracked file may carry it.
 * Files that cannot hold comments (JSON) list a `contains` snippet instead. A merge that drops or
 * duplicates a fork hunk fails `check-seams` instead of shipping silently.
 *
 * Fork-owned files (FORK_OWNED_PREFIXES) are not listed: upstream never touches them.
 */
export const FORK_MARKER = "Fork (friend)";

export type Seam =
  | { readonly file: string; readonly markers: number; readonly why: string }
  | { readonly file: string; readonly contains: string; readonly why: string };

export const SEAMS: readonly Seam[] = [
  { file: "apps/mobile/src/App.tsx", markers: 2, why: "mount direct bot push registration" },
  {
    file: "apps/mobile/src/features/agent-awareness/androidNotifications.ts",
    markers: 2,
    why: "configure direct bot pushes",
  },
  {
    file: "apps/mobile/src/persistence/mobile-preferences.ts",
    markers: 3,
    why: "persist bot notification preference",
  },
  {
    file: "apps/mobile/src/features/settings/SettingsNotificationsRouteScreen.tsx",
    markers: 3,
    why: "independent bot notifications switch",
  },
  {
    file: "apps/mobile/src/features/settings/SettingsRouteScreen.tsx",
    markers: 1,
    why: "local-only notification settings",
  },
  {
    file: "apps/mobile/modules/t3-agent-notifications/android/src/main/java/expo/modules/t3agentnotifications/AgentNotifications.kt",
    markers: 2,
    why: "direct bot notification delivery",
  },
  {
    file: "apps/mobile/modules/t3-agent-notifications/android/src/main/java/expo/modules/t3agentnotifications/T3AgentNotificationsModule.kt",
    markers: 1,
    why: "bot native configuration",
  },
  {
    file: "apps/mobile/modules/t3-agent-notifications/android/src/test/java/expo/modules/t3agentnotifications/AgentNotificationsTest.kt",
    markers: 1,
    why: "independent bot delivery test",
  },
  {
    file: "packages/contracts/src/settings.ts",
    markers: 1,
    why: "sidebarBotsLayout client setting",
  },
  { file: "packages/contracts/src/index.ts", markers: 1, why: "export bots contracts" },
  {
    file: "packages/contracts/src/environment.ts",
    markers: 3,
    why: "bots host, dictation and voice reader capabilities",
  },
  { file: "packages/contracts/src/rpc.ts", markers: 2, why: "bots RPCs in WsRpcGroup" },
  {
    file: "packages/contracts/src/clientRpcPermissions.ts",
    markers: 1,
    why: "bots mutations are guarded",
  },
  {
    file: "packages/provider-core/src/server/ProviderAdapter.ts",
    markers: 1,
    why: "appInstructions on the turn input",
  },
  {
    file: "packages/client-runtime/src/rpc/client.ts",
    markers: 2,
    why: "bots directory is a subscription; the voice reader is a stream command",
  },
  {
    file: "packages/client-runtime/src/operations/commands.ts",
    markers: 1,
    why: "bot threads keep their title",
  },
  {
    file: "packages/client-runtime/src/operations/commands.test.ts",
    markers: 1,
    why: "bot threads keep their title (test)",
  },
  {
    file: "packages/client-runtime/package.json",
    contains: '"./state/bots"',
    why: "export the bots atoms",
  },
  {
    file: "packages/client-runtime/package.json",
    contains: '"./bot-avatar"',
    why: "export the bot faces",
  },
  {
    file: "packages/client-runtime/package.json",
    contains: '"./voice-reader"',
    why: "export the voice reader driver",
  },
  { file: "apps/web/src/index.css", markers: 1, why: "bot face animations" },
  { file: "apps/server/src/auth/RpcAuthorization.ts", markers: 1, why: "bots RPC scopes" },
  {
    file: "apps/server/src/observability/RpcInstrumentation.ts",
    markers: 1,
    why: "bots RPC trace labels",
  },
  { file: "apps/server/src/ws.ts", markers: 4, why: "serve the bots RPCs from their own layer" },
  {
    file: "apps/server/src/orchestration-v2/RunExecutionService.ts",
    markers: 4,
    why: "resolve bot instructions per turn",
  },
  {
    file: "apps/web/src/components/chat/MessagesTimeline.tsx",
    markers: 3,
    why: "name the bot that sent a message",
  },
  {
    file: "apps/mobile/src/features/threads/ThreadFeed.tsx",
    markers: 2,
    why: "name the bot that sent a message",
  },
  {
    file: "apps/server/src/orchestration-v2/ProviderTurnStartService.ts",
    markers: 2,
    why: "mark messages a bot sends another thread",
  },
  {
    file: "apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts",
    markers: 4,
    why: "bot instructions in the system prompt",
  },
  {
    file: "apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts",
    markers: 3,
    why: "bot instructions as application context",
  },
  {
    file: "apps/server/src/orchestration-v2/RunExecutionService.test.ts",
    markers: 2,
    why: "bot instructions tests",
  },
  {
    file: "apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.test.ts",
    markers: 2,
    why: "bot instructions tests",
  },
  {
    file: "apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.test.ts",
    markers: 2,
    why: "bot instructions tests",
  },
  {
    file: "apps/server/src/mcp/McpHttpServer.ts",
    markers: 2,
    why: "register bots memory, bot management and thread watch tools",
  },
  {
    file: "apps/server/src/mcp/toolkits/worktree/registration.test.ts",
    markers: 3,
    why: "stub BotsService and ThreadWatchStore for the MCP layer",
  },
  {
    file: "apps/server/src/environment/ServerEnvironment.ts",
    markers: 6,
    why: "advertise bots only on the bots host, dictation only with a key, the voice reader always",
  },
  {
    file: "apps/server/src/server.ts",
    markers: 5,
    why: "bots layers and the Computer stream route",
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
    markers: 5,
    why: "Bots in sidebar setting and the Bots settings page",
  },
  {
    file: "apps/web/src/rightPanelStore.ts",
    markers: 3,
    why: "Computer surface kind",
  },
  {
    file: "apps/web/src/components/RightPanelTabs.tsx",
    markers: 10,
    why: "Computer in the surface launchers",
  },
  {
    file: "apps/mobile/src/features/voice-input/VoiceInputProvider.tsx",
    markers: 7,
    why: "server dictation where the device cannot transcribe; Android permission dialog",
  },
  {
    file: "apps/mobile/app.config.ts",
    markers: 4,
    why: "Android records audio for dictation; the voice reader's WebRTC plugin",
  },
  {
    file: "apps/mobile/src/features/threads/ThreadHeader.tsx",
    markers: 4,
    why: "voice reader action in the Android thread header",
  },
  {
    file: "apps/mobile/src/features/threads/ThreadRouteScreen.tsx",
    markers: 1,
    why: "pass the thread to the voice reader action",
  },
  {
    file: "apps/mobile/src/features/threads/useThreadHeaderOptions.test.tsx",
    markers: 1,
    why: "header tests stub the voice reader",
  },
  {
    file: "apps/mobile/src/components/ui/AppSymbol.tsx",
    markers: 2,
    why: "speaker and waveform glyphs for the voice reader",
  },
  {
    file: "apps/web/src/components/chat/ChatHeader.tsx",
    markers: 2,
    why: "voice reader button in the thread header",
  },
  {
    file: "apps/web/src/components/chat/ChatComposer.tsx",
    markers: 2,
    why: "dictation button in the composer",
  },
  {
    file: "apps/web/src/components/ChatView.tsx",
    markers: 2,
    why: "open the Computer surface from the launchers",
  },
  {
    file: "apps/web/src/components/chat/RightPanelSurfaceContent.tsx",
    markers: 2,
    why: "render the Computer surface",
  },
  {
    file: "apps/web/src/closedViewStore.ts",
    markers: 1,
    why: "reopen a closed Computer tab",
  },
  {
    file: "apps/web/src/components/settings/SettingsSidebarNav.tsx",
    markers: 1,
    why: "Bots settings nav icon",
  },
  {
    file: "apps/mobile/src/Stack.tsx",
    markers: 2,
    why: "Computer screen route on mobile",
  },
  {
    file: "apps/mobile/src/features/home/HomeRouteScreen.tsx",
    markers: 2,
    why: "bot threads kept out of the mobile home list",
  },
  {
    file: "apps/mobile/src/features/home/HomeScreen.tsx",
    markers: 4,
    why: "Bots section above the mobile home list",
  },
  {
    file: "apps/web/src/routeTree.gen.ts",
    contains: "from './routes/settings.bots'",
    why: "generated route for the Bots settings page",
  },
];

/** Paths the fork owns outright; markers there are allowed and not counted. */
export const FORK_OWNED_PREFIXES: readonly string[] = [
  "apps/web/src/bots/",
  "apps/mobile/src/bots/",
  "apps/mobile/plugins/withFriendVoiceReaderWebrtc",
  "apps/web/src/state/bots.ts",
  "apps/server/src/bots/",
  "packages/contracts/src/bots.ts",
  "packages/client-runtime/src/state/bots.ts",
  "packages/client-runtime/src/voiceReader",
  "scripts/friend/",
  ".github/workflows/friend-fork.yml",
  "FORK.md",
];
