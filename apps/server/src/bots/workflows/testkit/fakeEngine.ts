/**
 * An in-memory catalog and a fake interpreter for engine tests. The fake behaves like the real
 * upstream receipts: executing the same intent key twice returns the same thread, unit or worktree,
 * and it counts how often each key ran so tests can assert "one thread per key".
 */
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Json } from "effect/Schema";
import * as Stream from "effect/Stream";

import type { CompiledWorkflow } from "@t3tools/shared/workflows";

import { WorkflowCatalog } from "../Catalog.ts";
import { type Intent, type NewFact, type RunFact, runStream } from "../facts.ts";
import { WorkflowInterpreter } from "../Interpreter.ts";
import { cost } from "./decideHarness.ts";

/** Every workflow is enabled at commit "c1". */
export const layerCatalog = (workflows: ReadonlyArray<CompiledWorkflow>, enabled = true) =>
  Layer.succeed(
    WorkflowCatalog,
    WorkflowCatalog.of({
      current: Effect.fn("WorkflowCatalog.current")(function* (workflowId: string) {
        const compiled = yield* Effect.sync(() =>
          workflows.find((w) => w.definition.id === workflowId),
        );
        return compiled === undefined
          ? { _tag: "Missing" as const }
          : {
              _tag: "Ready" as const,
              version: { workflowId, commit: "c1", compiled },
              enabled,
              suspended: false,
              off: new Set<string>(),
            };
      }),
      pinned: Effect.fn("WorkflowCatalog.pinned")(function* (workflowId: string, commit: string) {
        const compiled = workflows.find((w) => w.definition.id === workflowId);
        if (compiled === undefined) return yield* Effect.die(`no workflow ${workflowId}`);
        return { workflowId, commit, compiled };
      }),
      failureSubscribers: Effect.fn("WorkflowCatalog.failureSubscribers")(function* () {
        return yield* Effect.succeed([]);
      }),
    }),
  );

export interface TurnScript {
  readonly status?: "completed" | "failed" | "cancelled" | "interrupted";
  readonly output?: Json;
  readonly outputError?: string | null;
}
export interface UnitScript {
  readonly exit?: number;
  readonly out?: Json;
  readonly tail?: string;
}

export interface FakeInterpreter {
  /** How often `execute` ran per intent key. */
  readonly executions: Map<string, number>;
  /** Distinct threads created, by the intent key that created them (the upstream launch receipt). */
  readonly threads: Map<string, string>;
  /** Distinct units created, by intent key. */
  readonly units: Map<string, string>;
  /** Observations wait on these until released; `hold(key)` before the run reaches the step. */
  readonly hold: (key: string) => Effect.Effect<void>;
  readonly release: (key: string) => Effect.Effect<void>;
  /** Executions of these keys never return (a crash between recording and executing). */
  readonly stall: Set<string>;
  /** Start intents the engine abandoned because the run ended first. */
  readonly abandoned: Set<string>;
  /** Executions of these keys fail with a retryable IntentFailed. */
  readonly failRetryable: Set<string>;
  /**
   * Messages posted to bot threads, by command id, like the orchestrator's receipts: a replayed
   * post finds its receipt and adds nothing. `missingBots` posts nothing.
   */
  readonly posts: Map<string, { readonly botId: string; readonly report: string }>;
  readonly missingBots: Set<string>;
  /** Thread ↔ card links, as `<ticketId> <threadId>`, each once like the kanban's table. */
  readonly links: Set<string>;
  /** Worktrees prepared, by workspace name, with how they were asked for. */
  readonly workspaces: Map<string, Extract<Intent, { readonly _tag: "PrepareWorkspace" }>>;
}

/**
 * `turns`/`units` script each step by its step key (default: a completed turn with null output,
 * an exit 0 unit). Returns the fake's handle and its layer.
 */
