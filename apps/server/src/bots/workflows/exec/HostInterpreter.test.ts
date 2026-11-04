// @effect-diagnostics nodeBuiltinImport:off - the prepare test needs a real directory for runsDir.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { it as itEffect } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vite-plus/test";

import { ProjectService } from "../../../project/ProjectService.ts";
import { ProjectId, type Project } from "@t3tools/contracts";

import { type Fact, type Intent, runStream } from "../facts.ts";
import { WorkflowGit, WorkflowGitError } from "../git/Workspaces.ts";
import { WorkflowInterpreter } from "../Interpreter.ts";
import { WorkflowBotPosts } from "../publish/BotPosts.ts";
import * as Journal from "../Journal.ts";
import { RUN_ID, runStarted } from "../testkit/decideHarness.ts";
import { keyHash } from "../ids.ts";
import { fakeSystemd } from "../testkit/fakeSystemd.ts";
import { layer, make, retryable } from "./HostInterpreter.ts";
import { make as makeSlots, WorkflowSlots } from "./Slots.ts";
import { slotFile, tryLock } from "./slotLock.ts";
import { WorkflowTurnError, WorkflowTurns } from "./Turns.ts";
import { WorkflowUnitError, WorkflowUnits } from "./Units.ts";

describe("retryable", () => {
  // Replaying an intent is safe by its key, so only a definitive refusal ends the step at once.
  it.each([
    [
      "a launch that failed after upstream may have accepted it",
      new WorkflowTurnError({ message: "launch" }),
      true,
    ],
    ["a missing project", new WorkflowTurnError({ message: "no project", permanent: true }), false],
    ["a busy repository", new WorkflowGitError({ message: "index.lock exists" }), true],
    ["a lost compare-and-swap", new WorkflowGitError({ message: "cas", conflict: true }), false],
    [
      "a branch left by an earlier run",
      new WorkflowGitError({ message: "branch", permanent: true }),
      false,
    ],
    ["a systemd-run that failed", new WorkflowUnitError({ message: "bus" }), true],
  ] as const)("%s → %s", (_, error, expected) => {
    expect(retryable(error)).toBe(expected);
  });
});

describe("observe", () => {
  itEffect.effect("stops a turn it cannot observe and settles it as unknown, never as lost", () =>
    Effect.gen(function* () {
      const interrupts: string[] = [];
      const unused = () => Effect.die("not used by observe");
      const executors = Layer.mergeAll(
        Layer.succeed(
          WorkflowTurns,
          WorkflowTurns.of({
            start: unused,
            observe: () =>
              Stream.fail(new WorkflowTurnError({ message: "projection unavailable" })),
            interrupt: (_runId, key) => Effect.sync(() => void interrupts.push(key)),
            answer: unused,
          }),
        ),
        Layer.succeed(
          WorkflowUnits,
          WorkflowUnits.of({ start: unused, observe: unused, started: unused, stop: unused }),
        ),
        Layer.succeed(
          WorkflowGit,
          WorkflowGit.of({
            prepare: unused,
            head: unused,
            tree: unused,
            advance: unused,
            mergeLocal: unused,
            remove: unused,
            release: unused,
            resolveRef: unused,
          }),
        ),
        // observe never lists projects; the interpreter only needs the service to exist.
        Layer.succeed(ProjectService, ProjectService.of({} as ProjectService["Service"])),
        Journal.layerMemory,
      );
      const intent: Intent = {
        _tag: "StartTurn",
        key: "turn:a@1",
        step: "a",
        attempt: 1,
        threadId: "wf:x",
        mode: "new",
        projectRef: "t3code",
        title: "a",
        workspace: { name: "integ", path: "/runs/integ" },
        prompt: "Do",
        model: { provider: "claude", model: "claude-opus-5-5" },
        access: "write",
        reservation: 0,
      };
      yield* Effect.gen(function* () {
        const interpreter = yield* WorkflowInterpreter;
        const journal = yield* Journal.Journal;
        const parent = runStarted();
        if (parent._tag !== "RunStarted") return yield* Effect.die("Expected RunStarted");
        yield* journal.append([{ stream: runStream(RUN_ID), key: "started", fact: parent }]);
        const child = yield* interpreter.execute(RUN_ID, {
          _tag: "StartChildRun",
          attempt: 1,
          key: "child:c@1",
          step: "c",
          workflowId: "other",
          params: {},
        });
        expect(child[0]?.fact).toMatchObject({
          _tag: "TriggerFired",
          payload: { parent: { runId: RUN_ID, workflowId: parent.workflowId, step: "c" } },
        });

        const observed = yield* interpreter
          .observe(RUN_ID, intent, { _tag: "TurnStarted", threadId: "wf:x" })
          .pipe(Stream.runCollect, Effect.forkScoped);
        for (let tries = 0; tries <= 60; tries++) yield* TestClock.adjust("5 seconds");
        const facts = [...(yield* Fiber.join(observed))];
        expect(interrupts).toEqual(["unobserved:turn:a@1"]);
        expect(
          facts.map((f) => [f.key, f.fact._tag === "TurnSettled" && f.fact.unobserved]),
        ).toEqual([["settled:a@1", true]]);
      }).pipe(Effect.provide(layer({ runsDir: "/runs" }).pipe(Layer.provideMerge(executors))));
    }).pipe(Effect.scoped),
  );
});

