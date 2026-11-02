/**
 * Agent steps as ordinary T3 threads on the bots' provider instances. Launch and send carry a
 * `commandId` and a `messageId` derived from the run and the intent key, so a replay after a crash
 * gets upstream's receipt back; the observed run is the one whose user message is ours.
 */
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import {
  CommandId,
  type ModelSelection,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  type WorkflowModelRef,
} from "@t3tools/contracts";
import { subagentResultForRun } from "@t3tools/provider-core/server/subagentProjection";

import { ProjectService } from "../../../project/ProjectService.ts";
import { ProviderInstanceRegistry } from "../../../provider/ProviderInstanceRegistry.ts";
import { ThreadLaunchService } from "../../../orchestration-v2/ThreadLaunchService.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { type Intent, type NewFact, runStream } from "../facts.ts";
import { WorkflowGit } from "../git/Workspaces.ts";
import { commandIdFor, messageIdFor } from "../ids.ts";
import { projectByRef } from "./projects.ts";
import { type RequestItem, requestResponse, requestText } from "./requests.ts";
import { lastJsonBlock, stepRuns, turnCost } from "./turnResult.ts";

type StartTurn = Extract<Intent, { readonly _tag: "StartTurn" }>;
type AnswerRequest = Extract<Intent, { readonly _tag: "AnswerRequest" }>;

export class WorkflowTurnError extends Data.TaggedError("WorkflowTurnError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Prefixed to every step prompt: the bots' rules, which the engine's gates do not enforce. */
const STEP_RULES = [
  "You are one step of a T3 workflow running unattended on the bots host.",
  "Never deploy, restart services, merge into friend/main, force push, or edit ~/.t3/userdata/settings.json;",
  "if the task needs one of these, stop and say so in your reply.",
  "Run heavy commands (typecheck, tests, builds, installs) through /home/israel/.cache/t3-testdata/heavy.sh, one at a time.",
].join(" ");

const TERMINAL: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "rolled_back",
]);
/** How long one wait lasts before the observer reports pending runtime requests again. */
const WAIT_CHUNK_MS = 15_000;
/** The start recorded the thread after its message was accepted, so our run shows up quickly. */
const FIND_RUN_TRIES = 30;

export interface WorkflowTurnsOptions {
  /** The instance each workflow provider runs on; default: the first enabled instance of its driver. */
  readonly instances?: {
    readonly claude?: string | undefined;
    readonly codex?: string | undefined;
  };
}

export class WorkflowTurns extends Context.Service<
  WorkflowTurns,
  {
    /** Launches the step's thread (`new`) or queues a follow-up (`continue`); returns the thread. */
    readonly start: (runId: string, intent: StartTurn) => Effect.Effect<string, WorkflowTurnError>;
    /** Pending runtime requests while the turn runs, then its TurnSettled. */
    readonly observe: (
      runId: string,
      intent: StartTurn,
    ) => Stream.Stream<NewFact, WorkflowTurnError>;
    /** Interrupts the thread's active run; a thread that does not exist has nothing to stop. */
    readonly interrupt: (
      runId: string,
      key: string,
      threadId: string,
    ) => Effect.Effect<void, WorkflowTurnError>;
    readonly answer: (
      runId: string,
      intent: AnswerRequest,
    ) => Effect.Effect<void, WorkflowTurnError>;
  }
>()("t3/bots/workflows/exec/Turns/WorkflowTurns") {}

/** The turn item that carries a request's questions or approval details. */
const requestItem = (
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  requestId: string,
): RequestItem | undefined =>
  items.find(
    (
      item,
    ): item is Extract<
      OrchestrationV2TurnItem,
      { readonly type: "user_input_request" | "approval_request" }
    > =>
      (item.type === "user_input_request" || item.type === "approval_request") &&
      item.requestId === requestId,
  );

const settledStatus = (status: OrchestrationV2Run["status"]) =>
  status === "completed" || status === "cancelled" || status === "interrupted"
    ? status
    : ("failed" as const);

