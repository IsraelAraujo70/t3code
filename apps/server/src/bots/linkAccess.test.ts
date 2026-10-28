import * as DocumentText from "../provider/DocumentText.ts";
import { NodeHttpServer } from "@effect/platform-node";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  BotId,
  botThreadId,
  CommandId,
  EnvironmentId,
  EventId,
  GuestId,
  MessageId,
  NodeId,
  OrchestratorMcpFailure,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as McpToolAccess from "../mcp/McpToolAccess.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as PeerLinkRequests from "../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as GuestStore from "./guest/GuestStore.ts";
import * as BotLinkAccess from "./linkAccess.ts";

const allowedBot = BotId.make("b_allowed");
const deniedBot = BotId.make("b_denied");
const guestBot = BotId.make("b_guest");

describe("originAllows", () => {
  const thread = (id: string) => ThreadId.make(id);
  const origins = (
    shells: Record<string, { readonly parent: string | null; readonly root: string }>,
    senders: Record<string, ReadonlyArray<string>> = {},
    agentSchedules: ReadonlyArray<string> = [],
  ): BotLinkAccess.ThreadOrigins => ({
    lineage: (threadId) => {
      const shell = shells[threadId];
      return Effect.succeed(
        shell === undefined
          ? null
          : {
              parent: shell.parent === null ? null : thread(shell.parent),
              root: thread(shell.root),
            },
      );
    },
    senders: (threadId) =>
      Effect.succeed({
        threads: (senders[threadId] ?? []).map(thread),
        agentSchedule: agentSchedules.includes(threadId),
      }),
    isGuestBot: (botId) => Effect.succeed(botId === guestBot),
  });
  const allowed = new Set<string>([allowedBot, guestBot]);
  const decide = (origin: BotLinkAccess.ThreadOrigins, threadId: string) =>
    BotLinkAccess.originAllows(origin, allowed, thread(threadId));

  it("reads an empty or unset list as no bot", () => {
    assert.equal(BotLinkAccess.parseLinkedEnvironmentBots("").size, 0);
    assert.equal(BotLinkAccess.parseLinkedEnvironmentBots(" , ").size, 0);
    assert.deepEqual([...BotLinkAccess.parseLinkedEnvironmentBots(" b_1 ,b_2,,")].toSorted(), [
      "b_1",
      "b_2",
    ]);
  });

  it.effect("allows a listed bot and refuses an unlisted or guest one", () =>
    Effect.gen(function* () {
      const none = origins({});
      assert.isTrue(yield* decide(none, botThreadId(allowedBot, 2)));
      assert.isFalse(yield* decide(none, botThreadId(deniedBot, 1)));
      assert.isFalse(yield* decide(none, botThreadId(guestBot, 1)));
    }),
  );

  it.effect("judges a subagent or fork by its parent and root", () =>
    Effect.gen(function* () {
      const tree = origins({
        "child-of-denied": { parent: botThreadId(deniedBot, 1), root: botThreadId(deniedBot, 1) },
        "child-of-allowed": {
          parent: botThreadId(allowedBot, 1),
          root: botThreadId(allowedBot, 1),
        },
        "grandchild-via-own": { parent: "own-child", root: "own" },
        "own-child": { parent: "own", root: "own" },
        own: { parent: null, root: "own" },
      });
      assert.isFalse(yield* decide(tree, "child-of-denied"));
      assert.isTrue(yield* decide(tree, "child-of-allowed"));
      assert.isTrue(yield* decide(tree, "grandchild-via-own"));
    }),
  );

  it.effect("refuses a thread an unlisted bot messaged, however far back", () =>
    Effect.gen(function* () {
      const shells = {
        launched: { parent: null, root: "launched" },
        relayed: { parent: null, root: "relayed" },
        "relayed-subagent": { parent: "relayed", root: "relayed" },
      };
      const tree = origins(shells, {
        launched: [botThreadId(deniedBot, 1)],
        relayed: ["launched"],
      });
      assert.isFalse(yield* decide(tree, "launched"));
      assert.isFalse(yield* decide(tree, "relayed"));
      assert.isFalse(yield* decide(tree, "relayed-subagent"));
      const fromAllowed = origins(shells, { launched: [botThreadId(allowedBot, 1)] });
      assert.isTrue(yield* decide(fromAllowed, "launched"));
    }),
  );

  it.effect("refuses an unknown thread, an agent's scheduled task and an unbounded tree", () =>
    Effect.gen(function* () {
      assert.isFalse(yield* decide(origins({}), "missing"));
      assert.isFalse(
        yield* decide(
          origins({ scheduled: { parent: null, root: "scheduled" } }, {}, ["scheduled"]),
          "scheduled",
        ),
      );
      const chain = Object.fromEntries(
        Array.from({ length: 100 }, (_, index) => [
          `t${index}`,
          { parent: index === 0 ? null : `t${index - 1}`, root: "t0" },
        ]),
      );
      assert.isFalse(yield* decide(origins(chain), "t99"));
    }),
  );

  it.effect("ends on threads that messaged each other", () =>
    Effect.gen(function* () {
      const loop = origins(
        { a: { parent: null, root: "a" }, b: { parent: null, root: "b" } },
        { a: ["b"], b: ["a"] },
      );
      assert.isTrue(yield* decide(loop, "a"));
    }),
  );
});

