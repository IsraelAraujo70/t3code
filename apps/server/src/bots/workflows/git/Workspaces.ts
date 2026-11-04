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

import { FORWARDED_HOOKS, forwardingHook, prePushGuard } from "./pushGuard.ts";

export class WorkflowGitError extends Data.TaggedError("WorkflowGitError")<{
  readonly message: string;
  /** The compare-and-swap of `advance` lost: the ref is neither `from` nor `to`. */
  readonly conflict?: boolean;
  /** Retrying cannot help without changing the input or branch ownership. */
  readonly permanent?: boolean;
  /** The branch exists and belongs to this run, or to no workflow run (null). */
  readonly owner?: string | null;
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
     * A worktree of `repoRoot` at `path`: on an owned `branch` or one created from `baseRef`,
     * or detached at `baseRef` when `branch` is null. A worktree already at `path` on the
     * expected branch is adopted; anything else there is removed and rebuilt. Prunes stale worktrees first.
     */
    readonly prepare: (input: {
      readonly repoRoot: string;
      readonly path: string;
      readonly baseRef: string;
      readonly branch: string | null;
      readonly runId: string;
      /**
       * The agent's worktree (`branchPolicy: agent`): detached at `baseRef` when created, adopted
       * on whatever branch the agent moved it to, and guarded by `pushGuard.ts` for this worktree.
       */
      readonly agentBranch?: { readonly protect: ReadonlyArray<string> } | undefined;
    }) => Effect.Effect<PreparedWorktree, WorkflowGitError>;
    /** Gives up an owned branch while retaining its commits and worktrees. */
    readonly release: (input: {
      readonly repoRoot: string;
      readonly branch: string;
      readonly owner: string;
    }) => Effect.Effect<void, WorkflowGitError>;
    /** Resolves a commit without creating a checkout. */
    readonly resolveRef: (input: {
      readonly repoRoot: string;
      readonly ref: string;
    }) => Effect.Effect<string, WorkflowGitError>;
    /** HEAD of a worktree, as a full sha. */
    readonly head: (path: string) => Effect.Effect<string, WorkflowGitError>;
    // wf-engine slice 7: the ledger refuses a tree it already measured.
    readonly tree: (path: string) => Effect.Effect<string, WorkflowGitError>;
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

/**
 * Sets the push guard as this worktree's hooks directory, inside its private git dir so it goes
 * with the worktree. `extensions.worktreeConfig` lets `--worktree` config hold for one worktree;
 * the repository's own hooks directory, read before, stays what every hook forwards to.
 */
const guardPushes = Effect.fn("WorkflowGit.guardPushes")(function* (
  path: string,
  protect: ReadonlyArray<string>,
) {
  const gitDir = yield* git(path, ["rev-parse", "--absolute-git-dir"]);
  const hooks = NodePath.join(gitDir, "t3-push-guard");
  const configured = yield* Effect.forEach(["--local", "--global", "--system"], (scope) =>
    git(path, ["config", scope, "--get", "core.hooksPath"]).pipe(Effect.option),
  );
  const own = configured.find((c) => c._tag === "Some" && c.value !== "");
  const original =
    own?._tag === "Some"
      ? own.value
      : NodePath.resolve(path, yield* git(path, ["rev-parse", "--git-common-dir"]), "hooks");
  yield* Effect.try({
    try: () => {
      NodeFS.mkdirSync(hooks, { recursive: true });
      const write = (name: string, text: string) =>
        NodeFS.writeFileSync(NodePath.join(hooks, name), text, { mode: 0o755 });
      write("pre-push", prePushGuard(protect, original));
      for (const name of FORWARDED_HOOKS) write(name, forwardingHook(name, original));
    },
    catch: (error) => new WorkflowGitError({ message: String(error) }),
  });
  const common = NodePath.resolve(path, yield* git(path, ["rev-parse", "--git-common-dir"]));
  const moved = yield* mainWorktreeKeys(path, common);
  yield* git(path, ["config", "extensions.worktreeConfig", "true"]);
  for (const key of moved)
    yield* git(path, ["config", "--file", NodePath.join(common, "config"), "--unset", key]);
  yield* git(path, ["config", "--worktree", "core.hooksPath", hooks]);
});

/**
 * With `extensions.worktreeConfig` on, a `core.worktree` or `core.bare = true` left in the shared
 * config applies to every worktree (git-worktree(1)), so the agent's would work in the main
 * checkout. Copies them into the main worktree's own `config.worktree` and returns the keys the
 * caller unsets once the extension is on; refuses a value it cannot move as it is.
 */
const mainWorktreeKeys = Effect.fn("WorkflowGit.mainWorktreeKeys")(function* (
  path: string,
  common: string,
) {
  const shared = NodePath.join(common, "config");
  const own = NodePath.join(common, "config.worktree");
  const refuse = (message: string) =>
    new WorkflowGitError({
      message: `branchPolicy agent cannot guard this repository: ${message}`,
      permanent: true,
    });
  const moved: string[] = [];
  for (const key of ["core.worktree", "core.bare"]) {
    const found = yield* git(path, ["config", "--file", shared, "--get-all", key]).pipe(
      Effect.option,
    );
    if (found._tag === "None") continue;
    const values = found.value.split("\n");
    if (values.length > 1) return yield* refuse(`${key} is set more than once in ${shared}`);
    const value = values[0]!;
    if (key === "core.bare" && value !== "true") continue;
    const current = yield* git(path, ["config", "--file", own, "--get", key]).pipe(Effect.option);
    if (current._tag === "Some" && current.value !== value)
      return yield* refuse(`${key} differs between ${shared} and ${own}`);
    if (current._tag === "None") yield* git(path, ["config", "--file", own, key, value]);
    moved.push(key);
  }
  return moved;
});

const head = Effect.fn("WorkflowGit.head")((path: string) => git(path, ["rev-parse", "HEAD"]));
const tree = Effect.fn("WorkflowGit.tree")((path: string) =>
  git(path, ["rev-parse", "HEAD^{tree}"]),
);

const make = Effect.sync(() =>
  WorkflowGit.of({
    head,
    tree,
    prepare: Effect.fn("WorkflowGit.prepare")(function* (input) {
      const { repoRoot, path, branch, baseRef } = input;
      yield* git(repoRoot, ["worktree", "prune"]);
      const entry = yield* worktree(repoRoot, path);
      const expected = branch === null ? "detached" : `branch refs/heads/${branch}`;
      // The agent may have switched its worktree to its own branch: that is its work, kept as is.
      const adopted = input.agentBranch !== undefined && entry !== undefined;
      if (!adopted && !entry?.split("\n").includes(expected)) {
        if (entry) yield* git(repoRoot, ["worktree", "remove", "--force", path]);
        else yield* deleteDirectory(path);
        const exists =
          branch !== null &&
          (yield* git(repoRoot, ["show-ref", "--verify", `refs/heads/${branch}`]).pipe(
            Effect.option,
          ));
        if (branch !== null && exists && exists._tag === "Some") {
          const configured = yield* git(repoRoot, [
            "config",
            "--get",
            `branch.${branch}.wfrun`,
          ]).pipe(Effect.option);
          const owner = configured._tag === "Some" ? configured.value : null;
          if (owner !== input.runId)
            return yield* new WorkflowGitError({
              message: `Branch ${branch} belongs to ${owner ?? "no workflow run"}`,
              permanent: true,
              owner,
            });
          yield* git(repoRoot, ["worktree", "add", path, branch]);
        } else {
          // The owner goes in first: a crash after creating the branch must not leave it ownerless.
          if (branch !== null)
            yield* git(repoRoot, ["config", `branch.${branch}.wfrun`, input.runId]);
          yield* git(
            repoRoot,
            branch === null
              ? ["worktree", "add", "--detach", path, baseRef]
              : ["worktree", "add", "-b", branch, path, baseRef],
          );
        }
      }
      if (input.agentBranch !== undefined) yield* guardPushes(path, input.agentBranch.protect);
      const current =
        input.agentBranch === undefined
          ? branch
          : yield* git(path, ["symbolic-ref", "--quiet", "--short", "HEAD"]).pipe(
              Effect.orElseSucceed(() => null),
            );
      return { path, branch: current === "" ? null : current, headSha: yield* head(path) };
    }),
    resolveRef: Effect.fn("WorkflowGit.resolveRef")(function* ({ repoRoot, ref }) {
      return yield* git(repoRoot, ["rev-parse", "--verify", `${ref}^{commit}`]).pipe(
        Effect.mapError(
          (error) => new WorkflowGitError({ message: error.message, permanent: true }),
        ),
      );
    }),
    release: Effect.fn("WorkflowGit.release")(function* ({ repoRoot, branch, owner }) {
      const exists = yield* git(repoRoot, ["show-ref", "--verify", `refs/heads/${branch}`]).pipe(
        Effect.option,
      );
      if (exists._tag === "None") return;
      const configured = yield* git(repoRoot, ["config", "--get", `branch.${branch}.wfrun`]).pipe(
        Effect.option,
      );
      const actual = configured._tag === "Some" ? configured.value : null;
      if (actual !== owner)
        return yield* new WorkflowGitError({
          message: `Branch ${branch} belongs to ${actual ?? "no workflow run"}`,
          permanent: true,
          owner: actual,
        });
      const listing = yield* git(repoRoot, ["worktree", "list", "--porcelain"]);
      for (const entry of listing.split("\n\n")) {
        const lines = entry.split("\n");
        if (lines.includes(`branch refs/heads/${branch}`))
          yield* git(lines[0]!.slice("worktree ".length), ["switch", "--detach"]);
      }
      yield* git(repoRoot, [
        "update-ref",
        `refs/wf-runs/${owner}/${branch}`,
        `refs/heads/${branch}`,
      ]);
      yield* git(repoRoot, ["branch", "-D", branch]);
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
