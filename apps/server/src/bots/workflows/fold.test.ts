import { describe, expect, it } from "vite-plus/test";
import type { StoredFact } from "./facts.ts";
import { applyRunFact, emptyRunState, foldRun } from "./fold.ts";

const stored = (seq: number, key: string, fact: StoredFact["fact"]): StoredFact => ({
  stream: "run:r",
  seq,
  key,
  fact,
  at: "now",
});

describe("foldRun", () => {
  it("tracks pauses, resumes, iterations and workflow facts without mutating its input", () => {
    const initial = emptyRunState("r");
    const facts = [
      stored(1, "pause:1", { _tag: "RunPaused", reason: "user", detail: "", at: "now" }),
      stored(2, "resume:1", { _tag: "RunResumed", at: "now" }),
      stored(3, "iter:s:2", { _tag: "IterationStarted", step: "s", index: 2 }),
      stored(4, "iter:s:1", { _tag: "IterationStarted", step: "s", index: 1 }),
      stored(5, "outcome:r", { _tag: "RunOutcome", runId: "r", status: "failed" }),
    ];
    const result = foldRun("r", facts);
    expect(result).toEqual(facts.reduce(applyRunFact, initial));
    expect(result).toMatchObject({ lastSeq: 5, paused: null, pauseCount: 1, resumeCount: 1 });
    expect(result.iterations.get("s")).toBe(2);
    expect(initial.iterations.size).toBe(0);
  });

  it("records pending intents, unit results and sorted attempts", () => {
    const intent = (attempt: number) => ({
      _tag: "StartUnit" as const,
      key: `unit:${attempt}`,
      step: "s",
      attempt,
      argv: ["true"],
      cwd: { name: "main", path: "." },
      heavy: false,
      replay: "safe" as const,
      timeoutMs: 100,
      env: {},
    });
    const pending = foldRun("r", [
      stored(1, "unit:2", { _tag: "IntentRecorded", intent: intent(2) }),
    ]);
    const result = [
      stored(2, "result:unit:2", { _tag: "UnitSpawned", unit: "u", at: "now" }),
      stored(3, "unit:1", { _tag: "IntentRecorded", intent: intent(1) }),
      stored(4, "exited:s@2", {
        _tag: "UnitExited",
        step: "s",
        attempt: 2,
        exit: 0,
        signal: null,
        queuedMs: 0,
        out: null,
        tail: "",
        lost: false,
        started: true,
      }),
    ].reduce(applyRunFact, pending);
    expect(pending.intents.get("unit:2")?.result).toBeNull();
    expect(result.attempts.get("s")?.map((entry) => entry.attempt)).toEqual([1, 2]);
    expect(result.attempts.get("s")?.[1]).toMatchObject({
      firstSeq: 1,
      unit: "u",
      exited: { exit: 0 },
    });
  });

  it("takes a workspace's head from the observation folded last, whatever the step order", () => {
    const unit = (step: string) => ({
      _tag: "StartUnit" as const,
      key: `unit:${step}@1`,
      step,
      attempt: 1,
      argv: ["true"],
      cwd: { name: "integ", path: "/w" },
      heavy: false,
      replay: "safe" as const,
      timeoutMs: 100,
      env: {},
    });
    const exited = (step: string, headSha: string) => ({
      _tag: "UnitExited" as const,
      step,
      attempt: 1,
      exit: 0,
      signal: null,
      queuedMs: 0,
      out: null,
      tail: "",
      lost: false,
      started: true,
      headSha,
    });
    const state = foldRun("r", [
      stored(0, "ws:integ", {
        _tag: "IntentRecorded",
        intent: {
          _tag: "PrepareWorkspace",
          key: "ws:integ",
          name: "integ",
          projectRef: "t3code",
          baseRef: "main",
          branch: "wf/x",
        },
      }),
      stored(1, "result:ws:integ", {
        _tag: "WorkspaceReady",
        name: "integ",
        path: "/w",
        branch: "wf/x",
        headSha: "h0",
      }),
      stored(2, "unit:a@1", { _tag: "IntentRecorded", intent: unit("a") }),
      stored(3, "unit:b@1", { _tag: "IntentRecorded", intent: unit("b") }),
      // b settles first; a settles later on top of b's commits.
      stored(4, "exited:b@1", exited("b", "h1")),
      stored(5, "exited:a@1", exited("a", "h2")),
    ]);
    expect(state.workspaces.get("integ")?.headSha).toBe("h2");
  });
});
