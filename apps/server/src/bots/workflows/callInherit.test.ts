// @effect-diagnostics nodeBuiltinImport:off - the worktrees are real directories with untracked files.
/**
 * A `call` that hands its child the caller's worktree and thread, through the real engine and
 * interpreter: only the provider (threads with a history) and git (directories) are fakes.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { type Project, WorkflowId } from "@t3tools/contracts";

import * as BotsDb from "../BotsDb.ts";
import { ProjectService } from "../../project/ProjectService.ts";
import { type Intent, type NewFact, runStream, workflowStream } from "./facts.ts";
import { runIdFor } from "./ids.ts";
import { WorkflowGit } from "./git/Workspaces.ts";
import type { WorkflowCatalog } from "./Catalog.ts";
import type { WorkflowInterpreter } from "./Interpreter.ts";
import { Journal, layerFromDb, type WorkflowJournalError } from "./Journal.ts";
import { cost, compile } from "./testkit/decideHarness.ts";
import { layerCatalog } from "./testkit/fakeEngine.ts";
import { layer as hostInterpreter } from "./exec/HostInterpreter.ts";
import { WorkflowTurnError, WorkflowTurns } from "./exec/Turns.ts";
import { WorkflowUnits } from "./exec/Units.ts";
import { make } from "./WorkflowEngine.ts";

type StartTurn = Extract<Intent, { readonly _tag: "StartTurn" }>;

const EVIDENCE = ".verify/RESULT.json";

/**
 * The child at the end of the chain: an agent reads the evidence in its worktree. With `look`, a
 * second agent reads it again in a thread of its own, in the same workspace.
 */
const prCiWith = (ci: Record<string, unknown> = {}, look = false) =>
  compile({
    id: "prci",
    title: "PR CI",
    triggers: { call: { kind: "call" } },
    workspaces: { pr: { project: "t3code", base: "friend/main", branch: "wf/prci" } },
    nodes: {
      ci: {
        kind: "agent",
        model: "$lead",
        prompt: "CI until green.",
        workspace: "pr",
        access: "write",
        output: { evidence: { type: "string" }, thread: { type: "string" } },
        ...ci,
      },
      ...(look
        ? {
            look: {
              kind: "agent",
              model: "$lead",
              prompt: "Look again. CI until green.",
              workspace: "pr",
              access: "write",
              output: { evidence: { type: "string" }, thread: { type: "string" } },
            },
          }
        : {}),
      done: {
        kind: "output",
        status: "ready_for_review",
        value: {
          evidence: "{{ nodes.ci.output.evidence }}",
          thread: "{{ nodes.ci.output.thread }}",
          ...(look ? { look: "{{ nodes.look.output.evidence }}" } : {}),
        },
      },
    },
    edges: look ? ["ci -> look", "look -> done"] : ["ci -> done"],
  });
const prCi = prCiWith();

const toPrCi = {
  kind: "call",
  workflow: "prci",
  params: {},
  workspaces: { pr: "ticket" },
  threads: { ci: "implement" },
};

/** Implements in its own worktree and thread, then hands both to `prci`. */
const ticket = compile({
  id: "ticket",
  title: "Ticket",
  triggers: { run: { kind: "manual" }, call: { kind: "call" } },
  workspaces: { ticket: { project: "t3code", base: "friend/main", branch: "wf/ticket" } },
  nodes: {
    implement: {
      kind: "agent",
      model: "$lead",
      prompt: "Implement solo.",
      workspace: "ticket",
      access: "write",
    },
    ci: toPrCi,
    done: { kind: "output", status: "ready_for_review", value: { ci: "{{ nodes.ci.output }}" } },
  },
  edges: ["implement -> ci", "ci -> done"],
});

