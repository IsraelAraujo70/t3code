/**
 * Tracked upstream files must contain exactly the listed marker count.
 * JSON files use contains snippets; fork-owned files are exempt.
 */
export const FORK_MARKER = "Fork (friend)";

export type Seam =
  | { readonly file: string; readonly markers: number; readonly why: string }
  | { readonly file: string; readonly contains: string; readonly why: string };

export const SEAMS: readonly Seam[] = [
  {
    file: "apps/mobile/src/App.tsx",
    markers: 3,
    why: "mount direct bot push registration and the self-update notice",
  },
  {
    file: "apps/mobile/src/features/agent-awareness/androidNotifications.ts",
    markers: 2,
    why: "configure direct bot pushes",
  },
  {
    file: "apps/mobile/src/persistence/mobile-preferences.ts",
    markers: 6,
    why: "persist bot notification preference and folded Bots tab sections",
  },
  {
    file: "apps/mobile/src/features/settings/SettingsNotificationsRouteScreen.tsx",
    markers: 3,
    why: "independent bot notifications switch",
  },
  {
    file: "apps/mobile/src/features/settings/SettingsRouteScreen.tsx",
    markers: 4,
    why: "local-only notification settings; the friend APK's update section; Android lists extra tabs under the bar's More",
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
    markers: 5,
    why: "sidebarBotsLayout client setting; voiceReaderVoice and voiceLanguage server settings",
  },
  { file: "packages/contracts/src/index.ts", markers: 1, why: "export bots and guest contracts" },
  {
    file: "packages/contracts/src/environment.ts",
    markers: 3,
    why: "bots host, dictation and voice capabilities",
  },
  { file: "packages/contracts/src/rpc.ts", markers: 2, why: "bots RPCs in WsRpcGroup" },
  {
    file: "packages/contracts/src/clientRpcPermissions.ts",
    markers: 1,
    why: "bots mutations are guarded",
  },
  {
    file: "packages/provider-core/src/server/ProviderAdapter.ts",
    markers: 2,
    why: "appInstructions and appTools on the turn input",
  },
  {
    file: "packages/client-runtime/src/rpc/client.ts",
    markers: 2,
    why: "bots directory is a subscription; a voice session is a stream command",
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
    file: "apps/server/package.json",
    contains: '"@modelcontextprotocol/sdk"',
    why: "guest app tools and the host MCP forward use the MCP SDK; upstream dropped it in 0.1.4",
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
    contains: '"./voice"',
    why: "export the voice session controller",
  },
  {
    file: "packages/client-runtime/package.json",
    contains: '"./bot-chat"',
    why: "export the bot chat layout rules",
  },
  {
    file: "packages/client-runtime/package.json",
    contains: '"./bot-directory"',
    why: "export the bot list rules shared by the sidebar and the mobile Bots tab",
  },
  {
    file: "packages/client-runtime/package.json",
    contains: '"./app-self-update"',
    why: "export the Android apps' self-update shared by the friend APK and the guest app",
  },
  {
    file: "packages/client-runtime/package.json",
    contains: '"./kanban-board"',
    why: "export the kanban board rules shared by the web and mobile boards",
  },
  {
    file: "packages/client-runtime/package.json",
    contains: '"./kanban-display"',
    why: "export the kanban display helpers shared by the web and mobile boards",
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
    why: "resolve bot instructions and guest tools per turn",
  },
  {
    file: "apps/web/src/components/chat/MessagesTimeline.tsx",
    markers: 8,
    why: "bot chats as bubbles: rows, bubble context, spacing, turn fold; a renewed bot conversation points to the previous one",
  },
  {
    file: "apps/mobile/src/components/ui/AppBar.types.ts",
    markers: 1,
    why: "Android app bar avatar slot for bot conversations",
  },
  {
    file: "apps/mobile/src/components/ui/AppBar.android.tsx",
    markers: 1,
    why: "Android app bar avatar slot for bot conversations",
  },
  {
    file: "apps/mobile/src/features/threads/ThreadHeader.tsx",
    markers: 4,
    why: "pass the bot's face to the app bar; the up arrow returns to the Kanban tab",
  },
  {
    file: "apps/mobile/src/features/threads/ThreadRouteScreen.tsx",
    markers: 5,
    why: 'bot conversation header: the bot\'s face, no "No project" subtitle; Back returns to the Kanban tab',
  },
  {
    file: "apps/web/src/components/chat/ChatHeader.tsx",
    markers: 2,
    why: "bot conversation header shows the bot's face instead of the Scratch project",
  },
  {
    file: "apps/web/src/components/chat/TimelineUserMessageRow.tsx",
    markers: 2,
    why: "name the bot that sent a message; user bubble shape",
  },
  {
    file: "apps/web/src/components/chat/TimelineAssistantRows.tsx",
    markers: 3,
    why: "bot reply bubble with its action row below; read a reply aloud",
  },
  {
    file: "apps/mobile/src/features/threads/ThreadFeed.tsx",
    markers: 11,
    why: "name the bot that sent a message; read a reply aloud; bot chats as bubbles; a renewed bot conversation points to the previous one",
  },
  {
    file: "apps/server/src/orchestration-v2/Orchestrator.ts",
    markers: 3,
    why: "pin a guest bot's thread to its sandboxed model",
  },
  {
    file: "apps/server/src/orchestration-v2/ProviderSessionManager.ts",
    markers: 4,
    why: "idle-only release for restarting a bot's session; no MCP credential for guest sandboxes",
  },
  {
    file: "apps/server/src/orchestration-v2/ProviderTurnStartService.ts",
    markers: 2,
    why: "mark messages a bot sends another thread",
  },
  {
    file: "apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts",
    markers: 7,
    why: "bot instructions in the system prompt; no host skills for guest sandboxes; bot app tools",
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
    file: "apps/server/src/scheduledTasks/ScheduledTaskService.ts",
    markers: 2,
    why: "rebindThread moves a bot's tasks to its next conversation generation",
  },
  {
    file: "apps/server/src/mcp/OrchestratorMcpToolkit.integration.test.ts",
    markers: 1,
    why: "stub ScheduledTaskService.rebindThread",
  },
  {
    file: "apps/server/src/peer/PeerForwarding.test.ts",
    markers: 2,
    why: "provide BotLinkAccess.layerAllowingEveryone to the gated peer services",
  },
  {
    file: "apps/server/src/peer/PeerLinkRequests.test.ts",
    markers: 2,
    why: "provide BotLinkAccess.layerAllowingEveryone to the gated peer services",
  },
  {
    file: "apps/server/src/peer/RemoteDelegation.test.ts",
    markers: 2,
    why: "provide BotLinkAccess.layerAllowingEveryone to the gated peer services",
  },
  {
    file: "apps/server/src/peer/PeerForwarding.ts",
    markers: 2,
    why: "every call to a linked environment passes BotLinkAccess",
  },
  {
    file: "apps/server/src/peer/PeerLinkRequests.ts",
    markers: 2,
    why: "only callers BotLinkAccess allows ask for a link",
  },
  {
    file: "apps/server/src/mcp/McpHttpServer.ts",
    markers: 4,
    why: "register bots memory, bot management and thread watch tools; BotLinkAccess narrows linkedEnvironments",
  },
  {
    file: "apps/server/src/environment/ServerEnvironment.ts",
    markers: 6,
    why: "advertise bots only on the bots host, dictation only with a key, voice always",
  },
  {
    file: "apps/server/src/server.ts",
    markers: 8,
    why: "bots layers, the Computer stream, the app update routes, the public webhook base and BotLinkAccess",
  },
  {
    file: "apps/web/src/components/Sidebar.tsx",
    markers: 3,
    why: "Bots block, tabs, the bots rail, bot threads kept out of the thread list",
  },
  {
    file: "apps/web/src/components/ui/sidebar.tsx",
    markers: 1,
    why: "aside slot beside the scrolling list for the bots rail",
  },
  {
    file: "apps/web/src/components/settings/SettingsPanels.tsx",
    markers: 1,
    why: "Bots in sidebar setting row",
  },
  {
    file: "apps/web/src/components/settings/settingsSearch.ts",
    markers: 9,
    why: "Bots in sidebar setting, the Bots and Kanban settings pages, and their moved anchors",
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
    markers: 7,
    why: "Android records audio for dictation; the voice reader's WebRTC plugin; the preview APK's self-update",
  },
  {
    file: "apps/mobile/src/features/threads/ThreadComposer.tsx",
    markers: 3,
    why: "voice controls in compact and card dictation action slots",
  },
  {
    file: "apps/mobile/src/features/threads/ThreadDetailScreen.tsx",
    markers: 5,
    why: "voice orb in the feed slot; an earlier bot generation has no composer",
  },
  {
    file: "apps/mobile/src/components/ui/AppSymbol.tsx",
    markers: 2,
    why: "speaker, waveform, and muted microphone glyphs for native voice",
  },
  {
    file: "apps/web/src/components/ui/button.tsx",
    markers: 1,
    why: "round icon button size for voice controls",
  },
  {
    file: "apps/web/src/components/chat/ChatComposer.tsx",
    markers: 3,
    why: "voice and dictation controls in the composer; working bot indicator",
  },
  {
    file: "apps/web/src/components/ChatView.tsx",
    markers: 4,
    why: "open the Computer surface from the launchers; an earlier bot generation has no composer",
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
    file: "apps/web/src/keybindings.ts",
    markers: 1,
    why: "app shortcuts leave keys to the Computer tab while it is in control",
  },
  {
    file: "apps/web/src/components/settings/SettingsSidebarNav.tsx",
    markers: 2,
    why: "Bots settings nav icon",
  },
  {
    file: "apps/mobile/src/Stack.tsx",
    markers: 2,
    why: "Computer and Kanban screen routes on mobile",
  },
  {
    file: "apps/mobile/src/features/home/HomeRouteScreen.tsx",
    markers: 2,
    why: "bot threads kept out of the mobile home list",
  },
  {
    file: "apps/mobile/src/features/home/HomeScreen.tsx",
    markers: 4,
    why: "Bots section above the iOS home list",
  },
  {
    file: "apps/mobile/src/features/workspace/workspace-tabs-state.ts",
    markers: 1,
    why: "Bots and Kanban tab state",
  },
  {
    file: "apps/mobile/src/features/threads/thread-list-v2-items.tsx",
    markers: 1,
    why: "export the section divider the iOS home Bots section uses",
  },
  {
    file: "apps/mobile/src/features/workspace/WorkspaceTabsContext.tsx",
    markers: 1,
    why: "Bots and Kanban tab scroll offsets",
  },
  {
    file: "apps/mobile/src/features/workspace/navigation-tab-order.ts",
    markers: 2,
    why: "Bots and Kanban are navigation tabs on Android (botsTab.android.ts)",
  },
  {
    file: "apps/mobile/src/features/workspace/navigation-tabs.ts",
    markers: 1,
    why: "Bots and Kanban tab icons",
  },
  {
    file: "apps/mobile/src/features/workspace/workspace-tab-navigation.ts",
    markers: 1,
    why: "the Bots and Kanban tabs have no remembered detail page",
  },
  {
    file: "apps/web/src/components/chat/MessagesTimeline.browser.test.tsx",
    markers: 1,
    why: "the query mock honors null, so user rows can read the bot directory",
  },
  {
    file: "apps/mobile/src/features/workspace/WorkspaceToolbar.ios.tsx",
    markers: 1,
    why: "the Bots and Kanban tab types have no iOS search label",
  },
  {
    file: "apps/mobile/src/features/layout/AdaptiveWorkspaceLayout.tsx",
    markers: 2,
    why: "bot conversations open from the Bots tab",
  },
  {
    file: "apps/mobile/src/features/workspace/WorkspaceRootScreen.android.tsx",
    markers: 5,
    why: "Bots and Kanban tab panes on Android",
  },
  {
    file: "apps/mobile/src/features/workspace/AndroidWorkspaceNavigation.android.tsx",
    markers: 4,
    why: "the phone bar and floating pill end in More, a menu of the tabs that do not fit and Settings",
  },
  {
    file: "apps/mobile/src/features/settings/SettingsNavigationRouteScreen.tsx",
    markers: 3,
    why: "Navigation tabs settings describe the phone bar's More menu",
  },
  {
    file: "apps/mobile/src/features/workspace/AndroidWorkspaceSidebar.android.tsx",
    markers: 2,
    why: "Bots tab in the Android split sidebar",
  },
  {
    file: "apps/mobile/modules/t3-native-controls/android/src/main/java/expo/modules/t3nativecontrols/T3WorkspaceNavigationModule.kt",
    markers: 11,
    why: "Bots and Kanban item titles and icons in the Android navigation bar and rail; More in the phone bar and the floating pill",
  },
  {
    file: "scripts/build-desktop-artifact.ts",
    markers: 4,
    why: "Mac build on Linux (no native rebuild) and friendBuild in the app's package.json",
  },
  { file: "apps/desktop/src/preload.ts", markers: 2, why: "Mac self-update bridge" },
  { file: "apps/desktop/src/ipc/DesktopIpcHandlers.ts", markers: 2, why: "Mac self-update IPC" },
  {
    file: "apps/web/src/components/sidebar/SidebarChrome.tsx",
    markers: 3,
    why: "the Mac app's self-update notice and the kanban button in the sidebar footer",
  },
  {
    file: "apps/web/src/components/sidebar/mainAppLocation.ts",
    markers: 1,
    why: "the kanban page is a utility page, like pull requests",
  },
  {
    file: "apps/web/src/routeTree.gen.ts",
    contains: "from './routes/_chat.settings.bots'",
    why: "generated route for the Bots settings page, inside the Settings layout",
  },
  {
    file: "apps/web/src/routeTree.gen.ts",
    contains: "from './routes/_chat.settings.kanban'",
    why: "Kanban settings route",
  },
  {
    file: "apps/web/src/components/settings/SettingsScopeSentence.tsx",
    markers: 1,
    why: "Bots host settings ignore scope",
  },
  {
    file: "apps/web/src/routeTree.gen.ts",
    contains: "from './routes/_chat.kanban'",
    why: "generated route for the kanban page",
  },
  {
    file: "apps/web/src/components/settings/settingsSearch.test.ts",
    markers: 1,
    why: "old Bots → Kanban links",
  },
];

/** Paths the fork owns outright; markers there are allowed and not counted. */
export const FORK_OWNED_PREFIXES: readonly string[] = [
  "apps/web/src/bots/",
  "apps/desktop/src/friend/",
  "apps/mobile/src/bots/",
  "apps/mobile/modules/t3-native-controls/android/src/main/res/drawable/t3_bots.xml",
  "apps/mobile/modules/t3-native-controls/android/src/main/res/drawable/t3_kanban.xml",
  "apps/mobile/plugins/withFriendVoiceReaderWebrtc",
  "apps/web/src/state/bots.ts",
  "apps/server/src/bots/",
  "packages/contracts/src/bots.ts",
  "packages/contracts/src/kanban.ts",
  "packages/contracts/src/guest.ts",
  "apps/bia/",
  "packages/client-runtime/src/state/bots.ts",
  "packages/client-runtime/src/voice.",
  "packages/client-runtime/src/botChat.",
  "packages/client-runtime/src/botDirectory.",
  "packages/client-runtime/src/appSelfUpdate.",
  "packages/client-runtime/src/kanbanBoard.",
  "packages/client-runtime/src/kanbanDisplay.",
  "scripts/friend/",
  ".github/workflows/friend-fork.yml",
  "FORK.md",
];
