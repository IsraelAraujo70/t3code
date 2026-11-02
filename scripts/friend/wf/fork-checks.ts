#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - workflow CLIs run as plain Node subprocesses.
/** Runs the fork checks after merging upstream, returning every check's verdict. */
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import {
  flag,
  hasFlag,
  HEAVY_SH,
  runCli,
  type ForkChecksOutput,
  type ForkCheckFailure,
  type ForkCheck,
} from "./cli.ts";

const HELP = `Usage: node scripts/friend/wf/fork-checks.ts --json [--no-heavy] [--cwd <checkout>]
--cwd defaults to the checkout containing this script. Output is always JSON.
--no-heavy runs vp directly. Workflow nodes already marked heavy: true hold the heavy.sh
lock for the command's duration; nesting heavy.sh would deadlock on the same flock.
Workflows pass --no-heavy; people running this in a terminal normally omit it.
Exit 0: all three checks ran, including failing verdicts. Exit 1: a check could not start;
no verdict is printed and the reason is written to stderr. --help prints this help.
`;

/** Runs all checks sequentially; launch failures prevent a verdict. */
export function forkChecks(cwd: string, noHeavy = false): ForkChecksOutput {
  const failures: ForkCheckFailure[] = [];
  const output = { seams: true, theme: true, tests: true, failures };
  const tests = [
    "test",
    "run",
    "apps/server/src/bots",
    "apps/web/src/bots",
    "packages/contracts/src/bots.test.ts",
  ];
  const checks: ReadonlyArray<readonly [ForkCheck, string, string[]]> = [
    [
      "seams",
      process.execPath,
      [NodePath.join(cwd, "scripts/friend/check-seams.ts"), "--cwd", cwd],
    ],
    ["theme", process.execPath, [NodePath.join(cwd, "scripts/friend/vscode-theme.ts"), "--check"]],
    ["tests", noHeavy ? "vp" : HEAVY_SH, noHeavy ? tests : ["vp", ...tests]],
  ];
  for (const [check, command, args] of checks) {
    const result = NodeChildProcess.spawnSync(command, args, { cwd, encoding: "utf8" });
    if (result.error) throw result.error;
    if (result.status === null) throw new Error(`${check} terminated by ${result.signal}`);
    output[check] = result.status === 0;
    if (result.status !== 0)
      failures.push({
        check,
        exitCode: result.status,
        output: `${result.stdout}${result.stderr}`.slice(-4000),
      });
  }
  return output;
}

if (import.meta.main) {
  if (hasFlag("--help")) process.stdout.write(HELP);
  else
    await runCli(() =>
      forkChecks(
        NodePath.resolve(flag("--cwd") ?? NodePath.resolve(import.meta.dirname, "../../..")),
        hasFlag("--no-heavy"),
      ),
    );
}