describe("prepare", () => {
  const project: Project = {
    id: ProjectId.make("p1"),
    title: "t3code",
    workspaceRoot: "/repo",
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-11-02T00:00:00.000Z",
    updatedAt: "2026-11-02T00:00:00.000Z",
    deletedAt: null,
  };
  const intent: Intent = {
    _tag: "PrepareWorkspace",
    key: "ws:integ",
    name: "integ",
    projectRef: "t3code",
    baseRef: "main",
    branch: "wf/demo",
  };
  const ownedBy = (owner: string) =>
    new WorkflowGitError({ message: "taken", permanent: true, owner });
  // The owner run's stream: started, and ended when `ended`.
  const ownerRun = (ended: boolean) => {
    const stream = runStream("wfr_00000000000000000777");
    const facts: Array<{ stream: string; key: string; fact: Fact }> = [
      { stream, key: "started", fact: runStarted() },
    ];
    if (ended)
      facts.push({ stream, key: "ended", fact: { _tag: "RunEnded", status: "failed", at: "x" } });
    return facts;
  };

  const takeOver = (ended: boolean, reopensMeanwhile = false) =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const unused = () => Effect.die("not used by prepare");
      let prepared = 0;
      const executors = Layer.mergeAll(
        Layer.succeed(
          WorkflowTurns,
          WorkflowTurns.of({
            start: unused,
            observe: () => Stream.die("not used by prepare"),
            interrupt: unused,
            answer: unused,
          }),
        ),
        Layer.succeed(
          WorkflowUnits,
          WorkflowUnits.of({ start: unused, observe: unused, started: unused, stop: unused }),
        ),
        Layer.succeed(
          WorkflowGit,
          WorkflowGit.of({
            prepare: (input) =>
              prepared++ === 0
                ? Effect.fail(ownedBy("wfr_00000000000000000777"))
                : Effect.succeed({ path: input.path, branch: input.branch, headSha: "fresh" }),
            head: unused,
            tree: unused,
            advance: unused,
            mergeLocal: unused,
            remove: unused,
            release: (input) => Effect.sync(() => void calls.push(`release ${input.owner}`)),
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
        // The owner reopens right after the takeover read its stream: the race the guard closes.
        Layer.effect(
          Journal.Journal,
          Effect.gen(function* () {
            const real = yield* Journal.Journal;
            let reopened = !reopensMeanwhile;
            return Journal.Journal.of({
              ...real,
              read: (stream, afterSeq) =>
                real.read(stream, afterSeq).pipe(
                  Effect.tap(() =>
                    reopened || stream !== runStream("wfr_00000000000000000777")
                      ? Effect.void
                      : Effect.suspend(() => {
                          reopened = true;
                          return real.append([
                            {
                              stream,
                              key: "reopen:control:r",
                              fact: { _tag: "RunReopened", step: "a", by: "user", at: "x" },
                            },
                          ]);
                        }),
                  ),
                ),
            });
          }),
        ).pipe(Layer.provide(Journal.layerMemory)),
      );
      const runsDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "wf-prepare-"));
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => NodeFS.rmSync(runsDir, { recursive: true })),
      );
      const { facts, owner } = yield* Effect.gen(function* () {
        const journal = yield* Journal.Journal;
        yield* journal.append(ownerRun(ended));
        const interpreter = yield* WorkflowInterpreter;
        const facts = yield* interpreter.execute(RUN_ID, intent);
        return { facts, owner: yield* journal.read(runStream("wfr_00000000000000000777")) };
      }).pipe(Effect.provide(layer({ runsDir }).pipe(Layer.provideMerge(executors))));
      return { calls, facts, owner };
    }).pipe(Effect.scoped);

  itEffect.effect("takes over a branch whose owner run ended", () =>
    Effect.gen(function* () {
      const { calls, facts, owner } = yield* takeOver(true);
      expect(calls).toEqual(["release wfr_00000000000000000777"]);
      expect(owner.at(-1)?.fact).toEqual({ _tag: "BranchReleased", branch: "wf/demo", to: RUN_ID });
      expect(facts[0]?.fact).toMatchObject({ _tag: "WorkspaceReady", headSha: "fresh" });
    }),
  );

  itEffect.effect("releases nothing when the owner reopens between the check and the record", () =>
    Effect.gen(function* () {
      const { calls, facts, owner } = yield* takeOver(true, true);
      expect(calls).toEqual([]);
      expect(facts[0]?.fact).toMatchObject({ _tag: "IntentFailed", retryable: false });
      expect(owner.map((f) => f.fact._tag)).not.toContain("BranchReleased");
    }),
  );

  itEffect.effect("refuses a branch whose owner run is still running", () =>
    Effect.gen(function* () {
      const { calls, facts } = yield* takeOver(false);
      expect(calls).toEqual([]);
      expect(facts[0]?.fact).toMatchObject({ _tag: "IntentFailed", retryable: false });
    }),
  );
});

