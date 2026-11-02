// @effect-diagnostics nodeBuiltinImport:off - fixtures run Node subprocesses.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import { forkChecks } from "./fork-checks.ts";
import { fixtureDir, runWfCli } from "./testRepo.ts";

it("reports every verdict and selects the heavy wrapper", () => {
  using dir = fixtureDir();
  const scripts = NodePath.join(dir.path, "scripts/friend");
  NodeFS.mkdirSync(scripts, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(scripts, "check-seams.ts"),
    'console.log("seams output"); process.exit(Number(process.env.SEAMS_CODE ?? 0));',
  );
  NodeFS.writeFileSync(
    NodePath.join(scripts, "vscode-theme.ts"),
    'console.log("theme output"); if (!process.argv.includes("--check")) process.exit(9);',
  );
  const vp = NodePath.join(dir.path, "vp");
  const heavy = NodePath.join(dir.path, "heavy");
  const args = NodePath.join(dir.path, "args");
  const marker = NodePath.join(dir.path, "marker");
  NodeFS.writeFileSync(
    vp,
    '#!/bin/sh\nprintf "%s\\n" "$@" > "$ARGS"\necho tests output\nexit "${TEST_CODE:-0}"\n',
    { mode: 0o755 },
  );
  NodeFS.writeFileSync(heavy, '#!/bin/sh\ntouch "$MARKER"\nexec "$@"\n', { mode: 0o755 });
  const env = {
    PATH: `${dir.path}:${process.env.PATH}`,
    T3_HEAVY_SH: heavy,
    ARGS: args,
    MARKER: marker,
  };
  const green = runWfCli("fork-checks.ts", ["--json", "--cwd", dir.path], { cwd: dir.path, env });
  expect(green.status).toBe(0);
  expect(JSON.parse(green.stdout)).toEqual({ seams: true, theme: true, tests: true, failures: [] });
  expect(NodeFS.existsSync(marker)).toBe(true);
  expect(NodeFS.readFileSync(args, "utf8").trim().split("\n")).toEqual([
    "test",
    "run",
    "apps/server/src/bots",
    "apps/web/src/bots",
    "packages/contracts/src/bots.test.ts",
  ]);
  NodeFS.unlinkSync(marker);
  const red = runWfCli("fork-checks.ts", ["--no-heavy", "--cwd", dir.path], {
    cwd: dir.path,
    env: { ...env, SEAMS_CODE: "2", TEST_CODE: "3" },
  });
  expect(red.status).toBe(0);
  expect(JSON.parse(red.stdout)).toEqual({
    seams: false,
    theme: true,
    tests: false,
    failures: [
      { check: "seams", exitCode: 2, output: "seams output\n" },
      { check: "tests", exitCode: 3, output: "tests output\n" },
    ],
  });
  expect(NodeFS.existsSync(marker)).toBe(false);
  expect(() => forkChecks(NodePath.join(dir.path, "missing"), true)).toThrow();
});
