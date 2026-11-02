import { ServerEnvironment } from "../../../environment/ServerEnvironment.ts";
import { expect, it } from "@effect/vitest";
import {
  BotId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  WorkflowId,
  WorkflowNodeId,
  WorkflowDocRevision,
  type WorkflowDefinition,
  WorkflowRunId,
  WorkflowRunView,
  WorkflowsError,
  MessageId,
  RunId,
  ScheduledTaskId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as BotsService from "../../BotsService.ts";
import * as Definitions from "../definitions/WorkflowDefinitions.ts";
import * as Invocation from "../../../mcp/McpInvocationContext.ts";
import * as Access from "../../../mcp/McpToolAccess.ts";
import { liveThreadsLayer } from "../../../mcp/McpToolAccess.testkit.ts";
import { WorkflowToolkit } from "./tools.ts";
import { layerOver } from "./handlers.ts";

import { WorkflowEngine } from "../WorkflowEngine.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";

const decodeView = Schema.decodeSync(WorkflowRunView);
const conflictDocument = {
  workflowId: WorkflowId.make("example"),
  source: "current",
  revision: WorkflowDocRevision.make("a".repeat(40)),
  headCommit: null,
  definition: null,
  hash: null,
  valid: false,
  dirty: true,
  diagnostics: [],
  enabled: false,
  suspended: false,
  triggers: [],
  updatedBy: null,
  updatedAt: null,
};
const summary = {
  workflowId: WorkflowId.make("example"),
  title: "Example",
  description: null,
  path: "example.yaml",
  valid: true,
  dirty: false,
  enabled: true,
  suspended: false,
  diagnostics: 0,
  triggers: [],
  headCommit: null,
  revision: null,
  updatedAt: null,
  lastRun: null,
};

const setup = Effect.fn("WorkflowHandlersTest.setup")(function* (
  thread: string,
  isBot = true,
  canManageBots = false,
  message?: OrchestrationV2ConversationMessage,
  readFails = false,
  hasEntry = true,
  documentTriggers: WorkflowDefinition["triggers"] = {},
) {
  const calls = yield* Ref.make<ReadonlyArray<unknown>>([]);
  const record = (value: unknown) => Ref.update(calls, (values) => [...values, value]);
  const scope: Invocation.McpInvocationScope = {
    environmentId: EnvironmentId.make("test"),
    requestNamespace: "test",
    thread: {
      threadId: ThreadId.make(thread),
      providerSessionId: "test",
      providerInstanceId: ProviderInstanceId.make("codex"),
    },
    client: undefined,
    capabilities: new Set(),
    issuedAt: 0,
  };
  const dependencies = Layer.mergeAll(
    Layer.mock(ServerEnvironment)({ getEnvironmentId: Effect.succeed(EnvironmentId.make("test")) }),
    Layer.mock(WorkflowEngine)({
      start: (request) =>
        record(request).pipe(Effect.as({ runId: WorkflowRunId.make("wfr_0123456789abcdef0123") })),
      runView: () =>
        Effect.succeed(
          decodeView({
            summary: {
              runId: "wfr_0123456789abcdef0123",
              workflowId: "example",
              title: "Example",
              status: "queued",
              hash: null,
              commit: null,
              pausedFor: null,
              skipReason: null,
              trigger: { id: "bot", kind: "bot", label: "Test" },
              startedAt: "2026-01-01T00:00:00.000Z",
              endedAt: null,
              outputStatus: null,
              stepsUsed: 0,
              reservedTokens: 0,
              openGates: 0,
              pullRequest: null,
              activeMs: null,
              activeSince: null,
              cost: {
                billable: 0,
                input: 0,
                output: 0,
                cacheRead: 0,
                usage: "unavailable",
                usdEstimate: null,
              },
            },
            trigger: {
              id: "bot",
              kind: "bot",
              label: "Test",
              occurrence: "bot:test:1",
              test: false,
              payloadBytes: 4,
            },
            definition: null,
            seq: 0,
            nextStepsCursor: null,
            blocks: [],
            steps: [],
            gates: [],
          }),
        ),
      gateDecide: () => Effect.die("MCP must not decide gates"),
    }),
    liveThreadsLayer,
    NodeCrypto.layer,
    Layer.succeed(Invocation.McpInvocationContext, scope),
    Layer.mock(BotsService.BotsService)({
      botForThread: () =>
        record("botForThread").pipe(
          Effect.as(
            isBot
              ? Option.some({
                  id: BotId.make("b_test"),
                  name: "Test",
                  role: "",
                  model: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
                  homeGeneration: 1,
                  sectionId: null,
                  position: 0,
                  canManageBots,
                  rotation: "daily" as const,
                  createdAt: "2026-01-01T00:00:00.000Z",
                  updatedAt: "2026-01-01T00:00:00.000Z",
                })
              : Option.none(),
          ),
        ),
    }),
    Layer.mock(Definitions.WorkflowDefinitions)({
      repoPath: "/home/user/.t3/workflows/definitions",
      botEntries: () =>
        Effect.succeed(
          hasEntry
            ? [
                {
                  workflowId: WorkflowId.make("example"),
                  triggerId: "assistant",
                  description: "Run",
                  params: { count: { type: "number", default: 1 } },
                  on: true,
                },
              ]
            : [],
        ),
      document: () =>
        Effect.succeed({
          ...conflictDocument,
          definition: {
            schema: "t3.workflow/v1" as const,
            id: "example",
            title: "Example",
            home: { project: "app" },
            budget: { steps: 1, wall: "1h", tokens: 1 },
            fatigue: { consecutiveFailures: 1 },
            triggers: documentTriggers,
            nodes: {},
            edges: [],
          },
        }),
      list: Effect.succeed([summary, { ...summary, workflowId: WorkflowId.make("other") }]),
      validate: () =>
        record("validate").pipe(
          Effect.as({ diagnostics: [], normalizedSource: null, semanticHash: null }),
        ),
      save: (_input, author) =>
        record(author).pipe(
          Effect.as({
            _tag: "Conflict" as const,
            workflowId: WorkflowId.make("example"),
            base: null,
            current: conflictDocument,
          }),
        ),
      setEnabled: (input, author) =>
        author.kind === "user" || author.canManageBots
          ? record({ setEnabled: input.triggerId ?? null }).pipe(Effect.as(summary))
          : Effect.fail(new WorkflowsError({ code: "permission", message: "Denied" })),
    }),
  );
  // Only the turn lookup is read; the run stands in for the projected one.
  const turnRun = { id: RunId.make("run-test") } as OrchestrationV2Run;
  const projections = yield* ProjectionStore.ProjectionStoreV2.pipe(
    Effect.provide(
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getRunningTurnContext: () =>
          readFails
            ? Effect.fail(
                new ProjectionStore.ProjectionStoreReadError({ threadId: ThreadId.make(thread) }),
              )
            : Effect.succeed({ run: turnRun, providerThread: undefined, providerTurn: undefined }),
        getRunMessage: () => Effect.succeed(message),
      }),
    ),
  );
  const toolkit = yield* WorkflowToolkit.pipe(
    Effect.provide(
      Access.HandlersLayer.layer(layerOver(projections)).pipe(Layer.provide(dependencies)),
    ),
  );
  const run = <A extends { readonly result: unknown }, E, R, E2, R2>(
    handled: Effect.Effect<Stream.Stream<A, E, R>, E2, R2>,
  ) =>
    handled.pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.provide(dependencies),
      Effect.map((results) => results.at(-1)?.result),
    );
  return {
    calls,
    save: (dryRun = false) =>
      run(toolkit.handle("workflow_save", { source: "source", message: "Save", dryRun })),
    run: (params = {}) =>
      run(
        toolkit.handle("workflow_run", {
          workflowId: WorkflowId.make("example"),
          clientRequestId: "test-run",
          params,
        }),
      ),
    cancel: () =>
      run(
        toolkit.handle("workflow_run_cancel", {
          runId: WorkflowRunId.make("wfr_0123456789abcdef0123"),
        }),
      ),
    enable: (triggerId?: string) =>
      run(
        toolkit.handle("workflow_set_enabled", {
          workflowId: WorkflowId.make("example"),
          enabled: true,
          ...(triggerId === undefined ? {} : { triggerId: WorkflowNodeId.make(triggerId) }),
        }),
      ),
    list: () => run(toolkit.handle("workflow_list", {})),
  };
});
it.effect("rejects workflow steps before consulting services", () =>
  Effect.gen(function* () {
    const t = yield* setup("wf:wfr_0123456789abcdef0123:0123456789abcdef");
    for (const call of [t.save, t.run, t.cancel])
      expect(yield* call()).toMatchObject({ code: "capability_denied" });
    expect(yield* Ref.get(t.calls)).toEqual([]);
  }),
);
it.effect("rejects non-bot threads", () =>
  Effect.gen(function* () {
    const t = yield* setup("regular", false);
    expect(yield* t.save()).toMatchObject({ code: "capability_denied" });
  }),
);
it.effect("validates dry runs without saving", () =>
  Effect.gen(function* () {
    const t = yield* setup("bot:test:1");
    expect(yield* t.save(true)).toEqual({ ok: true, diagnostics: [] });
    expect(yield* Ref.get(t.calls)).toEqual(["botForThread", "validate"]);
  }),
);
it.effect("preserves author permissions and returns conflicts", () =>
  Effect.gen(function* () {
    const t = yield* setup("bot:test:1");
    expect(yield* t.save()).toMatchObject({
      ok: false,
      conflict: { source: "current", revision: "a".repeat(40) },
    });
    expect(yield* Ref.get(t.calls)).toEqual([
      "botForThread",
      { kind: "bot", name: "Test", canManageBots: false },
    ]);
    expect(yield* t.enable()).toMatchObject({ code: "capability_denied" });
  }),
);

