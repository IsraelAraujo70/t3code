// @effect-diagnostics effectFnIife:off - The fixed contract exposes effects with named method spans.
// @effect-diagnostics nodeBuiltinImport:off - Git blob revisions require synchronous SHA-1.
import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
/**
 * Git of the workflow definitions repository: one `<id>.workflow.yaml` per workflow, local only
 * (no remote). Plain mechanics; the save algorithm, its lock and validation live in
 * `WorkflowDefinitions`. Commits never run hooks and never read the user's git identity.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export class WorkflowRepoError extends Schema.TaggedError<WorkflowRepoError>()(
  "WorkflowRepoError",
  {
    operation: Schema.String,
    path: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Workflow definitions repository: ${this.operation} failed.`;
  }
}

export const WORKFLOW_FILE_SUFFIX = ".workflow.yaml";
export const workflowFileName = (workflowId: string): string =>
  `${workflowId}${WORKFLOW_FILE_SUFFIX}`;

/** The file as it is on disk; `revision` is its git blob sha (`git hash-object`). */
export interface RepoFile {
  readonly text: string;
  readonly revision: string;
}

export interface RepoCommit {
  readonly commit: string;
  /** Blob sha of the workflow file in this commit. */
  readonly revision: string;
  readonly author: string;
  readonly message: string;
  /** ISO 8601 author date. */
  readonly at: string;
}

export interface RepoDeleted {
  readonly workflowId: string;
  /** The last commit that still had the file. */
  readonly commit: string;
  /** ISO date of the commit that removed it. */
  readonly deletedAt: string;
}

export class WorkflowRepo extends Context.Service<
  WorkflowRepo,
  {
    /** Absolute path of the repository. */
    readonly root: string;
    /** Creates the directory and `git init` when missing; safe to run on every start. */
    readonly ensure: Effect.Effect<void, WorkflowRepoError>;
    /** Ids of every `*.workflow.yaml` on disk, sorted. Other files are ignored. */
    readonly listIds: Effect.Effect<ReadonlyArray<string>, WorkflowRepoError>;
    readonly read: (
      workflowId: string,
    ) => Effect.Effect<Option.Option<RepoFile>, WorkflowRepoError>;
    /** The git blob sha of `text`, computed in process. */
    readonly revisionOf: (text: string) => string;
    /** The file's last commit on HEAD, if it was ever committed and still exists there. */
    readonly head: (
      workflowId: string,
    ) => Effect.Effect<Option.Option<RepoCommit>, WorkflowRepoError>;
    /** Writes through a temp file and rename in the same directory. */
    readonly writeAtomic: (
      workflowId: string,
      text: string,
    ) => Effect.Effect<void, WorkflowRepoError>;
    /** Copies `text` to `.overwritten/<id>-<instant>.yaml` (untracked) and returns the path. */
    readonly keepOverwritten: (
      workflowId: string,
      text: string,
    ) => Effect.Effect<string, WorkflowRepoError>;
    /**
     * Stages the file as it is on disk (added, changed or removed) and commits only that path.
     * Returns the new commit, or the current HEAD when the path had nothing to commit.
     */
    readonly commit: (input: {
      readonly workflowId: string;
      readonly author: string;
      readonly message: string;
    }) => Effect.Effect<string, WorkflowRepoError>;
    /** Removes the file from disk and commits the removal. */
    readonly remove: (input: {
      readonly workflowId: string;
      readonly author: string;
      readonly message: string;
    }) => Effect.Effect<string, WorkflowRepoError>;
    /** Newest first. */
    readonly log: (
      workflowId: string,
      page: { readonly skip: number; readonly limit: number },
    ) => Effect.Effect<ReadonlyArray<RepoCommit>, WorkflowRepoError>;
    /** The file's text at `commit`. */
    readonly show: (
      workflowId: string,
      commit: string,
    ) => Effect.Effect<Option.Option<string>, WorkflowRepoError>;
    /** Workflows whose file was removed on HEAD's history and is not on disk now, newest first. */
    readonly deleted: Effect.Effect<ReadonlyArray<RepoDeleted>, WorkflowRepoError>;
    /** Ids whose file on disk differs from HEAD (modified, untracked or removed by hand). */
    readonly dirtyIds: Effect.Effect<ReadonlyArray<string>, WorkflowRepoError>;
  }
>()("t3/bots/workflows/definitions/WorkflowRepo") {}

