// @effect-diagnostics nodeBuiltinImport:off - git subprocesses and host worktree cleanup require Node APIs.
/**
 * The engine's git, on the host: worktrees of a project's repository for the steps, and the few
 * ref moves the engine makes itself. Every operation is idempotent so a replayed intent converges.
 * Hooks are off for every call (`-c core.hooksPath=/dev/null`): the engine never runs repo hooks.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as Layer from "effect/Layer";

import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

export class WorkflowGitError extends Data.TaggedError("WorkflowGitError")<{
  readonly message: string;
  /** The compare-and-swap of `advance` lost: the ref is neither `from` nor `to`. */
  readonly conflict?: boolean;
  /** Retrying cannot help: the branch already exists outside this worktree. */
  readonly permanent?: boolean;
}> {}

export interface PreparedWorktree {
  readonly path: string;
  /** null for a detached worktree. */
  readonly branch: string | null;
  readonly headSha: string;
}

export class WorkflowGit extends Context.Service<
  WorkflowGit,
  {
    /**
     * A worktree of `repoRoot` at `path`: on `branch` created from `baseRef` (a branch that already
     * exists elsewhere is refused), or detached at `baseRef` when `branch` is null. A worktree already at `path` on the
     * expected branch is adopted; anything else there is removed and rebuilt. Prunes stale worktrees first.
     */
    readonly prepare: (input: {
      readonly repoRoot: string;
      readonly path: string;
      readonly baseRef: string;
      readonly branch: string | null;
    }) => Effect.Effect<PreparedWorktree, WorkflowGitError>;
    /** HEAD of a worktree, as a full sha. */
    readonly head: (path: string) => Effect.Effect<string, WorkflowGitError>;
    /**
     * Moves `refs/heads/<branch>` from `from` to `to` (`git update-ref`, compare-and-swap). A ref
     * already at `to` counts as done; any other value fails with `conflict: true`. Returns `to`.
     */
    readonly advance: (input: {
      readonly repoRoot: string;
      readonly branch: string;
      readonly from: string;
      readonly to: string;
    }) => Effect.Effect<string, WorkflowGitError>;
    /**
     * Merges `from` into the worktree's HEAD. Already contained (`merge-base --is-ancestor`) is done;
     * a leftover MERGE_HEAD is aborted first; HEAD other than `expectHead` before merging fails.
     * Returns the new HEAD. A conflict aborts the merge and fails with `conflict: true`.
     */
    readonly mergeLocal: (input: {
      readonly path: string;
      readonly from: string;
      readonly expectHead: string;
    }) => Effect.Effect<string, WorkflowGitError>;
    /** Removes the worktree at `path` and prunes; a worktree already gone counts as removed. */
    readonly remove: (input: {
      readonly repoRoot: string;
      readonly path: string;
    }) => Effect.Effect<void, WorkflowGitError>;
  }
>()("t3/bots/workflows/git/Workspaces/WorkflowGit") {}

const BAD_REVISION =
  /invalid reference|not a valid object name|unknown revision|bad revision|not a valid ref/i;