it.effect("starts bot runs with their occurrence and refuses unprivileged mutations", () =>
  Effect.gen(function* () {
    const allowed = yield* setup("bot:test:1", true, true);
    expect(yield* allowed.run()).toMatchObject({
      status: "queued",
      link: "/workflows/test/runs/wfr_0123456789abcdef0123",
    });
    expect(yield* Ref.get(allowed.calls)).toEqual([
      "botForThread",
      {
        workflowId: "example",
        triggerId: "assistant",
        kind: "bot",
        occurrence: "bot:b_test:test-run",
        label: "Run by Test (bot)",
        params: { count: 1 },
        payload: { bot: { id: "b_test", name: "Test" }, threadId: "bot:test:1" },
        causalDepth: 0,
        parent: null,
      },
    ]);
    const denied = yield* setup("bot:test:1");
    expect(yield* denied.run()).toMatchObject({ code: "capability_denied" });
    expect(yield* denied.cancel()).toMatchObject({ code: "capability_denied" });
    expect(yield* Ref.get(denied.calls)).toEqual(["botForThread", "botForThread"]);
  }),
);

const ownerMessage: OrchestrationV2ConversationMessage = {
  id: MessageId.make("message-test"),
  threadId: ThreadId.make("bot:test:1"),
  runId: RunId.make("run-test"),
  nodeId: null,
  role: "user",
  text: "Run it",
  createdBy: "user",
  creationSource: "web",
  attachments: [],
  streaming: false,
  createdAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
  updatedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
};
it.effect("allows owner turns to run and enable workflows", () =>
  Effect.gen(function* () {
    const t = yield* setup("bot:test:1", true, false, ownerMessage);
    expect(yield* t.run()).toMatchObject({ status: "queued" });
    expect(yield* t.enable()).toEqual({ enabled: true });
    yield* t.save();
    expect((yield* Ref.get(t.calls)).at(-1)).toEqual({
      kind: "bot",
      name: "Test",
      canManageBots: true,
    });
  }),
);
it.effect("refuses relayed scheduled server and unreadable turns", () =>
  Effect.gen(function* () {
    for (const message of [
      { ...ownerMessage, senderThreadId: ThreadId.make("bot:other:1") },
      { ...ownerMessage, scheduledTaskId: ScheduledTaskId.make("scheduled-test") },
      { ...ownerMessage, creationSource: "server" as const },
    ]) {
      const t = yield* setup("bot:test:1", true, false, message);
      expect(yield* t.run()).toMatchObject({ code: "capability_denied" });
    }
    const t = yield* setup("bot:test:1", true, false, ownerMessage, true);
    expect(yield* t.run()).toMatchObject({ code: "capability_denied" });
  }),
);