const make = Effect.fn("WorkflowRepo.make")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const wrap = <A, E, R>(operation: string, effect: Effect.Effect<A, E, R>, file = root) =>
    effect.pipe(
      Effect.mapError((cause) => new WorkflowRepoError({ operation, path: file, cause })),
    );
  const git = Effect.fn("WorkflowRepo.git")(function* (
    args: ReadonlyArray<string>,
    author = "T3 Workflows",
  ) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const child = yield* spawner.spawn(
          ChildProcess.make(
            "git",
            ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
            {
              cwd: root,
              env: {
                GIT_AUTHOR_NAME: author,
                GIT_AUTHOR_EMAIL: "workflows@t3.local",
                GIT_COMMITTER_NAME: "T3 Workflows",
                GIT_COMMITTER_EMAIL: "workflows@t3.local",
                GIT_CONFIG_NOSYSTEM: "1",
                GIT_CONFIG_GLOBAL: "/dev/null",
              },
            },
          ),
        );
        const [stdout, stderr, code] = yield* Effect.all(
          [Stream.runCollect(child.stdout), Stream.runCollect(child.stderr), child.exitCode],
          { concurrency: "unbounded" },
        );
        if (Number(code) !== 0) return yield* Effect.fail({ code, stderr });
        return Buffer.concat(Array.from(stdout)).toString("utf8");
      }),
    );
  });
  const revisionOf = (text: string) =>
    NodeCrypto.createHash("sha1")
      .update(`blob ${Buffer.byteLength(text)}\0`)
      .update(text)
      .digest("hex");
  const show = Effect.fn("WorkflowRepo.show")((id: string, commit: string) =>
    wrap(
      "show",
      Effect.gen(function* () {
        const spec = `${commit}:${workflowFileName(id)}`;
        const exists = yield* git(["cat-file", "-e", spec]).pipe(Effect.option);
        if (Option.isNone(exists)) return Option.none<string>();
        return Option.some(yield* git(["show", spec]));
      }),
    ),
  );
  const log = Effect.fn("WorkflowRepo.log")(
    (id: string, page: { readonly skip: number; readonly limit: number }) =>
      wrap(
        "log",
        Effect.gen(function* () {
          const commits = (yield* git(["log", "--format=%H", "--", workflowFileName(id)]))
            .trim()
            .split("\n")
            .filter(Boolean);
          const result: RepoCommit[] = [];
          for (const commit of commits) {
            const text = yield* show(id, commit);
            if (Option.isNone(text)) continue;
            const metadata = (yield* git([
              "show",
              "-s",
              "--format=%an%x00%aI%x00%B",
              commit,
            ])).split("\0");
            result.push({
              commit,
              revision: revisionOf(text.value),
              author: metadata[0] ?? "",
              at: metadata[1] ?? "",
              message: (metadata[2] ?? "").trimEnd(),
            });
          }
          return result.slice(page.skip, page.skip + page.limit);
        }),
      ),
  );
  const commit = Effect.fn("WorkflowRepo.commit")(
    (input: { readonly workflowId: string; readonly author: string; readonly message: string }) =>
      wrap(
        "commit",
        Effect.gen(function* () {
          const file = workflowFileName(input.workflowId);
          yield* git(["add", "-A", "--", file]);
          const diff = yield* git(["diff", "--cached", "--name-only", "--", file]);
          if (diff.trim())
            yield* git(
              [
                "commit",
                "-m",
                input.message,
                "--author",
                `${input.author} <workflows@t3.local>`,
                "--",
                file,
              ],
              input.author,
            );
          return (yield* git(["rev-parse", "HEAD"])).trim();
        }),
      ),
  );
  const listIds = Effect.fn("WorkflowRepo.listIds")(() =>
    wrap(
      "listIds",
      Effect.gen(function* () {
        const names = yield* fs.readDirectory(root);
        const ids: string[] = [];
        for (const name of names) {
          if (
            name.endsWith(WORKFLOW_FILE_SUFFIX) &&
            (yield* fs.stat(path.join(root, name))).type === "File"
          )
            ids.push(name.slice(0, -WORKFLOW_FILE_SUFFIX.length));
        }
        return ids.sort();
      }),
    ),
  );
  return WorkflowRepo.of({
    root,
    revisionOf,
    show,
    log,
    commit,
    ensure: Effect.fn("WorkflowRepo.ensure")(() =>
      wrap(
        "ensure",
        Effect.gen(function* () {
          yield* fs.makeDirectory(root, { recursive: true });
          if (!(yield* fs.exists(path.join(root, ".git")))) yield* git(["init", "-b", "main"]);
          if (!(yield* fs.exists(path.join(root, ".gitignore"))))
            yield* fs.writeFileString(path.join(root, ".gitignore"), ".overwritten/\n");
          if (Option.isNone(yield* git(["rev-parse", "--verify", "HEAD"]).pipe(Effect.option))) {
            yield* git(["add", "--", ".gitignore"]);
            yield* git(["commit", "-m", "Initialize workflow definitions", "--", ".gitignore"]);
          }
        }),
      ),
    )(),
    listIds: listIds(),
    read: Effect.fn("WorkflowRepo.read")((id: string) =>
      wrap(
        "read",
        Effect.gen(function* () {
          const file = path.join(root, workflowFileName(id));
          if (!(yield* fs.exists(file))) return Option.none<RepoFile>();
          const text = yield* fs.readFileString(file);
          return Option.some({ text, revision: revisionOf(text) });
        }),
      ),
    ),
    head: Effect.fn("WorkflowRepo.head")((id: string) =>
      wrap(
        "head",
        Effect.gen(function* () {
          if (Option.isNone(yield* show(id, "HEAD"))) return Option.none<RepoCommit>();
          return Option.fromUndefinedOr((yield* log(id, { skip: 0, limit: 1 }))[0]);
        }),
      ),
    ),
    writeAtomic: Effect.fn("WorkflowRepo.writeAtomic")((id: string, text: string) =>
      wrap(
        "writeAtomic",
        Effect.gen(function* () {
          const file = path.join(root, workflowFileName(id));
          const temp = path.join(root, `.${workflowFileName(id)}.tmp-${NodeCrypto.randomUUID()}`);
          yield* fs.writeFileString(temp, text);
          yield* fs.rename(temp, file);
        }),
      ),
    ),
    keepOverwritten: Effect.fn("WorkflowRepo.keepOverwritten")((id: string, text: string) =>
      wrap(
        "keepOverwritten",
        Effect.gen(function* () {
          const directory = path.join(root, ".overwritten");
          yield* fs.makeDirectory(directory, { recursive: true });
          const file = path.join(
            directory,
            `${id}-${DateTime.formatIso(yield* DateTime.now).replaceAll(":", "")}.yaml`,
          );
          yield* fs.writeFileString(file, text);
          return file;
        }),
      ),
    ),
    remove: Effect.fn("WorkflowRepo.remove")((input) =>
      wrap(
        "remove",
        Effect.gen(function* () {
          yield* fs.remove(path.join(root, workflowFileName(input.workflowId)), { force: true });
          return yield* commit(input);
        }),
      ),
    ),
    dirtyIds: Effect.fn("WorkflowRepo.dirtyIds")(() =>
      wrap(
        "dirtyIds",
        Effect.gen(function* () {
          const entries = (yield* git([
            "status",
            "--porcelain=v1",
            "-z",
            "--untracked-files=all",
            "--no-renames",
          ])).split("\0");
          return [
            ...new Set(
              entries
                .map((entry) => entry.slice(3))
                .filter((file) => !file.includes("/") && file.endsWith(WORKFLOW_FILE_SUFFIX))
                .map((file) => file.slice(0, -WORKFLOW_FILE_SUFFIX.length)),
            ),
          ].sort();
        }),
      ),
    )(),
    deleted: Effect.fn("WorkflowRepo.deleted")(() =>
      wrap(
        "deleted",
        Effect.gen(function* () {
          const commits = (yield* git(["log", "--diff-filter=D", "--format=%H"]))
            .trim()
            .split("\n")
            .filter(Boolean);
          const result: RepoDeleted[] = [];
          const seen = new Set<string>();
          for (const removal of commits) {
            const files = (yield* git([
              "diff-tree",
              "--no-commit-id",
              "--name-only",
              "-r",
              "--diff-filter=D",
              removal,
            ]))
              .trim()
              .split("\n");
            for (const file of files) {
              if (file.includes("/") || !file.endsWith(WORKFLOW_FILE_SUFFIX)) continue;
              const workflowId = file.slice(0, -WORKFLOW_FILE_SUFFIX.length);
              if (seen.has(workflowId) || (yield* fs.exists(path.join(root, file)))) continue;
              seen.add(workflowId);
              const previous = yield* log(workflowId, { skip: 0, limit: Number.MAX_SAFE_INTEGER });
              const ancestor = (yield* git([
                "log",
                "-1",
                "--format=%H",
                `${removal}^`,
                "--",
                file,
              ])).trim();
              const last = previous.find((entry) => entry.commit === ancestor);
              if (last)
                result.push({
                  workflowId,
                  commit: last.commit,
                  deletedAt: (yield* git(["show", "-s", "--format=%aI", removal])).trim(),
                });
            }
          }
          return result;
        }),
      ),
    )(),
  });
});

export const layer = (root: string) => Layer.effect(WorkflowRepo, make(root));