/** Each item implements in its own worktree and thread, then calls `ticket` with both. */
const fleet = compile({
  id: "fleet",
  title: "Fleet",
  params: { tickets: { type: "string[]", maxItems: 10, pattern: "[a-z]+" } },
  workspaces: {
    item: { project: "t3code", base: "friend/main", perItem: true, branch: "wf/fleet/{{ item }}" },
  },
  nodes: {
    fleet: {
      kind: "map",
      items: "params.tickets",
      maxItems: 10,
      concurrency: 2,
      body: {
        nodes: {
          implement: {
            kind: "agent",
            model: "$lead",
            prompt: "Implement {{ item }}.",
            workspace: "item",
            access: "write",
          },
          ticket: {
            kind: "call",
            workflow: "ticket",
            params: {},
            workspaces: { ticket: "item" },
            threads: { implement: "implement" },
          },
          done: {
            kind: "output",
            status: "ready_for_review",
            value: { item: "{{ item }}", ci: "{{ nodes.ticket.output.ci }}" },
          },
        },
        edges: ["implement -> ticket", "ticket -> done"],
      },
    },
    report: { kind: "output", status: "ready_for_review", value: {} },
  },
  edges: ["fleet -> report"],
});

const project: Project = {
  id: "project-1" as Project["id"],
  title: "t3code",
  workspaceRoot: "/repo",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-11-02T00:00:00.000Z",
  updatedAt: "2026-11-02T00:00:00.000Z",
  deletedAt: null,
};

/**
 * A provider whose threads keep every message they got and the worktree they were opened in. A
 * turn asked to implement writes an untracked evidence file there (once); a CI turn reads it back from
 * its own worktree and answers with it, its thread and that thread's history.
 */
const fakeProvider = (ciFailures: number) => {
  let ciTurns = 0;
  const threads = new Map<string, { readonly path: string; readonly messages: string[] }>();
  // A turn asked to hold runs until its thread is interrupted.
  const holds = new Map<string, Deferred.Deferred<void>>();
  const holdOf = (threadId: string) => {
    const existing = holds.get(threadId);
    if (existing !== undefined) return existing;
    const created = Deferred.makeUnsafe<void>();
    holds.set(threadId, created);
    return created;
  };
  const turns = WorkflowTurns.of({
    start: (_runId, intent) =>
      Effect.suspend(() => {
        const thread = threads.get(intent.threadId);
        if (intent.mode === "new") {
          if (thread === undefined)
            threads.set(intent.threadId, { path: intent.workspace.path, messages: [] });
        } else if (thread === undefined) {
          return Effect.fail(new WorkflowTurnError({ message: "no such thread", permanent: true }));
        }
        threads.get(intent.threadId)?.messages.push(intent.prompt);
        return Effect.succeed(intent.threadId);
      }),
    observe: (runId, intent: StartTurn) => {
      const held = intent.prompt.startsWith("Hold.");
      const settle = Effect.sync((): NewFact => {
        const thread = threads.get(intent.threadId);
        const file = NodePath.join(intent.workspace.path, EVIDENCE);
        let output: { readonly [key: string]: string } | null = null;
        let failed = false;
        const implement = /^Implement (\S+)\./.exec(intent.prompt);
        // The first implementer of a worktree leaves the evidence; a continuation keeps it.
        if (implement !== null && !NodeFS.existsSync(file)) {
          NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
          NodeFS.writeFileSync(file, `evidence of ${implement[1]}`);
        } else if (intent.prompt.includes("CI until green.") && ++ciTurns <= ciFailures) {
          failed = true;
        } else if (intent.prompt.includes("CI until green.")) {
          output = {
            evidence: NodeFS.existsSync(file) ? NodeFS.readFileSync(file, "utf8") : "missing",
            thread: intent.threadId,
            history: (thread?.messages ?? []).join(" | "),
          };
        }
        return {
          stream: runStream(runId),
          key: `settled:${intent.step}@${intent.attempt}`,
          fact: {
            _tag: "TurnSettled",
            step: intent.step,
            attempt: intent.attempt,
            status: held ? "interrupted" : failed ? "failed" : "completed",
            text: output === null ? "done" : `\`\`\`json\n${JSON.stringify(output)}\n\`\`\``,
            output,
            outputError: null,
            cost,
            // The commit this turn left, so a test can tell whose work a head is.
            headSha: `${intent.step}@${intent.attempt}:${runId}`,
          },
        };
      });
      return Stream.fromEffect(
        held ? Deferred.await(holdOf(intent.threadId)).pipe(Effect.andThen(settle)) : settle,
      );
    },
    interrupt: (_runId, _key, threadId) =>
      Deferred.succeed(holdOf(threadId), undefined).pipe(Effect.asVoid),
    answer: () => Effect.void,
  });
  return { threads, turns };
};

