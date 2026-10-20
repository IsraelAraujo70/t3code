#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - runs without workspace packages, only git and Node.
/**
 * Merges the newest stable upstream release (a `vX.Y.Z` tag on pingdotgg/t3code) into a fresh
 * integration worktree branched from the fork's main branch, then checks the fork seams.
 * Nothing is pushed and the fork's main branch is not moved; review the integration branch,
 * run its tests, then fast-forward `friend/main` by hand.
 *
 *   node scripts/friend/merge-upstream.ts [--tag vX.Y.Z] [--base friend/main] [--dir <path>]
 *
 * Exit codes: 0 merged and seams OK, or already up to date; 2 merge conflicts (the worktree is
 * kept for resolution); 1 any other failure, including seam drift after a clean merge.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

const UPSTREAM_URL = "https://github.com/pingdotgg/t3code";
const STABLE_TAG = /^v\d+\.\d+\.\d+$/;
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

const base = flag("--base") ?? "friend/main";
git(["fetch", "--quiet", "--tags", UPSTREAM_URL]);
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
