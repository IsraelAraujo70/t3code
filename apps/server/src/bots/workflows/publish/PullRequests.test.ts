// @effect-diagnostics nodeBuiltinImport:off - isolated local git fixtures use synchronous setup and cleanup.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { Effect } from "effect";
import { expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import { liveCommands, make } from "./PullRequests.js";

it.live("publishes the recorded sha, reuses drafts, and refuses divergent pushes", () =>
  Effect.gen(function* () {
    const cache = NodePath.resolve(".cache");
    NodeFS.mkdirSync(cache, { recursive: true });
    const root = NodeFS.mkdtempSync(NodePath.resolve(cache, "publish-test-"));
    const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
    const git = (...args: string[]) =>
      NodeChildProcess.execFileSync(
        "git",
        ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args],
        { env, encoding: "utf8" },
      ).trim();
    try {
      const remote = NodePath.resolve(root, "remote.git");
      const path = NodePath.resolve(root, "clone");
      git("init", "--bare", remote);
      git("clone", remote, path);
      NodeFS.writeFileSync(NodePath.resolve(path, "file"), "one");
      git("-C", path, "add", ".");
      git("-C", path, "commit", "-m", "one");
      const sha = git("-C", path, "rev-parse", "HEAD");
      NodeFS.writeFileSync(NodePath.resolve(path, "file"), "two");
      git("-C", path, "commit", "-am", "two");
      const calls: ReadonlyArray<string>[] = [];
      let exists = false;
      const service = make({
        run: (cwd, argv) => {
          calls.push(argv);
          if (argv[0] === "git") return liveCommands.run(cwd, argv);
          if (argv[2] === "list")
            return Effect.succeed({
              exitCode: 0,
              stdout: exists ? '[{"url":"https://example.invalid/pr/1"}]' : "[]",
              stderr: "",
            });
          exists = true;
          return Effect.succeed({
            exitCode: 0,
            stdout: "https://example.invalid/pr/1\n",
            stderr: "",
          });
        },
      });
      const input = { path, branch: "wf/test", sha, base: "main", title: "Test", body: "Body" };
      expect(yield* service.open(input)).toEqual({ url: "https://example.invalid/pr/1" });
      expect(git("--git-dir", remote, "rev-parse", "refs/heads/wf/test")).toBe(sha);
      yield* service.open(input);
      expect(calls.filter((argv) => argv[2] === "create")).toHaveLength(1);
      expect(calls.find((argv) => argv[2] === "create")).toContain("--draft");
      git("-C", path, "checkout", "--orphan", "divergent");
      git("-C", path, "commit", "-am", "divergent");
      const divergent = git("-C", path, "rev-parse", "HEAD");
      const failure = yield* Effect.flip(service.open({ ...input, sha: divergent }));
      expect(failure.retryable).toBe(false);
      expect(git("--git-dir", remote, "rev-parse", "refs/heads/wf/test")).toBe(sha);
      const count = calls.length;
      yield* Effect.flip(service.open({ ...input, branch: "main" }));
      yield* Effect.flip(service.open({ ...input, sha: "bad" }));
      expect(calls).toHaveLength(count);
      expect(
        calls
          .flat()
          .some((arg) => arg === "merge" || arg.startsWith("--force") || arg.startsWith("+")),
      ).toBe(false);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  }),
);