// The real orchestrator toolkits, RemoteDelegation, PeerForwarding and PeerLinkRequests on an
// in-memory database. The Mac's /mcp is a recorder: a call the gate lets through reaches it.

const here = EnvironmentId.make("environment:omarchy");
const mac = EnvironmentId.make("environment:mac");
const instanceId = ProviderInstanceId.make("codex");
const projectId = ProjectId.make("project:link-gate");
const macProjectId = ProjectId.make("project:on-the-mac");
const modelSelection = { instanceId, model: "gpt-5" };
const peerAnswer = "the Mac answered";
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

/** The tools the Mac received, in order. */
class MacCalls extends Context.Service<MacCalls, Ref.Ref<ReadonlyArray<string>>>()(
  "t3/bots/linkAccess.test/MacCalls",
) {}

const layerMac = Layer.unwrap(
  Effect.map(MacCalls, (calls) =>
    Layer.mock(PeerMcpClient.PeerMcpClient)({
      call: (input) =>
        Ref.update(calls, (seen) => [...seen, input.tool]).pipe(
          Effect.andThen(
            Effect.fail(
              new OrchestratorMcpFailure({ code: "orchestration_error", message: peerAnswer }),
            ),
          ),
        ),
    }),
  ),
).pipe(Layer.provideMerge(Layer.effect(MacCalls, Ref.make<ReadonlyArray<string>>([]))));

const layerDatabase = SqlitePersistence.layerMemory;
const layerOrchestration = ThreadManagement.layer.pipe(
  Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
  Layer.provideMerge(
    Layer.merge(
      Layer.mergeAll(
        layerDatabase,
        ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
        ProviderReplayHarness.layerWithRegistry(
          { name: "link-gate" },
          ProviderAdapterRegistry.layerFromAdapters([adapter]),
          { databaseLayer: layerDatabase, runEffectWorker: false },
        ),
      ),
      ServerSettings.layerTest({ linkedEnvironmentsEnabled: true }),
    ),
  ),
);

const layerPeerLinks = Layer.mock(PeerLinks.PeerLinks)({
  enabled: Effect.succeed(true),
  get: () => Effect.succeedNone,
  list: Effect.succeed([]),
});

