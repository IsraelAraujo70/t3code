// @effect-diagnostics nodeBuiltinImport:off - tests create isolated temporary git repositories.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { WorkflowGit, layer } from "./Workspaces.ts";

it.effect("prepares, adopts, merges, advances and removes isolated worktrees", () =>
  Effect.gen(function* () {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "wf-git-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true })),
    );
    const repo = NodePath.join(root, "repo");
    NodeFS.mkdirSync(repo);
    const git = (...args: string[]) =>
      NodeChildProcess.execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
    git("init");
    git("config", "user.name", "Test");
    git("config", "user.email", "test@t3.invalid");
    git("commit", "--allow-empty", "-m", "base");
    const base = git("rev-parse", "HEAD");
    const service = yield* WorkflowGit;
    const path = NodePath.join(root, "work");
    NodeFS.mkdirSync(path);
    NodeFS.writeFileSync(NodePath.join(path, "junk"), "junk");
    const input = { repoRoot: repo, path, baseRef: base, branch: "work", runId: "r1" };
    expect((yield* service.prepare(input)).headSha).toBe(base);
    NodeChildProcess.execFileSync("git", ["-C", path, "commit", "--allow-empty", "-m", "next"]);
    const next = yield* service.head(path);
    expect((yield* service.prepare(input)).headSha).toBe(next);
    const merged = yield* service.mergeLocal({ path: repo, from: next, expectHead: base });
    expect(yield* service.mergeLocal({ path: repo, from: next, expectHead: base })).toBe(merged);
    git("branch", "advance", base);
    expect(
      yield* service.advance({ repoRoot: repo, branch: "advance", from: base, to: next }),
    ).toBe(next);
    expect(
      yield* service.advance({ repoRoot: repo, branch: "advance", from: base, to: next }),
    ).toBe(next);
    const stale = yield* service
      .advance({ repoRoot: repo, branch: "advance", from: base, to: merged })
      .pipe(Effect.flip);
    expect(stale.conflict).toBe(true);
    yield* service.remove({ repoRoot: repo, path });
    yield* service.remove({ repoRoot: repo, path });
    expect(NodeFS.existsSync(path)).toBe(false);
    expect((yield* service.prepare({ ...input, branch: null })).headSha).toBe(base);
    yield* service.remove({ repoRoot: repo, path });
    // The branch survives its worktree; a new run on it would start from the old head.
    const refused = yield* service.prepare({ ...input, runId: "r2" }).pipe(Effect.flip);
    expect(refused.permanent).toBe(true);
    expect(refused.owner).toBe("r1");
    expect(git("config", "--get", "branch.work.wfrun")).toBe("r1");
    expect((yield* service.prepare(input)).headSha).toBe(next);
    NodeFS.writeFileSync(NodePath.join(path, "retained"), "intact");
    expect(
      (yield* service.release({ repoRoot: repo, branch: "work", owner: "r2" }).pipe(Effect.flip))
        .permanent,
    ).toBe(true);
    yield* service.release({ repoRoot: repo, branch: "work", owner: "r1" });
    yield* service.release({ repoRoot: repo, branch: "work", owner: "r1" });
    expect(yield* service.head(path)).toBe(next);
    expect(NodeFS.readFileSync(NodePath.join(path, "retained"), "utf8")).toBe("intact");
    expect(
      NodeChildProcess.execFileSync("git", ["-C", path, "rev-parse", "--abbrev-ref", "HEAD"], {
        encoding: "utf8",
      }).trim(),
    ).toBe("HEAD");
    expect(git("rev-parse", "refs/wf-runs/r1/work")).toBe(next);
    yield* service.remove({ repoRoot: repo, path });
    expect((yield* service.prepare({ ...input, runId: "r2" })).headSha).toBe(base);
    yield* service.remove({ repoRoot: repo, path });
    git("branch", "manual", base);
    expect((yield* service.prepare({ ...input, branch: "manual" }).pipe(Effect.flip)).owner).toBe(
      null,
    );
    expect(yield* service.resolveRef({ repoRoot: repo, ref: "HEAD" })).toBe(merged);
    expect(yield* service.resolveRef({ repoRoot: repo, ref: "work" })).toBe(base);
    expect(
      (yield* service.resolveRef({ repoRoot: repo, ref: "unknown" }).pipe(Effect.flip)).permanent,
    ).toBe(true);
    const badBase = yield* service
      .prepare({ ...input, branch: "work-bad", baseRef: "no-such-ref" })
      .pipe(Effect.flip);
    expect(badBase.permanent).toBe(true);
    expect((yield* service.prepare({ ...input, branch: "work-2", baseRef: next })).headSha).toBe(
      next,
    );
    git("checkout", "-b", "conflicting", base);
    NodeFS.writeFileSync(NodePath.join(repo, "collision"), "other");
    git("add", "collision");
    git("commit", "-m", "other");
    const other = git("rev-parse", "HEAD");
    NodeFS.writeFileSync(NodePath.join(path, "collision"), "local");
    NodeChildProcess.execFileSync("git", ["-C", path, "add", "collision"]);
    NodeChildProcess.execFileSync("git", ["-C", path, "commit", "-m", "local"]);
    const conflict = yield* service
      .mergeLocal({ path, from: other, expectHead: yield* service.head(path) })
      .pipe(Effect.flip);
    expect(conflict.conflict).toBe(true);
    const mergePath = NodeChildProcess.execFileSync(
      "git",
      ["-C", path, "rev-parse", "--git-path", "MERGE_HEAD"],
      { encoding: "utf8" },
    ).trim();
    expect(NodeFS.existsSync(NodePath.resolve(path, mergePath))).toBe(false);
  }).pipe(Effect.provide(layer), Effect.scoped),
);