const harness = (
  workflows: Parameters<typeof layerCatalog>[0],
  ciFailures: number,
  body: (ctx: {
    readonly provider: ReturnType<typeof fakeProvider>;
    readonly removed: ReadonlyArray<string>;
  }) => Effect.Effect<
    void,
    WorkflowJournalError,
    Journal | Scope.Scope | WorkflowCatalog | WorkflowInterpreter
  >,
) =>
  Effect.gen(function* () {
    const runsDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "wf-call-inherit-"));
    const provider = fakeProvider(ciFailures);
    const removed: string[] = [];
    const unused = () => Effect.die("not used");
    const executors = Layer.mergeAll(
      Layer.succeed(WorkflowTurns, provider.turns),
      Layer.succeed(
        WorkflowUnits,
        WorkflowUnits.of({ start: unused, observe: unused, started: unused, stop: unused }),
      ),
      Layer.succeed(
        WorkflowGit,
        WorkflowGit.of({
          // A linked worktree: a directory whose `.git` file points into the repository.
          prepare: (input) =>
            Effect.sync(() => {
              NodeFS.mkdirSync(input.path, { recursive: true });
              NodeFS.writeFileSync(
                NodePath.join(input.path, ".git"),
                `gitdir: ${input.repoRoot}/.git/worktrees/${NodePath.basename(input.path)}\n`,
              );
              return { path: input.path, branch: input.branch, headSha: "base0" };
            }),
          head: () => Effect.succeed("head1"),
          tree: () => Effect.succeed("tree1"),
          advance: unused,
          mergeLocal: unused,
          remove: (input) =>
            Effect.sync(() => {
              removed.push(input.path);
              NodeFS.rmSync(input.path, { recursive: true, force: true });
            }),
          release: unused,
          resolveRef: unused,
        }),
      ),
      Layer.succeed(
        ProjectService,
        ProjectService.of({
          ...({} as ProjectService["Service"]),
          snapshot: Effect.succeed({ projects: [project], updatedAt: project.updatedAt }),
        }),
      ),
    );
    const journal = layerFromDb.pipe(Layer.provide(BotsDb.layerMemory));
    const interpreter = hostInterpreter({ runsDir }).pipe(
      Layer.provide(Layer.merge(executors, journal)),
    );
    yield* body({ provider, removed }).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(runsDir, { recursive: true, force: true }))),
      Effect.scoped,
      Effect.provide(Layer.mergeAll(journal, interpreter, layerCatalog(workflows))),
    );
  });

const start = (workflowId: string, params: Record<string, ReadonlyArray<string>> = {}) => ({
  workflowId,
  triggerId: "run",
  kind: "manual",
  occurrence: `manual:${workflowId}`,
  label: "Run now",
  params,
  payload: null,
  causalDepth: 0,
  parent: null,
});

/** Runs `workflowId` until its stream has the fact `until` (its end) and returns its state. */
const runToEnd = (
  workflowId: string,
  params?: Record<string, ReadonlyArray<string>>,
  until = "ended",
) =>
  Effect.gen(function* () {
    const journal = yield* Journal;
    const subscription = yield* journal.subscribe;
    const engine = yield* make({ runsDir: "/unused" });
    const { runId } = yield* engine.start(start(workflowId, params));
    // A child's trigger waits for the engine's tick, as on the host; tick when one fires.
    yield* PubSub.take(subscription).pipe(
      Effect.tap((f) => (f.fact._tag === "TriggerFired" ? engine.tick : Effect.void)),
      Effect.repeat({ until: (f) => f.stream === runStream(runId) && f.key === until }),
    );
    return { engine, runId, state: yield* engine.runState(runId) };
  });

