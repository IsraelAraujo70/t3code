#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - workflow CLIs run as plain Node subprocesses.
/**
 * Picks the newest stable upstream tag, fetches it to `refs/wf/upstream/<tag>` and says whether
 * `--base` already contains it (docs/friend/workflows-design.md §11.1):
 *   node scripts/friend/wf/select-upstream-tag.ts [--remote <url>] [--base <ref>]
 */
import * as NodeProcess from "node:process";

import {
  flag,
  git,
  gitStatus,
  hasFlag,
  runCli,
  STABLE_TAG,
  UPSTREAM_URL,
  type SelectUpstreamTagOutput,
} from "./cli.ts";

const HELP = `Usage: node scripts/friend/wf/select-upstream-tag.ts [--remote <url>] [--base <ref>]
Defaults: --remote ${UPSTREAM_URL}, --base friend/main. Writes only refs/wf/upstream/<tag>.
Prints {"tag","tagSha","contained"}; tagSha is the tag's commit. Exit 0: verdict; 1: none (stderr).
`;

/** Highest `vX.Y.Z` tag by numeric version among `git ls-remote --tags` lines. */
export function highestStableTag(lsRemote: string): string | undefined {
  const version = (tag: string) => tag.slice(1).split(".").map(BigInt);
  return lsRemote
    .split("\n")
    .map((line) => line.split("\t")[1]?.replace(/^refs\/tags\//, "") ?? "")
    .filter((tag) => STABLE_TAG.test(tag))
    .reduce<string | undefined>((best, tag) => {
      if (best === undefined) return tag;
      const [a, b] = [version(tag), version(best)];
      for (let index = 0; index < 3; index++) {
        if (a[index]! !== b[index]!) return a[index]! > b[index]! ? tag : best;
      }
      return best;
    }, undefined);
}

function select(cwd: string): SelectUpstreamTagOutput {
  const remote = flag("--remote") ?? UPSTREAM_URL;
  const base = flag("--base") ?? "friend/main";
  const tag = highestStableTag(git(["ls-remote", "--tags", "--refs", remote, "refs/tags/v*"], cwd));
  if (tag === undefined) throw new Error(`${remote} has no stable tag`);
  const ref = `refs/wf/upstream/${tag}`;
  git(["fetch", "--quiet", "--no-tags", remote, `+refs/tags/${tag}:${ref}`], cwd);
  const tagSha = git(["rev-parse", `${ref}^{commit}`], cwd);
  const status = gitStatus(["merge-base", "--is-ancestor", tagSha, base], cwd);
  if (status !== 0 && status !== 1) throw new Error(`Cannot tell whether ${base} contains ${tag}`);
  return { tag, tagSha, contained: status === 0 };
}

if (import.meta.main) {
  if (hasFlag("--help")) NodeProcess.stdout.write(HELP);
  else await runCli(() => select(NodeProcess.cwd()));
}
