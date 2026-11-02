// @effect-diagnostics nodeBuiltinImport:off - execFile preserves exit status and captured output at the injectable process boundary.
import * as NodeChildProcess from "node:child_process";
import { Context, Data, Effect, Layer, Schema } from "effect";

export class WorkflowPublishError extends Data.TaggedError("WorkflowPublishError")<{
  message: string;
  retryable: boolean;
}> {}

export interface PublishCommands {
  readonly run: (
    cwd: string,
    argv: ReadonlyArray<string>,
  ) => Effect.Effect<
    {
      exitCode: number;
      stdout: string;
      stderr: string;
    },
    WorkflowPublishError
  >;
}

export interface PublishInput {
  readonly path: string;
  readonly branch: string;
  readonly sha: string;
  readonly base: string;
  readonly title: string;
  readonly body: string;
}

export class WorkflowPullRequests extends Context.Service<
  WorkflowPullRequests,
  {
    readonly open: (input: PublishInput) => Effect.Effect<{ url: string }, WorkflowPublishError>;
  }
>()("t3/bots/workflows/publish/PullRequests/WorkflowPullRequests") {}

const decodePrs = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ url: Schema.String }))),
);

/** Builds publication with an injectable process boundary. */
export const make = (commands: PublishCommands) =>
  WorkflowPullRequests.of({
    open: Effect.fn("WorkflowPullRequests.open")(function* (input) {
      if (!/^wf\/[A-Za-z0-9._/-]{1,120}$/.test(input.branch) || !/^[0-9a-f]{40}$/.test(input.sha)) {
        return yield* new WorkflowPublishError({
          message: "Invalid workflow branch or sha",
          retryable: false,
        });
      }
      const push = yield* commands.run(input.path, [
        "git",
        "-C",
        input.path,
        "push",
        "origin",
        `${input.sha}:refs/heads/${input.branch}`,
      ]);
      // A refused push (not a fast-forward) stays refused; a network failure may pass later.
      if (push.exitCode !== 0)
        return yield* new WorkflowPublishError({
          message: push.stderr || push.stdout,
          retryable: !/\[rejected\]|non-fast-forward|fetch first/.test(push.stderr),
        });
      const list = yield* commands.run(input.path, [
        "gh",
        "pr",
        "list",
        "--head",
        input.branch,
        "--state",
        "open",
        "--json",
        "url",
        "--limit",
        "1",
      ]);
      if (list.exitCode !== 0)
        return yield* new WorkflowPublishError({
          message: list.stderr || list.stdout,
          retryable: true,
        });
      const prs = yield* decodePrs(list.stdout).pipe(
        Effect.mapError(
          () => new WorkflowPublishError({ message: "Invalid PR list response", retryable: true }),
        ),
      );
      if (prs[0]) return { url: prs[0].url };
      const created = yield* commands.run(input.path, [
        "gh",
        "pr",
        "create",
        "--draft",
        "--base",
        input.base,
        "--head",
        input.branch,
        "--title",
        input.title,
        "--body",
        input.body,
      ]);
      if (created.exitCode !== 0 || !created.stdout.trim())
        return yield* new WorkflowPublishError({
          message: created.stderr || "Missing PR URL",
          retryable: true,
        });
      return { url: created.stdout.trim() };
    }),
  });

/** Runs argv directly, without a shell. */
export const liveCommands: PublishCommands = {
  run: Effect.fn("PublishCommands.run")((cwd, argv) =>
    Effect.tryPromise({
      try: (signal) =>
        new Promise<{ exitCode: number; stdout: string; stderr: string }>((resolve, reject) => {
          const [command, ...args] = argv;
          if (!command) return reject(new Error("Missing command"));
          NodeChildProcess.execFile(command, args, { cwd, signal }, (error, stdout, stderr) => {
            if (error && typeof error.code !== "number") return reject(error);
            resolve({ exitCode: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
          });
        }),
      catch: (error) => new WorkflowPublishError({ message: String(error), retryable: true }),
    }),
  ),
};

export const layer = Layer.succeed(WorkflowPullRequests, make(liveCommands));
