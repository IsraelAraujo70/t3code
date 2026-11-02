// @effect-diagnostics nodeBuiltinImport:off - test fixtures drive git and Node CLIs directly.
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import { highestStableTag } from "./select-upstream-tag.ts";
import { commitFile, fixtureDir, git, initRepo, runWfCli } from "./testRepo.ts";

it("selects the highest stable tag, peels it and detects containment on repeat runs", () => {
  using dir = fixtureDir();
  const upstream = initRepo(NodePath.join(dir.path, "upstream"));
  git(upstream, "tag", "v0.2.0");
  const tagSha = commitFile(upstream, "release.txt", "release", "release");
  git(upstream, "tag", "-a", "v0.10.0", "-m", "release");
  git(upstream, "tag", "v0.11.0-beta");
  git(upstream, "tag", "nightly-x");
  const fork = NodePath.join(dir.path, "fork");
  git(dir.path, "clone", "--quiet", upstream, fork);
  git(fork, "checkout", "-b", "friend/main", "v0.2.0");
  const args = ["--remote", upstream];
  const first = runWfCli("select-upstream-tag.ts", args, { cwd: fork });
  expect(first.status).toBe(0);
  expect(JSON.parse(first.stdout)).toEqual({ tag: "v0.10.0", tagSha, contained: false });
  expect(git(fork, "rev-parse", "refs/wf/upstream/v0.10.0^{commit}")).toBe(tagSha);
  git(fork, "merge", "--ff-only", tagSha);
  const second = runWfCli("select-upstream-tag.ts", args, { cwd: fork });
  expect(second.status).toBe(0);
  expect(JSON.parse(second.stdout)).toEqual({ tag: "v0.10.0", tagSha, contained: true });
});

it("has no verdict when upstream has no stable tag", () => {
  using dir = fixtureDir();
  const upstream = initRepo(NodePath.join(dir.path, "upstream"));
  git(upstream, "tag", "v0.11.0-beta");
  const fork = initRepo(NodePath.join(dir.path, "fork"), "friend/main");
  const result = runWfCli("select-upstream-tag.ts", ["--remote", upstream], { cwd: fork });
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("no stable tag");
});

it("orders stable tags numerically and ignores previews", () => {
  const refs = ["v0.9.0", "v0.10.0", "v0.10.1-beta", "nightly-v9.0.0", "v0.10.0^{}"]
    .map((tag, index) => `${index}\trefs/tags/${tag}`)
    .join("\n");
  expect(highestStableTag(refs)).toBe("v0.10.0");
  expect(highestStableTag("")).toBeUndefined();
});
