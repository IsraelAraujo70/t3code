// @effect-diagnostics nodeBuiltinImport:off - test fixtures drive git and Node CLIs directly.
/**
 * Test fixtures for the workflow CLIs: throwaway git repositories under `~/.cache/friend-tmp`
 * (never `/tmp`, which is tmpfs here, and never the real checkout), removed on dispose.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const FIXTURE_ROOT = NodePath.join(NodeOS.homedir(), ".cache", "friend-tmp", "wf-cli-tests");
const WF_DIR = import.meta.dirname;
const GIT_ENV = {
  GIT_AUTHOR_NAME: "wf test",
  GIT_AUTHOR_EMAIL: "wf@test.invalid",
  GIT_COMMITTER_NAME: "wf test",
  GIT_COMMITTER_EMAIL: "wf@test.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

export interface RunResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** A fixture directory; `using dir = fixtureDir()` removes it when the test ends. */
export function fixtureDir(): { readonly path: string } & Disposable {
  NodeFS.mkdirSync(FIXTURE_ROOT, { recursive: true });
  const path = NodeFS.mkdtempSync(NodePath.join(FIXTURE_ROOT, "case-"));
  return {
    path,
    [Symbol.dispose]: () => NodeFS.rmSync(path, { recursive: true, force: true }),
  };
}

export function run(
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly env?: Readonly<Record<string, string>> },
): RunResult {
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    env: { ...process.env, ...GIT_ENV, ...options.env },
  });
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

/** Runs git in `cwd` with a fixed identity and no user config; throws on failure. */
export function git(cwd: string, ...args: ReadonlyArray<string>): string {
  const result = run("git", args, { cwd });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** A new repository at `path` with one commit on `branch`. */
export function initRepo(path: string, branch = "main"): string {
  NodeFS.mkdirSync(path, { recursive: true });
  git(path, "init", "--quiet", "--initial-branch", branch);
  commitFile(path, "README.md", "fixture\n", "initial");
  return path;
}

/** Writes `file` and commits it; returns the new HEAD. */
export function commitFile(repo: string, file: string, content: string, message: string): string {
  const path = NodePath.join(repo, file);
  NodeFS.mkdirSync(NodePath.dirname(path), { recursive: true });
  NodeFS.writeFileSync(path, content);
  git(repo, "add", file);
  git(repo, "commit", "--quiet", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

/** Runs `scripts/friend/wf/<script>` (or a path relative to it) with Node in `cwd`. */
export function runWfCli(
  script: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly env?: Readonly<Record<string, string>> },
): RunResult {
  return run(process.execPath, [NodePath.join(WF_DIR, script), ...args], options);
}