const layerPeers = Layer.mergeAll(
  RemoteDelegation.layer.pipe(
    Layer.provideMerge(PeerForwarding.layer),
    Layer.provide(
      Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
        resolve: () => Effect.succeed(null),
      }),
    ),
  ),
  PeerLinkRequests.layer,
).pipe(
  Layer.provideMerge(layerMac),
  Layer.provide(layerPeerLinks),
  Layer.provide(
    Layer.mock(ServerEnvironment.ServerEnvironment)({ getEnvironmentId: Effect.succeed(here) }),
  ),
  Layer.provide(BotLinkAccess.layer),
  Layer.provide(
    Layer.mock(GuestStore.GuestStore)({
      guestOfBot: (botId) =>
        Effect.succeed(botId === guestBot ? Option.some(GuestId.make("bia")) : Option.none()),
    }),
  ),
  Layer.provide(
    ConfigProvider.layer(
      ConfigProvider.fromEnv({
        // The guest's bot is listed too: belonging to a guest refuses it anyway.
        env: { [BotLinkAccess.LINKED_ENVIRONMENT_BOTS_ENV]: `${allowedBot}, ${guestBot}` },
      }),
    ),
  ),
);

const layerTools = Layer.mergeAll(
  McpHttpServer.layerOrchestratorToolkit,
  McpHttpServer.layerProjectRegistration,
).pipe(
  Layer.provide(DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(layerPeers),
  Layer.provide(layerPeerLinks),
  Layer.provide(Layer.mock(ThreadLaunch.ThreadLaunchService)({})),
  Layer.provide(NodeCrypto.layer),
  Layer.provide(
    Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
  ),
  Layer.provide(
    Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
      list: () => Effect.succeed([]),
    }),
  ),
  Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
  Layer.provide(Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone })),
  Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
  Layer.provide(Layer.mock(ThreadSearch.ThreadSearch)({})),
  Layer.provide(
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/p" }),
  ),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
  Layer.provide(Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({})),
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-link-gate-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  ),
  Layer.provide(NodeServices.layer),
);

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "link-gate", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "link-gate", version: "1" },
  },
  getClient: Effect.die("unused"),
});

/** A thread here mid-turn, as when its agent calls a tool. `sender` sent its message. */
const seedCaller = (threadId: ThreadId, sender?: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const createdBy = sender === undefined ? ("user" as const) : ("agent" as const);
    const creationSource = sender === undefined ? ("web" as const) : ("mcp" as const);
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId,
      title: threadId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy,
      creationSource,
    });
    const runId = RunId.make(`run:${threadId}`);
    const rootNodeId = NodeId.make(`node:${threadId}`);
    const messageId = MessageId.make(`message:${threadId}`);
    yield* sink.write({
      commandId: CommandId.make(`seed:${threadId}`),
      events: [
        {
          id: EventId.make(`event:message:${threadId}`),
          type: "message.updated",
          threadId,
          occurredAt: now,
          payload: {
            id: messageId,
            threadId,
            runId,
            nodeId: null,
            role: "user",
            text: "Do it on the Mac.",
            attachments: [],
            streaming: false,
            createdBy,
            creationSource,
            ...(sender === undefined ? {} : { senderThreadId: sender }),
            createdAt: now,
            updatedAt: now,
          },
        },
        {
          id: EventId.make(`event:node:${threadId}`),
          type: "node.updated",
          threadId,
          runId,
          nodeId: rootNodeId,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: {
            id: rootNodeId,
            threadId,
            runId,
            parentNodeId: null,
            rootNodeId,
            kind: "root_turn",
            status: "running",
            countsForRun: true,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          },
        },
        {
          id: EventId.make(`event:run:${threadId}`),
          type: "run.updated",
          threadId,
          runId,
          nodeId: rootNodeId,
          providerInstanceId: instanceId,
          occurredAt: now,
          payload: {
            id: runId,
            threadId,
            ordinal: 1,
            providerInstanceId: instanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: messageId,
            rootNodeId,
            activeAttemptId: null,
            status: "running",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
      ],
    });
    // As /mcp sets it with the beta on: the gate must hold whatever the request says.
    const scope: McpInvocationContext.McpInvocationScope = {
      environmentId: here,
      requestNamespace: `provider-session:${threadId}`,
      thread: {
        threadId,
        providerSessionId: `provider-session:${threadId}`,
        providerInstanceId: instanceId,
      },
      client: undefined,
      capabilities: new Set(["orchestration"]),
      issuedAt: 1,
      linkedEnvironments: true,
    };
    return scope;
  });

