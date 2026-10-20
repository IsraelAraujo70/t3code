#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - runs without workspace packages, only git and Node.
/**
 * Fails when the fork's edits to upstream files no longer match SEAMS: a hunk dropped or
 * duplicated by a merge, or a new fork edit that was not recorded. Run after every upstream merge.
 *
 *   node scripts/friend/check-seams.ts [--cwd <checkout>]
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import { FORK_MARKER, FORK_OWNED_PREFIXES, SEAMS } from "./seams.ts";

const cwdFlag = NodeProcess.argv.indexOf("--cwd");
const root = NodePath.resolve(
  cwdFlag === -1 ? NodePath.join(import.meta.dirname, "..", "..") : NodeProcess.argv[cwdFlag + 1]!,
);

/** Marker count per tracked file, from `git grep -c` (exit 1 means no match anywhere). */
function markerCounts(): Map<string, number> {
  const result = NodeChildProcess.spawnSync("git", ["grep", "-c", "--fixed-strings", FORK_MARKER], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`git grep failed: ${result.stderr}`);
  }
  const counts = new Map<string, number>();
  for (const line of result.stdout.split("\n")) {
    const separator = line.lastIndexOf(":");
    if (separator === -1) continue;
    counts.set(line.slice(0, separator), Number(line.slice(separator + 1)));
  }
  return counts;
}

const counts = markerCounts();
const problems: string[] = [];
for (const seam of SEAMS) {
  if ("contains" in seam) {
    const path = NodePath.join(root, seam.file);
    const text = NodeFS.existsSync(path) ? NodeFS.readFileSync(path, "utf8") : "";
    if (!text.includes(seam.contains)) {
      problems.push(`${seam.file}: missing ${seam.contains} (${seam.why})`);
    }
    continue;
  }
  const found = counts.get(seam.file) ?? 0;
  if (found !== seam.markers) {
    problems.push(`${seam.file}: expected ${seam.markers} marker(s), found ${found} (${seam.why})`);
  }
}
const listed = new Set(SEAMS.map((seam) => seam.file));
for (const file of counts.keys()) {
  if (listed.has(file)) continue;
  if (FORK_OWNED_PREFIXES.some((prefix) => file.startsWith(prefix))) continue;
  problems.push(`${file}: carries "${FORK_MARKER}" but is not listed in scripts/friend/seams.ts`);
}

if (problems.length > 0) {
  NodeProcess.stderr.write(
    `Fork seams out of sync:\n${problems.map((p) => `  - ${p}`).join("\n")}\n`,
  );
  NodeProcess.exit(1);
}
NodeProcess.stdout.write(`Fork seams OK: ${SEAMS.length} upstream file(s).\n`);
