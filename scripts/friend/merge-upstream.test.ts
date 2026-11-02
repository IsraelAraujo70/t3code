// @effect-diagnostics nodeBuiltinImport:off - local git fixtures.
import { it, expect } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { fixtureDir, initRepo, commitFile, git, runWfCli } from "./wf/testRepo.ts";

it("merges and replays clean and conflicting worktrees without moving the base", () => {
  for (const conflict of [false, true]) {
    using dir = fixtureDir();
    const upstream = initRepo(NodePath.join(dir.path, "upstream"));
    commitFile(upstream, "arquivo", "initial", "file");
    const fork = NodePath.join(dir.path, "fork");
    git(dir.path, "clone", "--quiet", upstream, fork);
    git(fork, "switch", "-c", "friend/main");
    if (conflict) commitFile(fork, "arquivo", "fork", "fork");
    const base = git(fork, "rev-parse", "friend/main");
    commitFile(upstream, "arquivo", "upstream", "upstream");
    git(upstream, "tag", "v1.2.3");
    const into = NodePath.join(dir.path, "integration");
    git(fork, "worktree", "add", "-b", "wf/merge-v1.2.3", into);
    const args = ["--json", "--into", into, "--remote", upstream, "--tag", "v1.2.3"];
    const first = runWfCli("../merge-upstream.ts", args, { cwd: fork });
    expect(first.status).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({
      status: conflict ? "conflicts" : "merged",
      conflicts: conflict ? ["arquivo"] : [],
    });
    expect(runWfCli("../merge-upstream.ts", args, { cwd: fork }).stdout).toBe(first.stdout);
    expect(git(fork, "rev-parse", "friend/main")).toBe(base);
    const refused = runWfCli(
      "../merge-upstream.ts",
      ["--json", "--into", fork, "--remote", upstream],
      { cwd: fork },
    );
    expect(refused.status).toBe(1);
    expect(refused.stdout).toBe("");
    if (!conflict) {
      NodeFS.writeFileSync(NodePath.join(into, "dirty"), "dirty");
      commitFile(upstream, "next", "next", "next");
      git(upstream, "tag", "v1.2.4");
      const dirty = runWfCli("../merge-upstream.ts", [...args.slice(0, -1), "v1.2.4"], {
        cwd: fork,
      });
      expect(dirty.status).toBe(1);
      expect(dirty.stdout).toBe("");
    }
  }
});

it("keeps the legacy already-contained result inside a fixture", () => {
  using dir = fixtureDir();
  const repo = initRepo(NodePath.join(dir.path, "repo"), "friend/main");
  git(repo, "tag", "v1.2.3");
  const destination = NodePath.join(repo, "scripts/friend");
  NodeFS.mkdirSync(NodePath.join(destination, "wf"), { recursive: true });
  NodeFS.copyFileSync(
    NodePath.join(import.meta.dirname, "merge-upstream.ts"),
    NodePath.join(destination, "merge-upstream.ts"),
  );
  NodeFS.copyFileSync(
    NodePath.join(import.meta.dirname, "wf/cli.ts"),
    NodePath.join(destination, "wf/cli.ts"),
  );
  const result = runWfCli(
    NodePath.relative(
      NodePath.join(import.meta.dirname, "wf"),
      NodePath.join(destination, "merge-upstream.ts"),
    ),
    ["--remote", repo, "--base", "friend/main", "--tag", "v1.2.3"],
    { cwd: repo },
  );
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("already contains");
});