const git = (path: string, args: ReadonlyArray<string>) =>
  Effect.tryPromise({
    try: () =>
      new Promise<string>((resolve, reject) => {
        NodeChildProcess.execFile(
          "git",
          [
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "advice.detachedHead=false",
            "-C",
            path,
            ...args,
          ],
          { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
          (error, stdout, stderr) =>
            error ? reject(new Error(stderr || error.message)) : resolve(stdout.trim()),
        );
      }),
    catch: (error) =>
      new WorkflowGitError({
        message: String(error),
        // A ref that does not resolve (a bad base or param) fails the same way every time.
        permanent: BAD_REVISION.test(String(error)),
      }),
  });

const worktree = Effect.fn("WorkflowGit.worktree")(function* (repoRoot: string, path: string) {
  const listing = yield* git(repoRoot, ["worktree", "list", "--porcelain"]);
  return listing
    .split("\n\n")
    .find((entry) => entry.split("\n")[0] === `worktree ${NodePath.resolve(path)}`);
});

const deleteDirectory = (path: string) =>
  Effect.try({
    try: () => NodeFS.rmSync(path, { recursive: true, force: true }),
    catch: (error) => new WorkflowGitError({ message: String(error) }),
  });

const head = Effect.fn("WorkflowGit.head")((path: string) => git(path, ["rev-parse", "HEAD"]));

const make = Effect.sync(() =>
  WorkflowGit.of({
    head,
    prepare: Effect.fn("WorkflowGit.prepare")(function* (input) {
      const { repoRoot, path, branch, baseRef } = input;
      yield* git(repoRoot, ["worktree", "prune"]);
      const entry = yield* worktree(repoRoot, path);
      const expected = branch === null ? "detached" : `branch refs/heads/${branch}`;
      if (!entry?.split("\n").includes(expected)) {
        if (entry) yield* git(repoRoot, ["worktree", "remove", "--force", path]);
        else yield* deleteDirectory(path);
        const exists =
          branch !== null &&
          (yield* git(repoRoot, ["show-ref", "--verify", `refs/heads/${branch}`]).pipe(
            Effect.option,
          ));
        // Adopting it would start this run from an earlier run's head, not from baseRef.
        if (exists && exists._tag === "Some") {
          return yield* new WorkflowGitError({
            message: `Branch ${branch} already exists from an earlier run; delete it or name another branch.`,
            permanent: true,
          });
        }
        yield* git(
          repoRoot,
          branch === null
            ? ["worktree", "add", "--detach", path, baseRef]
            : ["worktree", "add", "-b", branch, path, baseRef],
        );
      }
      return { path, branch, headSha: yield* head(path) };
    }),
    advance: Effect.fn("WorkflowGit.advance")(function* ({ repoRoot, branch, from, to }) {
      const ref = `refs/heads/${branch}`;
      if ((yield* git(repoRoot, ["rev-parse", "--verify", ref])) === to) return to;
      yield* git(repoRoot, ["update-ref", ref, to, from]).pipe(
        Effect.mapError(
          (error) => new WorkflowGitError({ message: error.message, conflict: true }),
        ),
      );
      return to;
    }),
    mergeLocal: Effect.fn("WorkflowGit.mergeLocal")(function* ({ path, from, expectHead }) {
      const mergePath = yield* git(path, ["rev-parse", "--git-path", "MERGE_HEAD"]);
      if (NodeFS.existsSync(NodePath.resolve(path, mergePath)))
        yield* git(path, ["merge", "--abort"]);
      const current = yield* head(path);
      const ancestor = yield* git(path, ["merge-base", "--is-ancestor", from, "HEAD"]).pipe(
        Effect.option,
      );
      if (ancestor._tag === "Some") return current;
      if (current !== expectHead)
        return yield* new WorkflowGitError({
          message: "HEAD changed before merge",
          conflict: true,
        });
      yield* git(path, [
        "-c",
        "user.name=t3-workflows",
        "-c",
        "user.email=workflows@t3.invalid",
        "merge",
        "--no-edit",
        "--no-ff",
        from,
      ]).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            yield* git(path, ["merge", "--abort"]).pipe(Effect.option);
            return yield* new WorkflowGitError({ message: error.message, conflict: true });
          }),
        ),
      );
      return yield* head(path);
    }),
    remove: Effect.fn("WorkflowGit.remove")(function* ({ repoRoot, path }) {
      if (yield* worktree(repoRoot, path))
        yield* git(repoRoot, ["worktree", "remove", "--force", path]);
      else yield* deleteDirectory(path);
      yield* git(repoRoot, ["worktree", "prune"]);
    }),
  }),
);

export const layer = Layer.effect(WorkflowGit, make);