describe("bot binding", () => {
  itEffect.effect("a deleted bot leaves the step without its tools and warns the run once", () =>
    Effect.gen(function* () {
      const unused = () => Effect.die("not used by bot binding");
      const posts: string[] = [];
      const executors = Layer.mergeAll(
        Layer.succeed(
          WorkflowTurns,
          WorkflowTurns.of({
            start: (_runId, intent) => Effect.succeed(intent.threadId),
            observe: () => Stream.die("not used by bot binding"),
            interrupt: unused,
            answer: unused,
          }),
        ),
        Layer.succeed(
          WorkflowUnits,
          WorkflowUnits.of({ start: unused, observe: unused, started: unused, stop: unused }),
        ),
        Layer.succeed(
          WorkflowGit,
          WorkflowGit.of({
            prepare: unused,
            head: unused,
            tree: unused,
            advance: unused,
            mergeLocal: unused,
            remove: unused,
            release: unused,
            resolveRef: unused,
          }),
        ),
        Layer.succeed(ProjectService, ProjectService.of({} as ProjectService["Service"])),
        Layer.succeed(
          WorkflowBotPosts,
          WorkflowBotPosts.of({
            exists: (botId) => Effect.succeed(botId === "b_live"),
            post: (input) =>
              Effect.sync(() => {
                if (input.botId !== "b_live") return null;
                posts.push(input.report);
                return "bot:b_live:3";
              }),
          }),
        ),
        Journal.layerMemory,
      );
      const turn = (bot: string): Intent => ({
        _tag: "StartTurn",
        key: `turn:${bot}@1`,
        step: bot,
        attempt: 1,
        threadId: `wf:${bot}`,
        mode: "new",
        projectRef: "t3code",
        title: "look",
        workspace: { name: "integ", path: "/runs/integ" },
        prompt: "Look",
        model: { provider: "claude", model: "claude-haiku-5-5" },
        access: "read",
        reservation: 0,
        bot,
      });
      const post = (botId: string): Intent => ({
        _tag: "PostToBot",
        key: `post:${botId}`,
        step: "done",
        botId,
        workflowTitle: "Heartbeat",
        report: "BTC -8%",
      });
      yield* Effect.gen(function* () {
        const interpreter = yield* WorkflowInterpreter;
        const tags = (facts: ReadonlyArray<{ readonly key: string; readonly fact: Fact }>) =>
          facts.map((f) => [f.key, f.fact._tag === "BotPosted" ? f.fact.threadId : f.fact._tag]);
        expect(tags(yield* interpreter.execute(RUN_ID, turn("b_live")))).toEqual([
          ["result:turn:b_live@1", "TurnStarted"],
        ]);
        expect(tags(yield* interpreter.execute(RUN_ID, turn("b_gone")))).toEqual([
          ["warn:bot-missing:b_gone", "RunWarned"],
          ["result:turn:b_gone@1", "TurnStarted"],
        ]);
        expect(tags(yield* interpreter.execute(RUN_ID, post("b_gone")))).toEqual([
          ["warn:bot-missing:b_gone", "RunWarned"],
          ["result:post:b_gone", null],
        ]);
        expect(tags(yield* interpreter.execute(RUN_ID, post("b_live")))).toEqual([
          ["result:post:b_live", "bot:b_live:3"],
        ]);
        expect(posts).toEqual(["BTC -8%"]);
      }).pipe(Effect.provide(layer({ runsDir: "/runs" }).pipe(Layer.provideMerge(executors))));
    }).pipe(Effect.scoped),
  );
});