it.effect("rejects missing bot triggers and invalid parameters", () =>
  Effect.gen(function* () {
    const invalid = yield* setup("bot:test:1", true, true);
    expect(yield* invalid.run({ count: "wrong" })).toMatchObject({
      code: "invalid_request",
      message: "count: expected number",
    });
    // A manager bot is still refused: without a bot trigger no bot runs the workflow.
    const none = yield* setup("bot:test:1", true, true, undefined, false, false, {
      run: { kind: "manual" },
    });
    expect(yield* none.run()).toMatchObject({
      code: "capability_denied",
      message: expect.stringContaining("has no bot trigger"),
    });
    const other = yield* setup("bot:test:1", true, true, undefined, false, false, {
      ask: { kind: "bot", description: "Ask", bots: ["b_other"] },
    });
    expect(yield* other.run()).toMatchObject({
      code: "capability_denied",
      message: expect.stringContaining("does not allow this bot"),
    });
  }),
);

it.effect("lists a bot entry only for runnable workflows and forwards trigger switches", () =>
  Effect.gen(function* () {
    const t = yield* setup("bot:test:1", true, true);
    const listed = yield* t.list();
    expect(listed).toMatchObject({
      workflows: [
        {
          id: "example",
          bot: {
            trigger: "assistant",
            description: "Run",
            on: true,
            params: { count: { type: "number", default: 1, required: false } },
          },
        },
        { id: "other", bot: null },
      ],
    });
    expect(yield* t.enable("push")).toEqual({ enabled: true });
    expect((yield* Ref.get(t.calls)).at(-1)).toEqual({ setEnabled: "push" });
  }),
);
