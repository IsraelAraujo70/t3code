// @effect-diagnostics nodeBuiltinImport:off - tests exercise the Node CLI and checkout files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import { checkToolkitNames, registeredToolkitNames } from "./mcp-token-count.ts";
import { run, runWfCli } from "./testRepo.ts";

const ROOT = NodePath.resolve(import.meta.dirname, "../../..");

it("counts the complete checkout inventory through the CLI", () => {
  const result = runWfCli("mcp-token-count.ts", ["--json"], { cwd: ROOT });
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  const output = JSON.parse(result.stdout);
  expect(output.method).toBe("chars/4");
  expect(output.tools).toBe(Object.keys(output.perTool).length);
  expect(output.total).toBe(Math.ceil(output.chars / 4));
  for (const name of ["watch_thread", "kanban_list", "memory_list", "delegate_task"]) {
    expect(output.perTool[name]).toBeGreaterThan(0);
  }
});

it("matches the upstream server inventory byte budget", () => {
  const budget = JSON.parse(
    NodeFS.readFileSync(
      NodePath.join(ROOT, "apps/server/src/provider/agentContextBudget.json"),
      "utf8",
    ),
  );
  const result = run(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import { advertisedTools } from ${JSON.stringify(NodePath.join(import.meta.dirname, "mcp-token-count.ts"))}; console.log(Buffer.byteLength(JSON.stringify(await advertisedTools("upstream")), "utf8"));`,
    ],
    { cwd: ROOT },
  );
  expect(result.stderr).toBe("");
  expect(result.status).toBe(0);
  expect(Number(result.stdout)).toBe(budget.mcpToolListJsonBytes);
});

it("detects toolkit registration drift", () => {
  const source = NodeFS.readFileSync(
    NodePath.join(ROOT, "apps/server/src/mcp/McpHttpServer.ts"),
    "utf8",
  );
  expect(registeredToolkitNames(source)).toHaveLength(18);
  expect(() => checkToolkitNames(source)).not.toThrow();
  expect(() =>
    checkToolkitNames(`${source}\ntoolkitRegistration(UnexpectedToolkit, layer)`),
  ).toThrow("extra [UnexpectedToolkit]");
  expect(() => checkToolkitNames("")).toThrow("missing [");
});
