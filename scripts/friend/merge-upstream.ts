#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - runs without workspace packages, only git and Node.
/**
 * Conflicts keep the integration worktree for resolution and exit with code 2.
 * The fork main branch is never moved or pushed.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import { UPSTREAM_URL, STABLE_TAG, runCli, type MergeUpstreamOutput } from "./wf/cli.ts";
import { highestStableTag } from "./wf/select-upstream-tag.ts";
const repoRoot = NodePath.join(import.meta.dirname, "..", "..");

function flag(name: string): string | undefined {
  const index = NodeProcess.argv.indexOf(name);
  return index === -1 ? undefined : NodeProcess.argv[index + 1];
}

function git(args: readonly string[], cwd = repoRoot): string {
  return NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function gitStatus(args: readonly string[], cwd = repoRoot): number {
  return NodeChildProcess.spawnSync("git", args, { cwd, stdio: "inherit" }).status ?? 1;
}

/** Highest stable tag by version order; previews and nightlies never match STABLE_TAG. */
function latestStableTag(): string {
  const tags = git(["tag", "--list", "v*", "--sort=-v:refname"]).split("\n");
  const stable = tags.find((tag) => STABLE_TAG.test(tag));
  if (stable === undefined) throw new Error("No stable upstream tag found after fetching.");
  return stable;
}

if (NodeProcess.argv.includes("--help")) {
  NodeProcess.stdout.write(
    "Usage: merge-upstream [--remote <url>] [--base <ref>] [--tag <tag>] [--dir <path>]\n       merge-upstream --json --into <worktree> [--remote <url>] [--base <ref>] [--tag <tag>]\nLegacy: exit 0 success, 2 conflicts, 1 failure. JSON: exit 0 verdict (merged/conflicts), 1 no verdict.\n",
  );
  NodeProcess.exit(0);
}

if (NodeProcess.argv.includes("--json")) {
  await runCli((): MergeUpstreamOutput => {
    const into = flag("--into");
    if (!into) throw new Error("--into is required.");
    const cwd = NodePath.resolve(into);
    const base = flag("--base") ?? "friend/main";
    const branch = git(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd);
    if (branch === base || branch === `heads/${base}` || branch === "main")
      throw new Error("Refusing to merge into the base branch.");
    const remote = flag("--remote") ?? UPSTREAM_URL;
    let tag = flag("--tag");
    if (tag !== undefined && !STABLE_TAG.test(tag)) throw new Error("Not a stable release tag.");
    if (tag === undefined) {
      tag = highestStableTag(git(["ls-remote", "--tags", "--refs", remote], cwd));
      if (!tag) throw new Error("No stable upstream tag found.");
    }
    git(["fetch", "--quiet", "--no-tags", remote, `+refs/tags/${tag}:refs/tags/${tag}`], cwd);
    const target = git(["rev-parse", `${tag}^{commit}`], cwd);
    const conflicts = () =>
      git(["diff", "--name-only", "--diff-filter=U"], cwd).split("\n").filter(Boolean).sort();
    const output = (status: MergeUpstreamOutput["status"]): MergeUpstreamOutput => ({
      status,
      conflicts: status === "conflicts" ? conflicts() : [],
      tag,
      head: git(["rev-parse", "HEAD"], cwd),
    });
    const pending = NodeChildProcess.spawnSync("git", ["rev-parse", "--verify", "MERGE_HEAD"], {
      cwd,
      encoding: "utf8",
    });
    if (pending.status === 0) {
      if (pending.stdout.trim() !== target) throw new Error("Another merge is in progress.");
      return output("conflicts");
    }
    if (
      NodeChildProcess.spawnSync("git", ["merge-base", "--is-ancestor", target, "HEAD"], {
        cwd,
        stdio: "ignore",
      }).status === 0
    )
      return output("merged");
    if (git(["status", "--porcelain"], cwd)) throw new Error("Worktree must be clean.");
    const merged = NodeChildProcess.spawnSync(
      "git",
      ["merge", "--no-ff", "--no-edit", "-m", `Merge upstream ${tag} into ${base}`, tag],
      { cwd, stdio: ["ignore", "ignore", "inherit"] },
    );
    if (merged.status === 0) return output("merged");
    if (conflicts().length > 0) return output("conflicts");
    throw new Error("Git merge failed without conflicts.");
  });
  NodeProcess.exit(process.exitCode ?? 0);
}

const base = flag("--base") ?? "friend/main";
git(["fetch", "--quiet", "--tags", flag("--remote") ?? UPSTREAM_URL]);
const tag = flag("--tag") ?? latestStableTag();
if (!STABLE_TAG.test(tag)) throw new Error(`${tag} is not a stable release tag.`);

const baseSha = git(["rev-parse", base]);
if (gitStatus(["merge-base", "--is-ancestor", tag, baseSha]) === 0) {
  NodeProcess.stdout.write(`${base} already contains ${tag}. Nothing to merge.\n`);
  NodeProcess.exit(0);
}

const branch = `friend/merge-${tag}`;
const dir = NodePath.resolve(
  flag("--dir") ?? NodePath.join(NodeOS.tmpdir(), `t3code-friend-merge-${tag}`),
);
if (NodeFS.existsSync(dir)) throw new Error(`${dir} already exists; remove it or pass --dir.`);
git(["worktree", "add", "-b", branch, dir, baseSha]);
NodeProcess.stdout.write(
  `Integration worktree: ${dir} (${branch} from ${base} ${baseSha.slice(0, 9)})\n`,
);

if (
  gitStatus(
    ["merge", "--no-ff", "--no-edit", "-m", `Merge upstream ${tag} into ${base}`, tag],
    dir,
  ) !== 0
) {
  const conflicts = git(["diff", "--name-only", "--diff-filter=U"], dir);
  NodeProcess.stderr.write(
    `Merge of ${tag} stopped with conflicts in:\n${conflicts}\n` +
      `Resolve them in ${dir}, commit, then run: node scripts/friend/check-seams.ts --cwd ${dir}\n`,
  );
  NodeProcess.exit(2);
}

const seams = NodeChildProcess.spawnSync(
  NodeProcess.execPath,
  [NodePath.join(dir, "scripts", "friend", "check-seams.ts"), "--cwd", dir],
  { stdio: "inherit" },
);
if (seams.status !== 0) NodeProcess.exit(1);
NodeProcess.stdout.write(
  `Merged ${tag}. Next, in ${dir}: vp i and the fork tests (see FORK.md). After review,\n` +
    `fast-forward ${base} from the checkout that has it: git merge --ff-only ${branch}\n`,
);