const childOf = (
  engine: Effect.Success<ReturnType<typeof make>>,
  state: { readonly intents: ReadonlyMap<string, { readonly result: unknown }> },
  key: string,
) =>
  Effect.gen(function* () {
    const result = state.intents.get(key)?.result as { _tag: string; childRunId: string };
    assert.equal(result?._tag, "ChildRunStarted");
    return yield* engine.runState(result.childRunId);
  });

const turnOf = (
  state: { readonly intents: ReadonlyMap<string, { readonly intent: Intent }> },
  key: string,
): StartTurn => {
  const intent = state.intents.get(key)?.intent;
  assert.equal(intent?._tag, "StartTurn");
  return intent as StartTurn;
};

it.effect("a called agent continues the caller's thread in the caller's worktree", () =>
  harness([ticket, prCiWith({}, true)], 0, ({ provider, removed }) =>
    Effect.gen(function* () {
      // The worktree goes after the end: wait for its removal.
      const { engine, state } = yield* runToEnd("ticket", {}, "result:rm:ticket");
      assert.equal(state.ended?.status, "succeeded");
      const implement = turnOf(state, "turn:implement@1");
      const child = yield* childOf(engine, state, "child:ci@1");
      assert.equal(child.ended?.status, "succeeded");
      const ci = turnOf(child, "turn:ci@1");
      // Same thread, as a follow-up: the child's turn sees what the caller's agent was told.
      assert.equal(ci.threadId, implement.threadId);
      assert.equal(ci.mode, "continue");
      // Same worktree, by path, for the thread and for a child agent in a thread of its own: the
      // untracked evidence the caller left is there to read.
      const look = turnOf(child, "turn:look@1");
      assert.equal(look.mode, "new");
      assert.notEqual(look.threadId, implement.threadId);
      for (const turn of [ci, look]) assert.equal(turn.workspace.path, implement.workspace.path);
      assert.equal(provider.threads.size, 2);
      // The child's last commit in the worktree is the caller's head again.
      assert.equal(state.workspaces.get("ticket")?.headSha, `look@1:${child.runId}`);
      assert.deepEqual(state.output?.value, {
        ci: { evidence: "evidence of solo", thread: implement.threadId, look: "evidence of solo" },
      });
      assert.deepEqual(provider.threads.get(implement.threadId)?.messages.length, 2);
      assert.include(provider.threads.get(implement.threadId)?.messages[0], "Implement solo.");
      // The child prepared and removed no worktree; the caller removed its own, once, at its end.
      assert.isFalse(
        [...child.intents.keys()].some((k) => k.startsWith("ws:") || k.startsWith("rm:")),
      );
      assert.deepEqual(removed, [implement.workspace.path]);
    }),
  ),
);

it.effect("each map item hands its own worktree and thread down a three-level chain", () =>
  harness([fleet, ticket, prCi], 0, ({ provider }) =>
    Effect.gen(function* () {
      const { engine, state } = yield* runToEnd("fleet", { tickets: ["one", "two"] });
      assert.equal(state.ended?.status, "succeeded");
      const items = ["one", "two"];
      const seen = new Set<string>();
      for (const [index, name] of items.entries()) {
        const implement = turnOf(state, `turn:fleet[${index}]/implement@1`);
        const middle = yield* childOf(engine, state, `child:fleet[${index}]/ticket@1`);
        assert.equal(middle.ended?.status, "succeeded");
        const inherited = turnOf(middle, "turn:implement@1");
        const leaf = yield* childOf(engine, middle, "child:ci@1");
        assert.equal(leaf.ended?.status, "succeeded");
        const ci = turnOf(leaf, "turn:ci@1");
        // Every level works in the item's thread and worktree, never in the other item's.
        for (const turn of [inherited, ci]) {
          assert.equal(turn.threadId, implement.threadId);
          assert.equal(turn.mode, "continue");
          assert.equal(turn.workspace.path, implement.workspace.path);
        }
        seen.add(implement.threadId);
        seen.add(implement.workspace.path);
        const output = (leaf.output?.value ?? {}) as { evidence?: string };
        assert.equal(output.evidence, `evidence of ${name}`);
        const history = provider.threads.get(implement.threadId)?.messages ?? [];
        assert.equal(history.length, 3);
        assert.include(history[0], `Implement ${name}.`);
      }
      // Two items: two threads and two worktrees, no more.
      assert.equal(seen.size, 4);
      assert.equal(provider.threads.size, 2);
    }),
  ),
);