export const makeFakeInterpreter = Effect.fn("makeFakeInterpreter")(function* (options: {
  readonly turns?: Readonly<Record<string, TurnScript>>;
  readonly units?: Readonly<Record<string, UnitScript>>;
  /** The kanban board `ReadTicket` reads, by id; identifiers match case-insensitively. */
  readonly tickets?: ReadonlyArray<{
    readonly id: string;
    readonly identifier: string;
    readonly title: string;
  }>;
}) {
  const executions = yield* Effect.sync(() => new Map<string, number>());
  const threads = new Map<string, string>();
  const units = new Map<string, string>();
  const holds = new Map<string, Deferred.Deferred<void>>();
  const stall = new Set<string>();
  const abandoned = new Set<string>();
  const failRetryable = new Set<string>();
  const posts = new Map<string, { readonly botId: string; readonly report: string }>();
  const missingBots = new Set<string>();
  const links = new Set<string>();
  const workspaces = new Map<string, Extract<Intent, { readonly _tag: "PrepareWorkspace" }>>();
  const at = Clock.currentTimeMillis.pipe(
    Effect.map((millis) => DateTime.formatIso(DateTime.makeUnsafe(millis))),
  );
  const result = (runId: string, intent: Intent, fact: RunFact): NewFact => ({
    stream: runStream(runId),
    key: `result:${intent.key}`,
    fact,
  });

  const execute = (runId: string, intent: Intent): Effect.Effect<ReadonlyArray<NewFact>> =>
    Effect.gen(function* () {
      executions.set(intent.key, (executions.get(intent.key) ?? 0) + 1);
      if (stall.has(intent.key)) return yield* Effect.never;
      if (failRetryable.has(intent.key)) {
        return [
          result(runId, intent, { _tag: "IntentFailed", error: "try again", retryable: true }),
        ];
      }
      switch (intent._tag) {
        case "StartTurn": {
          const threadId = threads.get(intent.key) ?? intent.threadId;
          threads.set(intent.key, threadId);
          return [result(runId, intent, { _tag: "TurnStarted", threadId })];
        }
        case "StartUnit": {
          const unit = units.get(intent.key) ?? `wf-${units.size + 1}`;
          units.set(intent.key, unit);
          return [result(runId, intent, { _tag: "UnitSpawned", unit, at: yield* at })];
        }
        case "PrepareWorkspace":
          workspaces.set(intent.name, intent);
          return [
            result(runId, intent, {
              _tag: "WorkspaceReady",
              name: intent.name,
              path: `/runs/${runId}/${intent.name}`,
              branch: intent.branch,
              headSha: "base0",
            }),
          ];
        case "OpenGate":
          return [
            result(runId, intent, { _tag: "GateOpened", gateKey: intent.gateKey, at: yield* at }),
          ];
        case "Notify":
          return [result(runId, intent, { _tag: "Notified" })];
        case "UpsertCard":
          return [result(runId, intent, { _tag: "CardUpserted" })];
        case "AnswerRequest":
          return [result(runId, intent, { _tag: "Answered" })];
        case "Interrupt":
          yield* Deferred.succeed(holdFor(intent.step), undefined);
          return [result(runId, intent, { _tag: "Interrupted" })];
        case "GitOp":
          return [result(runId, intent, { _tag: "GitOpDone", sha: "sha1" })];
        case "ResolveRef":
          return [result(runId, intent, { _tag: "RefResolved", sha: "pinned" })];
        case "RemoveWorkspace":
          return [result(runId, intent, { _tag: "WorkspaceRemoved" })];
        case "OpenPullRequest":
          return [
            result(runId, intent, {
              _tag: "PullRequestOpened",
              url: "https://example.invalid/pr/1",
              branch: intent.branch,
            }),
          ];
        case "ReadTicket": {
          const ref = intent.ref.toLowerCase();
          const ticket = options.tickets?.find(
            (t) => t.id === intent.ref || t.identifier.toLowerCase() === ref,
          );
          return [
            result(
              runId,
              intent,
              ticket === undefined
                ? { _tag: "IntentFailed", error: `no ticket ${intent.ref}`, retryable: false }
                : {
                    _tag: "TicketRead",
                    ticketId: ticket.id,
                    title: `${ticket.identifier} ${ticket.title}`,
                    message: `Kanban ticket ${ticket.identifier}\n${ticket.identifier}: ${ticket.title}`,
                  },
            ),
          ];
        }
        case "LinkThread":
          links.add(`${intent.ticketId} ${intent.threadId}`);
          return [result(runId, intent, { _tag: "ThreadLinked" })];
        case "StartChildRun":
          return [
            result(runId, intent, { _tag: "ChildRunStarted", childRunId: `child-${intent.key}` }),
          ];
        case "PostToBot": {
          if (missingBots.has(intent.botId))
            return [result(runId, intent, { _tag: "BotPosted", threadId: null })];
          const commandId = `${runId}:${intent.key}`;
          if (!posts.has(commandId))
            posts.set(commandId, { botId: intent.botId, report: intent.report });
          return [result(runId, intent, { _tag: "BotPosted", threadId: `bot:${intent.botId}:1` })];
        }
      }
    });

  // Holds are keyed by step key (`a`, `each[1]/w`); an interrupt releases its step's hold.
  const holdFor = (step: string) => {
    const existing = holds.get(step);
    if (existing !== undefined) return existing;
    const created = Deferred.makeUnsafe<void>();
    holds.set(step, created);
    return created;
  };
  const held = new Set<string>();

  const observe = (runId: string, intent: Intent): Stream.Stream<NewFact> => {
    if (intent._tag !== "StartTurn" && intent._tag !== "StartUnit") return Stream.empty;
    return Stream.fromEffect(
      Effect.gen(function* () {
        if (held.has(intent.step)) yield* Deferred.await(holdFor(intent.step));
        const stream = runStream(runId);
        if (intent._tag === "StartTurn") {
          const script = options.turns?.[intent.step] ?? {};
          const nudge = intent.key.startsWith("nudge:");
          const fact: RunFact = {
            _tag: "TurnSettled",
            step: intent.step,
            attempt: intent.attempt,
            status: script.status ?? "completed",
            text: "reply",
            output: script.output ?? null,
            outputError: nudge ? null : (script.outputError ?? null),
            cost,
            headSha: null,
          };
          const key = `settled:${intent.step}@${intent.attempt}${nudge ? ":nudge" : ""}`;
          return { stream, key, fact } satisfies NewFact;
        }
        const script = options.units?.[intent.step] ?? {};
        const fact: RunFact = {
          _tag: "UnitExited",
          step: intent.step,
          attempt: intent.attempt,
          exit: script.exit ?? 0,
          signal: null,
          queuedMs: 0,
          out: script.out ?? null,
          tail: script.tail ?? "",
          lost: false,
          started: true,
        };
        return { stream, key: `exited:${intent.step}@${intent.attempt}`, fact } satisfies NewFact;
      }),
    );
  };

  const fake: FakeInterpreter = {
    executions,
    threads,
    units,
    hold: (step) =>
      Effect.sync(() => {
        held.add(step);
        holdFor(step);
      }),
    release: (step) => Deferred.succeed(holdFor(step), undefined).pipe(Effect.asVoid),
    stall,
    abandoned,
    failRetryable,
    posts,
    missingBots,
    links,
    workspaces,
  };
  const layer = Layer.succeed(
    WorkflowInterpreter,
    WorkflowInterpreter.of({
      execute,
      abandon: Effect.fn("WorkflowInterpreter.abandon")(function* (runId: string, intent: Intent) {
        yield* Effect.sync(() => abandoned.add(intent.key));
        return [
          result(runId, intent, {
            _tag: "IntentFailed",
            error: "the run ended before it started",
            retryable: false,
          }),
        ];
      }),
      observe: (runId, intent) => observe(runId, intent),
    }),
  );
  return { fake, layer };
});