describe("resource slots", () => {
  /**
   * Fake turns that wait for the test to end them, real slot holders (a fake systemd that runs
   * wfSlot as processes, so they outlive an interpreter) on flock files in a temporary directory.
   */
  const slotRig = Effect.gen(function* () {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "wf-slots-"));
    yield* Effect.addFinalizer(() => Effect.sync(() => NodeFS.rmSync(dir, { recursive: true })));
    const systemd = yield* Effect.acquireDisposable(Effect.sync(fakeSystemd));
    const unused = () => Effect.die("not used by slots");
    const starts = yield* Queue.unbounded<string>();
    const ends = new Map<string, Deferred.Deferred<void>>();
    const state = {
      active: 0,
      most: 0,
      prompts: new Map<string, string>(),
      /** Whether the turn's slot was in the journal when the turn launched. */
      recordedAtLaunch: new Map<string, boolean>(),
      journal: undefined as Journal.Journal["Service"] | undefined,
    };
    const executors = Layer.mergeAll(
      Layer.succeed(
        WorkflowTurns,
        WorkflowTurns.of({
          start: (runId, intent) =>
            Effect.gen(function* () {
              const recorded = yield* state.journal!.get(runStream(runId), `slot:${intent.key}`);
              state.recordedAtLaunch.set(intent.threadId, Option.isSome(recorded));
              state.active++;
              state.most = Math.max(state.most, state.active);
              state.prompts.set(intent.threadId, intent.prompt);
              ends.set(intent.threadId, yield* Deferred.make<void>());
              yield* Queue.offer(starts, intent.threadId);
              return intent.threadId;
            }).pipe(Effect.orDie),
          observe: (_runId, intent) =>
            Stream.fromEffectDrain(
              Deferred.await(ends.get(intent.threadId)!).pipe(
                Effect.andThen(Effect.sync(() => void state.active--)),
              ),
            ),
          interrupt: () => Effect.void,
          answer: unused,
        }),
      ),
      Layer.succeed(
        WorkflowUnits,
        WorkflowUnits.of({ start: unused, observe: unused, started: unused, stop: unused }),
      ),
      Layer.succeed(
        WorkflowGit,
        WorkflowGit.of({
          prepare: unused,
          head: unused,
          tree: unused,
          advance: unused,
          mergeLocal: unused,
          remove: unused,
          release: unused,
          resolveRef: unused,
        }),
      ),
      Layer.succeed(ProjectService, ProjectService.of({} as ProjectService["Service"])),
      Layer.succeed(
        WorkflowSlots,
        makeSlots({
          node: process.execPath,
          wfSlotPath: NodePath.join(import.meta.dirname, "wfSlot.ts"),
          slotsDir: NodePath.join(dir, "slots"),
          run: systemd.run,
        }),
      ),
      Journal.layerMemory,
    );
    const turn = (item: number, slots: number): Extract<Intent, { _tag: "StartTurn" }> => ({
      _tag: "StartTurn",
      key: `turn:fleet[${item}]/verify@1`,
      step: `fleet[${item}]/verify`,
      attempt: 1,
      threadId: `wfi:x:${item}`,
      mode: "new",
      projectRef: "moneria-api",
      title: "verify",
      workspace: { name: `ticket#fleet[${item}]`, path: `/runs/ticket-${item}` },
      prompt: "Verify",
      model: { provider: "claude", model: "claude-opus-5-5" },
      access: "write",
      reservation: 0,
      uses: { resource: "moneria-verify", slots },
    });
    /** Every slot of moneria-verify can be locked by this process right now. */
    const free = (slot: number) => {
      const fd = tryLock(slotFile(NodePath.join(dir, "slots"), "moneria-verify", slot));
      if (fd !== null) NodeFS.closeSync(fd);
      return fd !== null;
    };
    /** An interpreter as a server (re)start builds it; units and the journal outlive it. */
    const interpreter = make({ runsDir: NodePath.join(dir, "runs") });
    return { dir, systemd, starts, ends, state, executors, turn, free, interpreter };
  });
  /** The holder unit name of a turn, as the interpreter derives it. */
  const holderOf = (key: string) => `wf-slot-${keyHash(RUN_ID, `slot:${key}`)}`;

  itEffect.live(
    "four agent turns on two slots run two at a time, and an abandoned start frees its slot",
    () =>
      Effect.gen(function* () {
        const rig = yield* slotRig;
        yield* Effect.gen(function* () {
          rig.state.journal = yield* Journal.Journal;
          const interpreter = yield* rig.interpreter;
          const phase = (intent: Intent) =>
            interpreter
              .execute(RUN_ID, intent)
              .pipe(
                Effect.tap(() =>
                  interpreter
                    .observe(RUN_ID, intent, { _tag: "TurnStarted", threadId: "unused" })
                    .pipe(Stream.runDrain),
                ),
              );
          const fibers = yield* Effect.forEach([0, 1, 2, 3], (item) =>
            Effect.forkChild(phase(rig.turn(item, 2))),
          );
          for (let round = 0; round < 2; round++) {
            const running = [yield* Queue.take(rig.starts), yield* Queue.take(rig.starts)];
            expect(rig.state.active).toBe(2);
            for (const threadId of running)
              yield* Deferred.succeed(rig.ends.get(threadId)!, undefined);
          }
          yield* Effect.forEach(fibers, Fiber.join);
          expect(rig.state.most).toBe(2);
          // The agent learns which slot it holds, for per-slot state such as a compose project.
          expect(
            [...rig.state.prompts.values()].every((p) =>
              /This turn holds slot [01] of the resource moneria-verify \(WF_SLOT=[01]\)/.test(p),
            ),
          ).toBe(true);
          expect(rig.free(0) && rig.free(1)).toBe(true);

          const abandoned = rig.turn(4, 2);
          yield* interpreter.execute(RUN_ID, abandoned);
          expect(rig.free(0) && rig.free(1)).toBe(false);
          yield* interpreter.abandon(RUN_ID, abandoned);
          expect(rig.free(0) && rig.free(1)).toBe(true);
        }).pipe(Effect.provide(rig.executors));
      }).pipe(Effect.scoped),
  );

  itEffect.live("a restart with a turn still running gives its slot to no other step", () =>
    Effect.gen(function* () {
      const rig = yield* slotRig;
      yield* Effect.gen(function* () {
        rig.state.journal = yield* Journal.Journal;
        const running = rig.turn(0, 1);
        const before = yield* rig.interpreter;
        yield* before.execute(RUN_ID, running);
        expect(yield* Queue.take(rig.starts)).toBe(running.threadId);

        // The server restarts: a new interpreter, while the turn and its holder unit go on.
        const after = yield* rig.interpreter;
        const observed = yield* Effect.forkChild(
          after
            .observe(RUN_ID, running, { _tag: "TurnStarted", threadId: running.threadId })
            .pipe(Stream.runDrain),
        );
        const next = rig.turn(1, 1);
        const waiting = yield* Effect.forkChild(after.execute(RUN_ID, next));
        yield* Effect.promise(() => rig.systemd.started(holderOf(next.key)));
        expect(rig.systemd.live()).toEqual([holderOf(running.key), holderOf(next.key)]);
        expect(rig.free(0)).toBe(false);
        expect([...rig.state.prompts.keys()]).toEqual([running.threadId]);

        yield* Deferred.succeed(rig.ends.get(running.threadId)!, undefined);
        yield* Fiber.join(observed);
        yield* Fiber.join(waiting);
        expect(rig.state.most).toBe(1);
        expect(rig.state.prompts.get(next.threadId)).toContain("WF_SLOT=0");
      }).pipe(Effect.provide(rig.executors));
    }).pipe(Effect.scoped),
  );

  itEffect.live("a replay after a crash before the launch takes the slot it recorded", () =>
    Effect.gen(function* () {
      const rig = yield* slotRig;
      yield* Effect.gen(function* () {
        const journal = yield* Journal.Journal;
        rig.state.journal = journal;
        const interpreter = yield* rig.interpreter;

        // A fresh turn records its slot before it launches.
        const fresh = rig.turn(0, 2);
        yield* interpreter.execute(RUN_ID, fresh);
        expect(rig.state.recordedAtLaunch.get(fresh.threadId)).toBe(true);
        yield* interpreter.abandon(RUN_ID, fresh);

        // The server died after recording slot 1 and before the result: its holder is gone,
        // both slots are free, and the replay must still tell the agent slot 1.
        const replayed = rig.turn(1, 2);
        yield* journal.append([
          {
            stream: runStream(RUN_ID),
            key: `slot:${replayed.key}`,
            fact: {
              _tag: "SlotAcquired",
              step: replayed.step,
              attempt: 1,
              resource: "moneria-verify",
              slot: 1,
              waitedMs: 0,
            },
          },
        ]);
        expect(rig.free(0) && rig.free(1)).toBe(true);
        yield* interpreter.execute(RUN_ID, replayed);
        expect(rig.state.prompts.get(replayed.threadId)).toContain("WF_SLOT=1");
        expect([rig.free(0), rig.free(1)]).toEqual([true, false]);
        yield* interpreter.abandon(RUN_ID, replayed);
      }).pipe(Effect.provide(rig.executors));
    }).pipe(Effect.scoped),
  );
});