it.effect("a retried child step and a retried call stay in the inherited thread and worktree", () =>
  // The child's agent retries once on its own, fails again, and the user retries the call.
  harness([ticket, prCiWith({ retry: { max: 1, on: ["failed"] } })], 2, ({ provider, removed }) =>
    Effect.gen(function* () {
      const { engine, runId, state } = yield* runToEnd("ticket");
      assert.equal(state.ended?.status, "failed");
      const implement = turnOf(state, "turn:implement@1");
      const first = yield* childOf(engine, state, "child:ci@1");
      assert.equal(first.ended?.status, "failed");
      const subscription = yield* (yield* Journal).subscribe;
      yield* engine.control({
        runId,
        control: "retry",
        step: "ci",
        clientRequestId: "retry-ci",
        by: "user",
      });
      yield* PubSub.take(subscription).pipe(
        Effect.tap((f) => (f.fact._tag === "TriggerFired" ? engine.tick : Effect.void)),
        Effect.repeat({
          until: (f) => f.stream === runStream(runId) && f.key === "result:rm:ticket",
        }),
      );
      const after = yield* engine.runState(runId);
      assert.equal(after.ended?.status, "succeeded");
      const second = yield* childOf(engine, after, "child:ci@2");
      assert.notEqual(second.runId, first.runId);
      const turns = [
        turnOf(first, "turn:ci@1"),
        turnOf(first, "turn:ci@2"),
        turnOf(second, "turn:ci@1"),
      ];
      for (const turn of turns) {
        assert.equal(turn.threadId, implement.threadId);
        assert.equal(turn.mode, "continue");
        assert.equal(turn.workspace.path, implement.workspace.path);
      }
      assert.equal(provider.threads.size, 1);
      assert.equal(provider.threads.get(implement.threadId)?.messages.length, 4);
      assert.deepEqual(after.output?.value, {
        ci: { evidence: "evidence of solo", thread: implement.threadId },
      });
      // Kept through the failure for the retry, removed once by its owner when it succeeded.
      assert.deepEqual(removed, [implement.workspace.path]);
    }),
  ),
);

/** Called with the caller's worktree; ends by `fast` while the grandchild it called still runs. */
const middle = compile({
  id: "middle",
  title: "Middle",
  triggers: { call: { kind: "call" } },
  // The call reserves the grandchild's whole budget; `fast` needs room beside it.
  budget: { steps: 20, wall: "2h", tokens: 1_000_000 },
  workspaces: { ws: { project: "t3code", base: "friend/main", branch: "wf/middle" } },
  nodes: {
    slow: { kind: "call", workflow: "slow", params: {} },
    fast: { kind: "agent", model: "$lead", prompt: "Quick.", workspace: "ws", access: "write" },
    done: { kind: "output", status: "ready_for_review", value: {} },
    late: { kind: "output", status: "no_change", value: {} },
  },
  edges: ["fast -> done", "slow -> late"],
});
/** A grandchild whose only turn runs until it is interrupted. */
const slow = compile({
  id: "slow",
  title: "Slow",
  triggers: { call: { kind: "call" } },
  workspaces: { own: { project: "t3code", base: "friend/main", branch: "wf/slow" } },
  nodes: {
    hold: { kind: "agent", model: "$lead", prompt: "Hold.", workspace: "own", access: "write" },
    done: { kind: "output", status: "no_change", value: {} },
  },
  edges: ["hold -> done"],
});
const top = compile({
  id: "top",
  title: "Top",
  triggers: { run: { kind: "manual" } },
  budget: { steps: 20, wall: "2h", tokens: 5_000_000 },
  workspaces: { ticket: { project: "t3code", base: "friend/main", branch: "wf/top" } },
  nodes: {
    implement: {
      kind: "agent",
      model: "$lead",
      prompt: "Implement top.",
      workspace: "ticket",
      access: "write",
    },
    mid: { kind: "call", workflow: "middle", params: {}, workspaces: { ws: "ticket" } },
    done: { kind: "output", status: "ready_for_review", value: {} },
  },
  edges: ["implement -> mid", "mid -> done"],
});