export const make = Effect.fn("WorkflowTurns.make")(function* (options: WorkflowTurnsOptions) {
  const launches = yield* ThreadLaunchService;
  const threads = yield* ThreadManagementService;
  const projects = yield* ProjectService;
  const registry = yield* ProviderInstanceRegistry;
  const git = yield* WorkflowGit;

  const fail = (message: string) => (cause: unknown) => new WorkflowTurnError({ message, cause });
  const projection = (threadId: string) =>
    threads
      .getThreadProjection(ThreadId.make(threadId))
      .pipe(Effect.mapError(fail("Could not read the step thread.")));

  const project = Effect.fn("WorkflowTurns.project")(function* (ref: string) {
    const snapshot = yield* projects.snapshot.pipe(
      Effect.mapError(fail("Could not list projects.")),
    );
    const found = projectByRef(snapshot.projects, ref);
    if (found === undefined) {
      return yield* new WorkflowTurnError({ message: `There is no project "${ref}".` });
    }
    return found;
  });

  const modelSelection = Effect.fn("WorkflowTurns.modelSelection")(function* (
    ref: WorkflowModelRef,
  ) {
    let instanceId = options.instances?.[ref.provider];
    if (instanceId === undefined) {
      const driver = ref.provider === "claude" ? "claudeAgent" : "codex";
      const instances = yield* registry.listInstances;
      instanceId = instances.find((i) => i.enabled && i.driverKind === driver)?.instanceId;
    }
    if (instanceId === undefined) {
      return yield* new WorkflowTurnError({
        message: `No enabled provider instance runs ${ref.provider}.`,
      });
    }
    const selection: ModelSelection = {
      instanceId: ProviderInstanceId.make(instanceId),
      model: ref.model,
      ...(ref.effort === undefined
        ? {}
        : {
            options: [
              { id: ref.provider === "codex" ? "reasoningEffort" : "effort", value: ref.effort },
            ],
          }),
    };
    return selection;
  });

  /** Our run: the one whose user message is the id this intent sent. */
  const ourRun = Effect.fn("WorkflowTurns.ourRun")(function* (runId: string, intent: StartTurn) {
    const messageId = messageIdFor(runId, intent.key);
    const run = (yield* projection(intent.threadId)).runs.find(
      (r) => r.userMessageId === messageId,
    );
    if (run === undefined) {
      return yield* new WorkflowTurnError({
        message: "The step thread has no run for its message.",
      });
    }
    return run;
  });

  const settledFact = Effect.fn("WorkflowTurns.settledFact")(function* (
    runId: string,
    intent: StartTurn,
    run: OrchestrationV2Run,
    resultRun: OrchestrationV2Run,
  ) {
    const thread = yield* projection(intent.threadId);
    const { text } = subagentResultForRun(thread, resultRun);
    const { output, error } = lastJsonBlock(text);
    const headSha = yield* git.head(intent.workspace.path).pipe(Effect.option);
    const nudge = intent.key.startsWith("nudge:");
    const fact: NewFact = {
      stream: runStream(runId),
      key: `settled:${intent.step}@${intent.attempt}${nudge ? ":nudge" : ""}`,
      fact: {
        _tag: "TurnSettled",
        step: intent.step,
        attempt: intent.attempt,
        // The reply consumed is the result run's, so its status is the turn's.
        status: settledStatus(resultRun.status),
        text: text.slice(0, 16_384),
        output,
        outputError: error,
        cost: turnCost(
          stepRuns(thread.runs, run, resultRun),
          thread.attempts,
          thread.providerTurns,
        ),
        headSha: headSha._tag === "Some" ? headSha.value : null,
      },
    };
    return fact;
  });

  /** The thread never got a run for our message: the turn cannot settle, so it failed. */
  const lostFact = (runId: string, intent: StartTurn): NewFact => ({
    stream: runStream(runId),
    key: `settled:${intent.step}@${intent.attempt}${intent.key.startsWith("nudge:") ? ":nudge" : ""}`,
    fact: {
      _tag: "TurnSettled",
      step: intent.step,
      attempt: intent.attempt,
      status: "failed",
      text: "The step thread has no run for the workflow's message.",
      output: null,
      outputError: null,
      cost: {
        billable: 0,
        input: 0,
        output: 0,
        cacheRead: 0,
        usage: "unavailable",
        usdEstimate: null,
      },
      headSha: null,
    },
  });

  const pendingRequests = Effect.fn("WorkflowTurns.pendingRequests")(function* (
    runId: string,
    intent: StartTurn,
  ) {
    const thread = yield* projection(intent.threadId);
    return thread.runtimeRequests
      .filter((request) => request.status === "pending")
      .map((request): NewFact => ({
        stream: runStream(runId),
        key: `request:${request.id}`,
        fact: {
          _tag: "RuntimeRequest",
          step: intent.step,
          attempt: intent.attempt,
          threadId: intent.threadId,
          requestId: request.id,
          requestKind: request.kind,
          text: requestText(request.kind, requestItem(thread.turnItems, request.id)),
        },
      }));
  });

  const observe = (runId: string, intent: StartTurn): Stream.Stream<NewFact, WorkflowTurnError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const found = yield* ourRun(runId, intent).pipe(
          Effect.retry({ schedule: Schedule.spaced("1 second"), times: FIND_RUN_TRIES }),
          Effect.option,
        );
        if (found._tag === "None") return Stream.make(lostFact(runId, intent));
        const run = found.value;
        const projectId = (yield* projection(intent.threadId)).thread.projectId;
        // Waits in chunks; between chunks it reports the requests the agent is waiting on.
        const chunk: Stream.Stream<NewFact, WorkflowTurnError> = Stream.unwrap(
          Effect.gen(function* () {
            const waited = yield* threads
              .waitForThread({
                projectId,
                threadId: ThreadId.make(intent.threadId),
                runId: run.id,
                timeoutMs: WAIT_CHUNK_MS,
                untilDelegatedWorkSettled: true,
              })
              .pipe(Effect.mapError(fail("Could not wait for the step thread.")));
            const ended = waited.run;
            if (!waited.timedOut && ended !== null && TERMINAL.has(ended.status)) {
              return Stream.fromEffect(settledFact(runId, intent, run, waited.resultRun ?? ended));
            }
            return Stream.concat(
              Stream.fromIterable(yield* pendingRequests(runId, intent)),
              Stream.suspend(() => chunk),
            );
          }),
        );
        return chunk;
      }),
    );

  return WorkflowTurns.of({
    start: Effect.fn("WorkflowTurns.start")(function* (runId: string, intent: StartTurn) {
      const text = `${STEP_RULES}\n\n${intent.prompt}`;
      const commandId = commandIdFor(runId, intent.key);
      const messageId = messageIdFor(runId, intent.key);
      if (intent.mode === "continue") {
        const thread = yield* projection(intent.threadId);
        yield* threads
          .sendToThread({
            projectId: thread.thread.projectId,
            commandId,
            threadId: ThreadId.make(intent.threadId),
            messageId,
            text,
            attachments: [],
            mode: "queue",
            createdBy: "system",
            creationSource: "server",
          })
          .pipe(Effect.mapError(fail("Could not send to the step thread.")));
        return intent.threadId;
      }
      const target = yield* project(intent.projectRef);
      const launched = yield* launches
        .launch({
          commandId,
          threadId: ThreadId.make(intent.threadId),
          projectId: target.id,
          title: intent.title,
          generateTitle: false,
          modelSelection: yield* modelSelection(intent.model),
          runtimeMode: "full-access",
          interactionMode: "default",
          workspaceStrategy: { type: "existing_worktree", worktreePath: intent.workspace.path },
          initialMessage: { messageId, text, attachments: [] },
          createdBy: "system",
          creationSource: "server",
        })
        .pipe(Effect.mapError(fail("Could not launch the step thread.")));
      return launched.threadId;
    }),
    observe,
    interrupt: Effect.fn("WorkflowTurns.interrupt")(function* (
      runId: string,
      key: string,
      threadId: string,
    ) {
      const thread = yield* threads
        .getThreadProjection(ThreadId.make(threadId))
        .pipe(Effect.option);
      if (thread._tag === "None") return;
      yield* threads
        .interruptThread({
          projectId: thread.value.thread.projectId,
          commandId: commandIdFor(runId, key),
          threadId: ThreadId.make(threadId),
          reason: "The workflow stopped this step.",
        })
        .pipe(Effect.mapError(fail("Could not interrupt the step thread.")));
    }),
    answer: Effect.fn("WorkflowTurns.answer")(function* (runId: string, intent: AnswerRequest) {
      const thread = yield* projection(intent.threadId);
      const response = requestResponse(
        requestItem(thread.turnItems, intent.requestId),
        intent.answer,
      );
      if (Result.isFailure(response)) {
        return yield* new WorkflowTurnError({ message: response.failure });
      }
      yield* threads
        .dispatch({
          type: "runtime-request.respond",
          commandId: CommandId.make(commandIdFor(runId, intent.key)),
          threadId: ThreadId.make(intent.threadId),
          requestId: RuntimeRequestId.make(intent.requestId),
          ...response.success,
        })
        .pipe(Effect.mapError(fail("Could not answer the step's request.")));
    }),
  });
});

export const layer = (options: WorkflowTurnsOptions) => Layer.effect(WorkflowTurns, make(options));
