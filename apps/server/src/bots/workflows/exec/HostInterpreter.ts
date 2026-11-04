// @effect-diagnostics nodeBuiltinImport:off - reads a worktree's `.git` file to find its repository.
/**
 * The interpreter on the host (§3.3): each intent goes to its executor, git worktrees, systemd
 * units or T3 threads, and comes back as facts. Paths and unit names are pure functions of the run
 * and the intent key, so a replay after a crash finds the worktree, unit or thread it made before.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { DEFAULT_HOST_LIMITS } from "@t3tools/shared/workflows";

import { ServerEnvironment } from "../../../environment/ServerEnvironment.ts";
import { type ProjectOperationError, ProjectService } from "../../../project/ProjectService.ts";
// wf-engine slice 8: notices, the run's card and the draft pull request.
import { WorkflowCards } from "../card/WorkflowCards.ts";
import { WorkflowTickets } from "../card/WorkflowTickets.ts";
import { workflowRunWebPath } from "../notices/notices.ts";
import { WorkflowNotices } from "../notices/WorkflowNotices.ts";
import { WorkflowPullRequests } from "../publish/PullRequests.ts";
import { WorkflowBotPosts } from "../publish/BotPosts.ts";
import { type Intent, type NewFact, type RunFact, runStream, workflowStream } from "../facts.ts";
import { WorkflowGit, WorkflowGitError } from "../git/Workspaces.ts";
import { keyHash, runIdFor } from "../ids.ts";
import { foldRun } from "../fold.ts";
import { WorkflowInterpreter } from "../Interpreter.ts";
import { Journal, type WorkflowJournalError } from "../Journal.ts";
import type { IntentResult } from "../state.ts";
import { projectByRef } from "./projects.ts";
import { redactSecrets } from "./redact.ts";
import { type WorkflowSlotError, WorkflowSlots } from "./Slots.ts";
import { unobservedTurn } from "./turnResult.ts";
import { WorkflowTurnError, WorkflowTurns } from "./Turns.ts";
import { WorkflowUnits, type WorkflowUnitError } from "./Units.ts";

type ExecutorError =
  | WorkflowSlotError
  | WorkflowTurnError
  | WorkflowUnitError
  | WorkflowGitError
  | WorkflowJournalError
  | ProjectOperationError;

/** Whether trying the same intent again may succeed: false only for definitive refusals. */
export const retryable = (error: ExecutorError): boolean => {
  switch (error._tag) {
    case "WorkflowTurnError":
      return error.permanent !== true;
    case "WorkflowGitError":
      return error.conflict !== true && error.permanent !== true;
    default:
      return true;
  }
};

export interface HostInterpreterOptions {
  /** Each run's worktrees and unit receipts live under `<runsDir>/<runId>`. */
  readonly runsDir: string;
}

/** An observer whose reads keep failing gives up after about five minutes; see `unobserved`. */
const OBSERVE_RETRY = Schedule.spaced("5 seconds").pipe(Schedule.upTo({ times: 60 }));

const nowIso = Clock.currentTimeMillis.pipe(
  Effect.map((millis) => DateTime.formatIso(DateTime.makeUnsafe(millis))),
);

/** The repository a linked worktree belongs to, from its `.git` file; null when it is gone. */
const repoOfWorktree = (path: string): string | null => {
  try {
    const pointer = NodeFS.readFileSync(NodePath.join(path, ".git"), "utf8");
    const gitdir = /^gitdir: (.+)$/m.exec(pointer)?.[1]?.trim();
    const marker = gitdir?.lastIndexOf("/.git/worktrees/") ?? -1;
    return gitdir !== undefined && marker > 0 ? gitdir.slice(0, marker) : null;
  } catch {
    return null;
  }
};