it.effect("a sharing child that ends while its own child runs reports once that one stopped", () =>
  harness([top, middle, slow], 0, () =>
    Effect.gen(function* () {
      const { engine, state } = yield* runToEnd("top");
      assert.equal(state.ended?.status, "succeeded");
      const mid = yield* childOf(engine, state, "child:mid@1");
      assert.equal(mid.ended?.status, "succeeded");
      assert.isTrue(mid.keys.has("reported"));
      const grandchild = yield* childOf(engine, mid, "child:slow@1");
      assert.equal(grandchild.ended?.status, "cancelled");
    }),
  ),
);

/** Two items call `slow`, which runs one at a time: one call starts it, the other is skipped. */
const busyFleet = compile({
  id: "busyfleet",
  title: "Busy fleet",
  triggers: { run: { kind: "manual" } },
  budget: { steps: 20, wall: "2h", tokens: 5_000_000 },
  params: { tickets: { type: "string[]", maxItems: 10, pattern: "[a-z]+" } },
  nodes: {
    fleet: {
      kind: "map",
      items: "params.tickets",
      maxItems: 10,
      concurrency: 2,
      body: { nodes: { hold: { kind: "call", workflow: "slow", params: {} } }, edges: [] },
    },
  },
});

it.effect("a call skipped because its workflow is busy says why and is listed", () =>
  harness([busyFleet, slow], 0, () =>
    Effect.gen(function* () {
      const { engine, runId, state } = yield* runToEnd("busyfleet", { tickets: ["one", "two"] });
      assert.equal(state.ended?.status, "failed");
      const view = yield* engine.runView({ runId });
      const skippedStep = view.steps.find(
        (step) => step.node === "hold" && step.status === "failed",
      );
      assert.isDefined(skippedStep);
      assert.include(skippedStep?.summary, "child run skipped (busy)");
      assert.include(skippedStep?.summary, "concurrency: single");
      const ended = [...state.children.values()].find((child) => child.status === "skipped");
      const { runs } = yield* engine.listRuns({ workflowId: WorkflowId.make("slow") });
      const listed = runs.find((run) => run.status === "skipped");
      assert.equal(listed?.skipReason, "busy");
      assert.isDefined(ended);
      assert.equal(listed?.runId, ended?.childRunId);
      assert.isNotNull(listed?.endedAt);
      assert.equal(runs.length, 2);
    }),
  ),
);

it.effect("a skipped call whose row a crash lost is listed once at boot", () =>
  harness([slow], 0, () =>
    Effect.gen(function* () {
      const journal = yield* Journal;
      const engine = yield* make({ runsDir: "/unused" });
      const occurrence = "call:wfr_parent:hold@1";
      const runId = runIdFor("slow", occurrence);
      // The decider's facts were appended; the crash came before the row was written.
      yield* journal.append([
        {
          stream: workflowStream("slow"),
          key: occurrence,
          fact: {
            _tag: "TriggerFired",
            runId,
            triggerId: "call",
            kind: "call",
            occurrence,
            label: "Call",
            params: {},
            payload: null,
            causalDepth: 1,
            parent: { runId: "wfr_parent", step: "hold" },
            at: "2026-11-05T00:00:00.000Z",
          },
        },
        {
          stream: workflowStream("slow"),
          key: `skipped:${occurrence}`,
          fact: { _tag: "TriggerSkipped", occurrence, reason: "busy" },
        },
      ]);
      yield* engine.rebuildProjection;
      yield* engine.rebuildProjection;
      const { runs } = yield* engine.listRuns({ workflowId: WorkflowId.make("slow") });
      assert.deepEqual(
        runs.map((run) => [run.runId, run.status, run.skipReason, run.endedAt !== null]),
        [[runId, "skipped", "busy", true]],
      );
    }),
  ),
);