const call = (
  scope: McpInvocationContext.McpInvocationScope,
  name: string,
  args: Record<string, unknown>,
) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name, arguments: args })),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
  );

const failureOf = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text"
    ? (JSON.parse(text.text) as { readonly code: string; readonly message: string })
    : undefined;
};

const refused = (result: McpSchema.CallToolResult) =>
  failureOf(result)?.message === BotLinkAccess.linkRefused.message;

/** The three ways an agent here starts work on the Mac. */
const reachMac = (scope: McpInvocationContext.McpInvocationScope) =>
  Effect.gen(function* () {
    const launch = yield* call(scope, "t3_thread_launch", {
      environmentId: mac,
      projectId: macProjectId,
      title: "On the Mac",
      modelSelection,
      message: "Run it there.",
    });
    const delegate = yield* call(scope, "delegate_task", {
      task: "Run it on the Mac.",
      target: { environmentId: mac, projectId: macProjectId },
      mode: "async",
    });
    const link = yield* call(scope, "t3_environment_link", {
      hint: "my mac",
      reason: "Run it there.",
    });
    return { launch, delegate, link };
  });

it.layer(Layer.provideMerge(layerTools, layerOrchestration))("reaching the Mac", (it) => {
  it.effect("refuses an unlisted bot, a guest's bot and a thread an unlisted bot started", () =>
    Effect.gen(function* () {
      const macCalls = yield* MacCalls;
      yield* seedCaller(botThreadId(deniedBot, 1));
      const callers = [
        yield* seedCaller(botThreadId(deniedBot, 2)),
        yield* seedCaller(botThreadId(guestBot, 1)),
        yield* seedCaller(ThreadId.make("thread:launched-by-denied"), botThreadId(deniedBot, 1)),
      ];
      yield* Ref.set(macCalls, []);
      for (const scope of callers) {
        const { launch, delegate, link } = yield* reachMac(scope);
        const who = scope.thread?.threadId;
        assert.isTrue(refused(launch), `${who} launch: ${JSON.stringify(launch.content)}`);
        assert.isTrue(refused(delegate), `${who} delegate: ${JSON.stringify(delegate.content)}`);
        assert.isTrue(refused(link), `${who} link: ${JSON.stringify(link.content)}`);
      }
      assert.deepEqual(yield* Ref.get(macCalls), []);
    }),
  );

  it.effect("forwards a listed bot, the user's own thread and a thread a listed bot started", () =>
    Effect.gen(function* () {
      const macCalls = yield* MacCalls;
      yield* seedCaller(botThreadId(allowedBot, 1));
      const callers = [
        yield* seedCaller(botThreadId(allowedBot, 2)),
        yield* seedCaller(ThreadId.make("thread:users-own")),
        yield* seedCaller(ThreadId.make("thread:launched-by-allowed"), botThreadId(allowedBot, 1)),
      ];
      for (const scope of callers) {
        yield* Ref.set(macCalls, []);
        const { launch, delegate, link } = yield* reachMac(scope);
        const who = scope.thread?.threadId;
        assert.equal(failureOf(launch)?.message, peerAnswer, `${who} launch`);
        assert.equal(failureOf(delegate)?.message, peerAnswer, `${who} delegate`);
        assert.equal(
          (link.structuredContent as { readonly status?: string } | undefined)?.status,
          "pending",
          `${who} link: ${JSON.stringify(link.content)}`,
        );
        assert.deepEqual(yield* Ref.get(macCalls), ["t3_thread_launch", "t3_thread_launch"]);
      }
    }),
  );

  it.effect("refuses a follower's read for a refused thread, which carries no request flag", () =>
    Effect.gen(function* () {
      const macCalls = yield* MacCalls;
      const { linkedEnvironments: _flag, ...follower } = yield* seedCaller(
        botThreadId(deniedBot, 3),
      );
      const forwarding = yield* PeerForwarding.PeerForwarding;
      yield* Ref.set(macCalls, []);
      const read = yield* forwarding
        .readThread(follower, mac, { threadId: ThreadId.make("thread:on-the-mac") })
        .pipe(Effect.flip);
      assert.equal(read.message, BotLinkAccess.linkRefused.message);
      assert.deepEqual(yield* Ref.get(macCalls), []);
    }),
  );
});

