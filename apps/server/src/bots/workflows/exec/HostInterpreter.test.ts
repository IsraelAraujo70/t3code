// @effect-diagnostics nodeBuiltinImport:off - the prepare test needs a real directory for runsDir.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { it as itEffect } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
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
import { layer, retryable } from "./HostInterpreter.ts";
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
  // Real holders on flock files in a temporary directory; the turns are fakes the test ends.
  itEffect.live(
    "four agent turns on two slots run two at a time, and an abandoned start frees its slot",
    () =>
      Effect.gen(function* () {
        const slotsDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "wf-slots-"));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(slotsDir, { recursive: true })),
        );
        const unused = () => Effect.die("not used by slots");
        const starts = yield* Queue.unbounded<string>();
        const ends = new Map<string, Deferred.Deferred<void>>();
        let active = 0;
        let most = 0;
        const prompts: string[] = [];
        const executors = Layer.mergeAll(
          Layer.succeed(
            WorkflowTurns,
            WorkflowTurns.of({
              start: (_runId, intent) =>
                Effect.gen(function* () {
                  active++;
                  most = Math.max(most, active);
                  prompts.push(intent.prompt);
                  ends.set(intent.threadId, yield* Deferred.make<void>());
                  yield* Queue.offer(starts, intent.threadId);
                  return intent.threadId;
                }),
              observe: (_runId, intent) =>
                Stream.fromEffectDrain(
                  Deferred.await(ends.get(intent.threadId)!).pipe(
                    Effect.andThen(Effect.sync(() => void active--)),
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
              slotsDir,
            }),
          ),
          Journal.layerMemory,
        );
        const turn = (item: number): Intent => ({
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
          uses: { resource: "moneria-verify", slots: 2 },
        });
        yield* Effect.gen(function* () {
          const interpreter = yield* WorkflowInterpreter;
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
            Effect.forkChild(phase(turn(item))),
          );
          for (let round = 0; round < 2; round++) {
            const running = [yield* Queue.take(starts), yield* Queue.take(starts)];
            expect(active).toBe(2);
            for (const threadId of running) yield* Deferred.succeed(ends.get(threadId)!, undefined);
          }
          const facts = yield* Effect.forEach(fibers, Fiber.join);
          expect(most).toBe(2);
          // The agent learns which slot it holds, for per-slot state such as a compose project.
          expect(
            prompts.every((p) =>
              /This turn holds slot [01] of the resource moneria-verify \(WF_SLOT=[01]\)/.test(p),
            ),
          ).toBe(true);
          expect(facts.map((batch) => batch.map((f) => f.fact._tag))).toEqual(
            Array.from({ length: 4 }, () => ["SlotAcquired", "TurnStarted"]),
          );
          expect(allSlotsFree(slotsDir)).toBe(true);

          const abandoned = turn(4);
          yield* interpreter.execute(RUN_ID, abandoned);
          expect(allSlotsFree(slotsDir)).toBe(false);
          yield* interpreter.abandon(RUN_ID, abandoned);
          expect(allSlotsFree(slotsDir)).toBe(true);
        }).pipe(Effect.provide(layer({ runsDir: "/runs" }).pipe(Layer.provideMerge(executors))));
      }).pipe(Effect.scoped),
  );
});

/** Both slots of moneria-verify can be locked by this process right now. */
const allSlotsFree = (dir: string) =>
  [0, 1].every((slot) => {
    const fd = tryLock(slotFile(dir, "moneria-verify", slot));
    if (fd !== null) NodeFS.closeSync(fd);
    return fd !== null;
  });