export const make = Effect.fn("HostInterpreter.make")(function* (options: HostInterpreterOptions) {
  const git = yield* WorkflowGit;
  const units = yield* WorkflowUnits;
  const turns = yield* WorkflowTurns;
  const projects = yield* ProjectService;
  const journal = yield* Journal;
  // wf-engine slice 8: optional, so a host without them (tests, the CLI) keeps logging instead.
  const notices = yield* Effect.serviceOption(WorkflowNotices);
  const cards = yield* Effect.serviceOption(WorkflowCards);
  const tickets = yield* Effect.serviceOption(WorkflowTickets);
  const pullRequests = yield* Effect.serviceOption(WorkflowPullRequests);
  const botPosts = yield* Effect.serviceOption(WorkflowBotPosts);
  const environment = yield* Effect.serviceOption(ServerEnvironment);
  const slots = yield* Effect.serviceOption(WorkflowSlots);

  const runDir = (runId: string) => NodePath.join(options.runsDir, runId);
  /** A workspace's path from its name alone, so GitOp and RemoveWorkspace find it. */
  const workspacePath = (runId: string, name: string) =>
    NodePath.join(
      runDir(runId),
      "ws",
      `${name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 40)}-${keyHash(runId, `ws:${name}`).slice(0, 8)}`,
    );
  const unitOf = (runId: string, key: string) => {
    const hash = keyHash(runId, key);
    return { unit: `wf-${hash}`, receiptDir: NodePath.join(runDir(runId), "units", hash) };
  };

  const result = (runId: string, intent: Intent, fact: IntentResult): NewFact => ({
    stream: runStream(runId),
    key: `result:${intent.key}`,
    fact,
  });
  const failed = (
    runId: string,
    intent: Intent,
    error: string,
    retryable = false,
  ): ReadonlyArray<NewFact> => [result(runId, intent, { _tag: "IntentFailed", error, retryable })];

  const botMissing = (runId: string, botId: string, at: string): NewFact => ({
    stream: runStream(runId),
    key: `warn:bot-missing:${botId}`,
    fact: {
      _tag: "RunWarned",
      message: `Bot ${botId}, which this workflow works for, no longer exists: agent steps run without its host MCP servers and nothing is posted to it.`,
      at,
    },
  });

  /** A `wf/…` branch an ended run left behind is released to this run; a live run's is not. */
  const takeOver = Effect.fn("HostInterpreter.takeOver")(function* (
    error: WorkflowGitError,
    input: Parameters<WorkflowGit["Service"]["prepare"]>[0],
  ) {
    const owner = error.owner;
    if (owner == null || input.branch === null) return yield* error;
    const running = new WorkflowGitError({
      message: `Branch ${input.branch} belongs to run ${owner}, which is still running.`,
      permanent: true,
    });
    const ownerState = foldRun(owner, yield* journal.read(runStream(owner)));
    if (ownerState.ended === null) return yield* running;
    // Recorded before the release, and only if the owner did not reopen since its end (checked in
    // the append's transaction): the release and a reopening exclude each other.
    const recorded = yield* journal.append([
      {
        stream: runStream(owner),
        key: `released:${input.branch}`,
        fact: { _tag: "BranchReleased", branch: input.branch, to: input.runId },
        guard: { absent: ["RunReopened"], after: ownerState.endedSeq },
      },
    ]);
    if (recorded.length === 0) return yield* running;
    yield* git.release({ repoRoot: input.repoRoot, branch: input.branch, owner });
    return yield* git.prepare(input);
  });

  const prepare = Effect.fn("HostInterpreter.prepare")(function* (
    runId: string,
    intent: Extract<Intent, { readonly _tag: "PrepareWorkspace" }>,
  ) {
    const snapshot = yield* projects.snapshot;
    const project = projectByRef(snapshot.projects, intent.projectRef);
    if (project === undefined)
      return failed(runId, intent, `There is no project "${intent.projectRef}".`);
    const path = workspacePath(runId, intent.name);
    yield* Effect.sync(() => NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true }));
    const input = {
      repoRoot: project.workspaceRoot,
      path,
      baseRef: intent.baseRef,
      branch: intent.branch,
      runId,
      agentBranch: intent.agentBranch,
    };
    const ready = yield* git
      .prepare(input)
      .pipe(Effect.catchTags({ WorkflowGitError: (error) => takeOver(error, input) }));
    return [
      result(runId, intent, {
        _tag: "WorkspaceReady",
        name: intent.name,
        path: ready.path,
        branch: ready.branch,
        headSha: ready.headSha,
      }),
    ];
  });

  const startChild = Effect.fn("HostInterpreter.startChild")(function* (
    runId: string,
    intent: Extract<Intent, { readonly _tag: "StartChildRun" }>,
  ) {
    const started = yield* journal.get(runStream(runId), "started");
    const parent = Option.getOrUndefined(started)?.fact;
    if (parent?._tag !== "RunStarted")
      return failed(runId, intent, "The parent run has not started.");
    const occurrence = `child:${runId}:${intent.key}`;
    const childRunId = runIdFor(intent.workflowId, occurrence);
    const at = yield* nowIso;
    // The decider of the child's workflow promotes this trigger on its next pass (§3.2).
    return [
      {
        stream: workflowStream(intent.workflowId),
        key: occurrence,
        fact: {
          _tag: "TriggerFired",
          runId: childRunId,
          triggerId: "call",
          kind: "call",
          occurrence,
          label: `${parent.title} → ${intent.step}`,
          params: intent.params,
          payload: { parent: { runId, workflowId: parent.workflowId, step: intent.step } },
          causalDepth: parent.causalDepth + 1,
          parent: { runId, step: intent.step },
          at,
        },
      },
      result(runId, intent, { _tag: "ChildRunStarted", childRunId }),
    ] satisfies ReadonlyArray<NewFact>;
  });

  const interrupt = Effect.fn("HostInterpreter.interrupt")(function* (
    runId: string,
    intent: Extract<Intent, { readonly _tag: "Interrupt" }>,
  ) {
    const done = result(runId, intent, { _tag: "Interrupted" });
    const target = intent.target;
    if ("threadId" in target) {
      yield* turns.interrupt(runId, intent.key, target.threadId);
      return [done];
    }
    if ("unit" in target) {
      yield* units.stop(target.unit);
      return [done];
    }
    const cancel: NewFact = {
      stream: runStream(target.childRunId),
      key: `control:parent:${keyHash(runId, intent.key)}`,
      fact: {
        _tag: "ControlRequested",
        control: "cancel",
        step: null,
        by: `workflow:${runId}`,
        at: yield* nowIso,
      },
    };
    return [cancel, done];
  });

  /**
   * The holder unit of a turn's slot. Its name carries the runs directory, so a test server with
   * the same run id and key never adopts or stops the production holder.
   */
  const slotUnitOf = (runId: string, key: string) => {
    const hash = keyHash(runId, `slot:${options.runsDir}:${key}`);
    return { unit: `wf-slot-${hash}`, receiptDir: NodePath.join(runDir(runId), "slots", hash) };
  };
  const releaseSlot = (runId: string, intent: Intent) =>
    intent._tag !== "StartTurn" || intent.uses === undefined || Option.isNone(slots)
      ? Effect.void
      : slots.value.release(slotUnitOf(runId, intent.key).unit).pipe(Effect.ignore);
  /**
   * Holds the slot of a turn's resource in its holder unit and returns its number. The first time,
   * the first free slot, recorded as SlotAcquired before the turn launches; after that (a replay, a
   * restart) exactly the recorded slot, whose live holder is adopted, so the agent never learns a
   * second number and no other step gets its slot meanwhile.
   */
  const holdSlot = Effect.fn("HostInterpreter.holdSlot")(function* (
    runId: string,
    intent: Extract<Intent, { readonly _tag: "StartTurn" }>,
    uses: NonNullable<Extract<Intent, { readonly _tag: "StartTurn" }>["uses"]>,
  ) {
    if (Option.isNone(slots))
      return yield* new WorkflowTurnError({
        message: "Resource slots are not available on this host.",
        permanent: true,
      });
    const key = `slot:${intent.key}`;
    const stored = Option.getOrUndefined(yield* journal.get(runStream(runId), key))?.fact;
    const recorded = stored?._tag === "SlotAcquired" ? stored.slot : undefined;
    // The holder's cap: the run's wall budget, so a server that never comes back frees it then.
    const started = Option.getOrUndefined(yield* journal.get(runStream(runId), "started"))?.fact;
    const wallMs =
      started?._tag === "RunStarted" ? started.budget.wallMs : DEFAULT_HOST_LIMITS.maxWallMs;
    const from = yield* Clock.currentTimeMillis;
    const slot = yield* slots.value.acquire({
      ...slotUnitOf(runId, intent.key),
      resource: uses.resource,
      slots: uses.slots,
      slot: recorded,
      maxSec: Math.ceil(wallMs / 1000) + 600,
    });
    if (recorded === undefined) {
      const now = yield* Clock.currentTimeMillis;
      yield* journal.append([
        {
          stream: runStream(runId),
          key,
          fact: {
            _tag: "SlotAcquired",
            step: intent.step,
            attempt: intent.attempt,
            resource: uses.resource,
            slot,
            waitedMs: Math.max(0, now - from),
          },
        },
      ]);
    }
    return slot;
  });

  const run = Effect.fn("HostInterpreter.run")(function* (runId: string, intent: Intent) {
    switch (intent._tag) {
      case "StartTurn": {
        const uses = intent.uses;
        const slot = uses === undefined ? null : yield* holdSlot(runId, intent, uses);
        // A turn that did not start gives its slot back; a replay waits for one again.
        const threadId = yield* turns
          .start(
            runId,
            slot === null || uses === undefined
              ? intent
              : {
                  ...intent,
                  prompt: `${intent.prompt}\n\nThis turn holds slot ${slot} of the resource ${uses.resource} (WF_SLOT=${slot}); use that number wherever the project asks for a slot.`,
                },
          )
          // A turn that failed to start gives its slot back; its replay takes the same one again.
          // A shutdown mid-launch keeps it: the turn may run, and the restart adopts the holder.
          .pipe(
            Effect.onError((cause) =>
              Cause.hasInterruptsOnly(cause) ? Effect.void : releaseSlot(runId, intent),
            ),
          );
        const started = result(runId, intent, { _tag: "TurnStarted", threadId });
        if (intent.bot === undefined || Option.isNone(botPosts)) return [started];
        // HostMcpForward finds no bot either, so the turn runs without the bot's servers.
        const exists = yield* botPosts.value
          .exists(intent.bot)
          .pipe(Effect.orElseSucceed(() => true));
        return exists ? [started] : [botMissing(runId, intent.bot, yield* nowIso), started];
      }
      case "StartUnit": {
        const { unit, receiptDir } = unitOf(runId, intent.key);
        yield* Effect.sync(() => NodeFS.mkdirSync(receiptDir, { recursive: true }));
        yield* units.start({
          unit,
          receiptDir,
          argv: intent.argv,
          cwd: intent.cwd.path,
          heavy: intent.heavy,
          uses: intent.uses,
          timeoutMs: intent.timeoutMs,
          env: intent.env,
          parse: intent.parse ?? "none",
        });
        return [result(runId, intent, { _tag: "UnitSpawned", unit, at: yield* nowIso })];
      }
      case "PrepareWorkspace":
        return yield* prepare(runId, intent);
      case "GitOp": {
        const path = workspacePath(runId, intent.workspace);
        const op = intent.op;
        const sha =
          op.kind === "advance"
            ? yield* git.advance({ repoRoot: path, branch: op.branch, from: op.from, to: op.to })
            : yield* git.mergeLocal({ path, from: op.from, expectHead: op.expectHead });
        return [result(runId, intent, { _tag: "GitOpDone", sha })];
      }
      case "ResolveRef": {
        const snapshot = yield* projects.snapshot;
        const project = projectByRef(snapshot.projects, intent.projectRef);
        if (project === undefined) {
          return failed(runId, intent, `There is no project "${intent.projectRef}".`);
        }
        const sha = yield* git.resolveRef({ repoRoot: project.workspaceRoot, ref: intent.ref });
        return [result(runId, intent, { _tag: "RefResolved", sha })];
      }
      case "RemoveWorkspace": {
        const path = workspacePath(runId, intent.name);
        const repoRoot = repoOfWorktree(path);
        if (repoRoot !== null) yield* git.remove({ repoRoot, path });
        return [result(runId, intent, { _tag: "WorkspaceRemoved" })];
      }
      case "Interrupt":
        return yield* interrupt(runId, intent);
      case "AnswerRequest":
        yield* turns.answer(runId, intent);
        return [result(runId, intent, { _tag: "Answered" })];
      case "OpenGate":
        return [
          result(runId, intent, { _tag: "GateOpened", gateKey: intent.gateKey, at: yield* nowIso }),
        ];
      case "Notify": {
        if (Option.isNone(notices)) {
          yield* Effect.logInfo("workflow notice", {
            runId,
            kind: intent.kind,
            title: intent.title,
          });
          return [result(runId, intent, { _tag: "Notified" })];
        }
        const workflowId = Option.getOrElse(yield* journal.workflowOfRun(runId), () => "");
        yield* notices.value.deliver({ runId, workflowId, notice: intent });
        return [result(runId, intent, { _tag: "Notified" })];
      }
      case "UpsertCard": {
        if (Option.isNone(cards) || Option.isNone(environment))
          return failed(runId, intent, "The kanban is not available on this host.");
        const project = projectByRef((yield* projects.snapshot).projects, intent.project);
        if (project === undefined)
          return failed(runId, intent, `There is no project "${intent.project}".`);
        const link = workflowRunWebPath(yield* environment.value.getEnvironmentId, runId);
        return yield* cards.value
          .upsert({
            runId,
            projectId: project.id,
            ...(intent.ticketId === undefined ? {} : { ticketId: intent.ticketId }),
            column: intent.column,
            title: intent.title,
            link,
          })
          .pipe(
            Effect.map(({ ticketId }) => [
              result(runId, intent, { _tag: "CardUpserted", ticketId }),
            ]),
            Effect.catch((error) =>
              Effect.succeed(failed(runId, intent, error.message, error.retryable)),
            ),
          );
      }
      case "OpenPullRequest": {
        if (Option.isNone(pullRequests))
          return failed(runId, intent, "Pull requests are not available on this host.");
        return yield* pullRequests.value
          .open({
            path: workspacePath(runId, intent.workspace),
            branch: intent.branch,
            sha: intent.sha,
            base: intent.base,
            title: intent.title,
            body: intent.body,
          })
          .pipe(
            Effect.map(({ url }) => [
              result(runId, intent, { _tag: "PullRequestOpened", url, branch: intent.branch }),
            ]),
            Effect.catch((error) =>
              Effect.succeed(failed(runId, intent, error.message, error.retryable)),
            ),
          );
      }
      case "PostToBot": {
        if (Option.isNone(botPosts))
          return failed(runId, intent, "Bot posts are not available on this host.");
        return yield* botPosts.value.post({ runId, ...intent }).pipe(
          Effect.flatMap((threadId) =>
            Effect.map(nowIso, (at) => {
              const posted = result(runId, intent, { _tag: "BotPosted", threadId });
              return threadId === null ? [botMissing(runId, intent.botId, at), posted] : [posted];
            }),
          ),
          Effect.catch((error) => Effect.succeed(failed(runId, intent, error.message, true))),
        );
      }
      case "ReadTicket": {
        if (Option.isNone(tickets))
          return failed(runId, intent, "The kanban is not available on this host.");
        return yield* tickets.value.read(intent.ref).pipe(
          Effect.map((ticket) => [result(runId, intent, { _tag: "TicketRead", ...ticket })]),
          Effect.catch((error) =>
            Effect.succeed(failed(runId, intent, error.message, error.retryable)),
          ),
        );
      }
      case "LinkThread": {
        if (Option.isNone(tickets))
          return failed(runId, intent, "The kanban is not available on this host.");
        return yield* tickets.value
          .link({ ticketId: intent.ticketId, threadId: intent.threadId })
          .pipe(
            Effect.as([result(runId, intent, { _tag: "ThreadLinked" })]),
            Effect.catch((error) =>
              Effect.succeed(failed(runId, intent, error.message, error.retryable)),
            ),
          );
      }
      case "StartChildRun":
        return yield* startChild(runId, intent);
    }
  });

  /**
   * Any error or defect becomes the intent's IntentFailed: the interpreter never fails. Replaying
   * an intent is safe by its key, so an error is retryable unless it is definitive; a defect is not.
   */
  const settle =
    (runId: string, intent: Intent, retry = true) =>
    (effect: Effect.Effect<ReadonlyArray<NewFact>, ExecutorError>) =>
      effect.pipe(
        Effect.catch((error) =>
          Effect.succeed(failed(runId, intent, error.message, retry && retryable(error))),
        ),
        Effect.catchDefect((defect) =>
          Effect.succeed(failed(runId, intent, Cause.pretty(Cause.die(defect)))),
        ),
      );

  /**
   * Reads that never succeed try to stop the original, then settle the attempt as unknown: the
   * decider pauses the run for Israel instead of failing or replaying it, because the original may
   * still run and no retry may start a second agent or command beside it.
   */
  const unobserved = Effect.fn("HostInterpreter.unobserved")(function* (
    runId: string,
    intent: Intent,
    error: WorkflowTurnError | WorkflowUnitError,
  ) {
    const stop: Effect.Effect<void, WorkflowTurnError | WorkflowUnitError> =
      intent._tag === "StartTurn"
        ? turns.interrupt(runId, `unobserved:${intent.key}`, intent.threadId)
        : intent._tag === "StartUnit"
          ? units.stop(unitOf(runId, intent.key).unit)
          : Effect.void;
    const stopped = yield* stop.pipe(
      Effect.as("it was stopped"),
      Effect.catch((stopError) => Effect.succeed(`stopping it failed too (${stopError.message})`)),
    );
    const text = `The workflow could not observe this step (${error.message}); ${stopped}.`;
    if (intent._tag === "StartTurn") return [unobservedTurn(runId, intent, "unknown", text)];
    if (intent._tag !== "StartUnit") return [];
    const failed: RunFact = {
      _tag: "UnitExited",
      step: intent.step,
      attempt: intent.attempt,
      exit: null,
      signal: "UNOBSERVED",
      queuedMs: 0,
      out: null,
      tail: text,
      lost: false,
      started: true,
      parseError: null,
      headSha: null,
    };
    const fact: NewFact = {
      stream: runStream(runId),
      key: `exited:${intent.step}@${intent.attempt}`,
      fact: failed,
    };
    return [fact];
  });

  const observeUnit = (
    runId: string,
    intent: Extract<Intent, { readonly _tag: "StartUnit" }>,
    spawnedAt: string,
  ): Stream.Stream<NewFact, WorkflowUnitError> =>
    Stream.concat(
      unitSlot(runId, intent, spawnedAt),
      Stream.fromEffect(
        Effect.gen(function* () {
          const { unit, receiptDir } = unitOf(runId, intent.key);
          const outcome = yield* units.observe({
            unit,
            receiptDir,
            spawnedAt: Date.parse(spawnedAt),
          });
          const headSha = yield* git.head(intent.cwd.path).pipe(Effect.option);
          const exited: RunFact = {
            _tag: "UnitExited",
            step: intent.step,
            attempt: intent.attempt,
            exit: outcome.exit,
            signal: outcome.signal,
            queuedMs: outcome.queuedMs,
            out: outcome.out,
            tail: redactSecrets(outcome.tail),
            lost: outcome.lost,
            started: outcome.started,
            parseError: outcome.parseError,
            stderr: redactSecrets(outcome.stderr),
            headSha: Option.getOrNull(headSha),
          };
          return {
            stream: runStream(runId),
            key: `exited:${intent.step}@${intent.attempt}`,
            fact: exited,
          } satisfies NewFact;
        }),
      ),
    );

  /** A unit that `uses` a resource: its SlotAcquired once wfUnit holds a slot and starts the argv. */
  const unitSlot = (
    runId: string,
    intent: Extract<Intent, { readonly _tag: "StartUnit" }>,
    spawnedAt: string,
  ): Stream.Stream<NewFact, WorkflowUnitError> => {
    const uses = intent.uses;
    if (uses === undefined) return Stream.empty;
    return Stream.fromIterableEffect(
      Effect.gen(function* () {
        const started = yield* units.started(unitOf(runId, intent.key));
        if (started === null || started.slot === null) return [];
        const fact: NewFact = {
          stream: runStream(runId),
          key: `slot:${intent.key}`,
          fact: {
            _tag: "SlotAcquired",
            step: intent.step,
            attempt: intent.attempt,
            resource: uses.resource,
            slot: started.slot,
            waitedMs: Math.max(0, Date.parse(started.at) - Date.parse(spawnedAt)),
          },
        };
        return [fact];
      }),
    );
  };

  /**
   * A turn with a slot, observed again after a restart: it takes its recorded slot back while it is
   * observed, not before, so a turn that ended while the server was down claims no slot. Its end
   * stops the wait, and the tap in `observe` releases the slot.
   */
  const observeHolding = (
    runId: string,
    intent: Extract<Intent, { readonly _tag: "StartTurn" }>,
    uses: NonNullable<Extract<Intent, { readonly _tag: "StartTurn" }>["uses"]>,
  ): Stream.Stream<NewFact, WorkflowTurnError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const holding = yield* Effect.forkScoped(
          holdSlot(runId, intent, uses).pipe(
            Effect.catch((error) =>
              Effect.logWarning("workflow slot not taken back", { runId, error: error.message }),
            ),
          ),
        );
        return turns
          .observe(runId, intent)
          .pipe(
            Stream.tap((fact) =>
              fact.fact._tag === "TurnSettled" ? Fiber.interrupt(holding) : Effect.void,
            ),
          );
      }),
    );

  return WorkflowInterpreter.of({
    execute: Effect.fn("WorkflowInterpreter.execute")((runId: string, intent: Intent) =>
      run(runId, intent).pipe(settle(runId, intent)),
    ),
    abandon: Effect.fn("WorkflowInterpreter.abandon")((runId: string, intent: Intent) => {
      const stop: Effect.Effect<void, WorkflowTurnError | WorkflowUnitError> =
        intent._tag === "StartTurn"
          ? turns.interrupt(runId, `abandon:${intent.key}`, intent.threadId)
          : intent._tag === "StartUnit"
            ? units.stop(unitOf(runId, intent.key).unit)
            : Effect.void;
      return stop.pipe(
        Effect.ensuring(releaseSlot(runId, intent)),
        Effect.as(failed(runId, intent, "The run ended before this step started.")),
        settle(runId, intent, false),
      );
    }),
    observe: (runId, intent, observed) => {
      const stream: Stream.Stream<NewFact, WorkflowTurnError | WorkflowUnitError> =
        intent._tag === "StartTurn" && observed._tag === "TurnStarted"
          ? intent.uses === undefined
            ? turns.observe(runId, intent)
            : observeHolding(runId, intent, intent.uses)
          : intent._tag === "StartUnit" && observed._tag === "UnitSpawned"
            ? observeUnit(runId, intent, observed.at)
            : Stream.empty;
      // Observing is idempotent, so a read that fails is retried; the facts deduplicate by key.
      return stream.pipe(
        Stream.tapError((error) => Effect.logWarning("workflow observe failed", { runId, error })),
        Stream.retry(OBSERVE_RETRY),
        Stream.catchTags({
          WorkflowTurnError: (error) => Stream.fromIterableEffect(unobserved(runId, intent, error)),
          WorkflowUnitError: (error) => Stream.fromIterableEffect(unobserved(runId, intent, error)),
        }),
        // A defect ends this observer after a pause; the actor starts it again on its next pass.
        Stream.catchDefect((defect) =>
          Stream.fromEffectDrain(
            Effect.logError("workflow observe died", { runId, defect }).pipe(
              Effect.andThen(Effect.sleep("5 seconds")),
            ),
          ),
        ),
        // Only a turn that settled frees its slot. An observer interrupted by a shutdown or a
        // deploy leaves the holder unit running, and the restarted observer adopts it.
        Stream.tap((fact) =>
          fact.fact._tag === "TurnSettled" ? releaseSlot(runId, intent) : Effect.void,
        ),
      );
    },
  });
});

/** The interpreter over the real executors; they are provided by the caller. */
export const layer = (options: HostInterpreterOptions) =>
  Layer.effect(WorkflowInterpreter, make(options));