it.effect("/mcp turns links off for a caller BotLinkAccess refuses, and only for it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const scopeOf = (threadId: ThreadId): McpInvocationContext.McpThreadInvocationScope => ({
        environmentId: here,
        requestNamespace: threadId,
        thread: { threadId, providerSessionId: threadId, providerInstanceId: instanceId },
        client: undefined,
        capabilities: new Set(["orchestration"]),
        issuedAt: 1,
      });
      const tokens: Record<string, McpInvocationContext.McpThreadInvocationScope> = {
        allowedToken: scopeOf(botThreadId(allowedBot, 1)),
        deniedToken: scopeOf(botThreadId(deniedBot, 1)),
      };
      const seen: Array<boolean | undefined> = [];
      const ProbeToolkit = Toolkit.make(
        Tool.make("probe", {
          description: "Reports whether the caller may use links.",
          success: Schema.Struct({ ok: Schema.Boolean }),
          failure: OrchestratorMcpFailure,
          failureMode: "return",
          dependencies: [McpInvocationContext.McpInvocationContext],
        }),
      );
      const serverLayer = McpHttpServer.toolkitRegistration(
        ProbeToolkit,
        McpToolAccess.toLayer(ProbeToolkit, {
          probe: McpToolAccess.reads(() =>
            McpInvocationContext.McpInvocationContext.pipe(
              Effect.tap((scope) => Effect.sync(() => seen.push(scope.linkedEnvironments))),
              Effect.as({ ok: true }),
            ),
          ),
        }),
      ).pipe(
        Layer.provideMerge(
          McpHttpServer.layerMcpTransport.pipe(
            Layer.provide(ServerSettings.layerTest({ linkedEnvironmentsEnabled: true })),
          ),
        ),
        Layer.provide(
          Layer.mock(McpSessionRegistry.McpSessionRegistry)({
            resolve: (token) => Effect.succeed(tokens[token]),
          }),
        ),
        Layer.provide(
          Layer.succeed(
            BotLinkAccess.BotLinkAccess,
            BotLinkAccess.BotLinkAccess.of({
              allows: Effect.fn("test.allows")((scope) =>
                Effect.succeed(scope.thread?.threadId === botThreadId(allowedBot, 1)),
              ),
            }),
          ),
        ),
      );
      yield* HttpRouter.serve(serverLayer, { disableListenLog: true, disableLogger: true }).pipe(
        Layer.build,
      );
      const httpClient = yield* HttpClient.HttpClient;
      const probe = (token: string) =>
        Effect.gen(function* () {
          const headers = {
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${token}`,
          };
          const initialize = yield* httpClient.post("/mcp", {
            headers,
            body: HttpBody.text(
              `{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"1.0.0"}}}`,
              "application/json",
            ),
          });
          return yield* httpClient.post("/mcp", {
            headers: {
              ...headers,
              "mcp-session-id": initialize.headers["mcp-session-id"]!,
              "mcp-protocol-version": "2025-06-18",
            },
            body: HttpBody.text(
              `{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"probe","arguments":{}}}`,
              "application/json",
            ),
          });
        });

      assert.equal((yield* probe("allowedToken")).status, 200);
      assert.equal((yield* probe("deniedToken")).status, 200);
      assert.deepEqual(seen, [true, false]);
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
