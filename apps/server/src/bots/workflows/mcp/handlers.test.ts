import { expect, it } from "@effect/vitest";
import {
  BotId,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  WorkflowId,
  WorkflowDocRevision,
  WorkflowRunId,
  WorkflowsError,
} from "@t3tools/contracts";
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
import { layer } from "./handlers.ts";

const setup = Effect.fn("WorkflowHandlersTest.setup")(function* (thread: string, isBot = true) {
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
                  canManageBots: false,
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
            current: {
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
              updatedBy: null,
              updatedAt: null,
            },
          }),
        ),
      setEnabled: () => Effect.fail(new WorkflowsError({ code: "permission", message: "Denied" })),
    }),
  );
  const toolkit = yield* WorkflowToolkit.pipe(
    Effect.provide(Access.HandlersLayer.layer(layer).pipe(Layer.provide(dependencies))),
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
    run: () => run(toolkit.handle("workflow_run", { workflowId: WorkflowId.make("example") })),
    cancel: () =>
      run(
        toolkit.handle("workflow_run_cancel", {
          runId: WorkflowRunId.make("wfr_0123456789abcdef0123"),
        }),
      ),
    enable: () =>
      run(
        toolkit.handle("workflow_set_enabled", {
          workflowId: WorkflowId.make("example"),
          enabled: true,
        }),
      ),
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
