import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { expect, it } from "@effect/vitest";

import { admits, tokenBudget } from "./cli.ts";
import { fixtureDir, run } from "./testRepo.ts";

const CLI_MODULE = NodePath.join(import.meta.dirname, "cli.ts");

function runScript(dir: string, body: string) {
  const script = NodePath.join(dir, "main.ts");
  NodeFS.writeFileSync(script, `import { runCli } from ${JSON.stringify(CLI_MODULE)};\n${body}\n`);
  return run(process.execPath, [script], { cwd: dir });
}

it("a verdict is one JSON line on stdout with exit 0", () => {
  using dir = fixtureDir();
  const result = runScript(
    dir.path,
    `await runCli(() => ({ status: "conflicts", conflicts: ["a"] }));`,
  );
  expect(result).toMatchObject({ status: 0, stdout: '{"status":"conflicts","conflicts":["a"]}\n' });
});

it("no verdict exits 1 with the reason on stderr and nothing on stdout", () => {
  using dir = fixtureDir();
  const result = runScript(dir.path, `await runCli(() => { throw new Error("no network"); });`);
  expect(result).toEqual({ status: 1, stdout: "", stderr: "no network\n" });
});

it("the budget admits the next unit only while it cannot cross the budget", () => {
  expect(admits(undefined, 10_000, 10_000)).toBe(true);
  expect(admits(100, 60, 40)).toBe(true);
  expect(admits(100, 61, 40)).toBe(false);
  expect(admits(100, 100, 0)).toBe(true);
});

it.each(["0", "-5", "1.5", "lots"])("WF_TOKEN_BUDGET=%s is refused", (raw) => {
  expect(() => tokenBudget({ WF_TOKEN_BUDGET: raw })).toThrow(/positive integer/);
});

it("WF_TOKEN_BUDGET unset means no budget", () => {
  expect(tokenBudget({})).toBeUndefined();
  expect(tokenBudget({ WF_TOKEN_BUDGET: "4000000" })).toBe(4_000_000);
});
