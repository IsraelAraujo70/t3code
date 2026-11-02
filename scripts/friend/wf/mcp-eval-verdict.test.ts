// @effect-diagnostics nodeBuiltinImport:off - fixtures exercise Node subprocesses.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { it, expect } from "@effect/vitest";
import { listCases } from "./mcp-eval-verdict.ts";
import { fixtureDir, runWfCli } from "./testRepo.ts";

it("lists real cases for both harnesses", () => {
  const codex = listCases("gpt-6.1-sol");
  const claude = listCases("claude-opus-5-5");
  expect(codex).toContain("codex-same-model-subagents-stay-native");
  expect(claude).not.toContain("codex-same-model-subagents-stay-native");
  expect(claude).toContain("NAT-01");
  expect(codex).not.toContain("NAT-01");
  expect(codex).toContain("DEL-02");
  expect(claude).toContain("DEL-02");
});

it("aggregates regressions and resumes without invoking the paid runner", () => {
  using dir = fixtureDir();
  const runner = NodePath.join(dir.path, "runner.cjs");
  const baseline = NodePath.join(dir.path, "baseline.jsonl");
  const calls = NodePath.join(dir.path, "calls");
  NodeFS.writeFileSync(
    runner,
    `
const NodeFS = require("node:fs");
const arg = n => process.argv[process.argv.indexOf(n)+1];
const id = arg("--case");
NodeFS.appendFileSync(process.env.CALLS, id+"\\n");
const item = JSON.parse(process.env.FAKE_EVAL_TABLE)[id];
if(item.stderr) process.stderr.write(item.stderr);
if(item.exit) process.exit(item.exit);
NodeFS.mkdirSync(arg("--out"), {recursive:true});
NodeFS.writeFileSync(arg("--out")+"/results.jsonl", item.rows.map(r=>JSON.stringify(r)).join("\\n")+"\\n");
NodeFS.writeFileSync(arg("--out")+"/summary.md", "Estimated cost $1");
`,
  );
  const row = (id: string, pass: boolean) => ({
    id,
    pass,
    usage: { input: 2, output: 1, cacheWrite: 3, cacheRead: 4 },
    shellUsage: { input: 1, output: 1, cacheWrite: 0, cacheRead: 0 },
  });
  NodeFS.writeFileSync(
    baseline,
    ["A", "B", "C"]
      .flatMap((id) => [row(id, id !== "C"), row(id, id !== "C")])
      .map((r) => JSON.stringify(r))
      .join("\n"),
  );
  const table = Object.fromEntries(
    ["A", "B", "C"].map((id) => [id, { rows: [row(id, id !== "B"), row(id, id !== "B")] }]),
  );
  const env = {
    MCP_EVAL_RUN_TS: runner,
    CALLS: calls,
    FAKE_EVAL_TABLE: JSON.stringify(table),
    WF_TOKEN_BUDGET: "",
  };
  const args = [
    "--model",
    "gpt-test",
    "--baseline",
    baseline,
    "--out",
    NodePath.join(dir.path, "out"),
  ];
  const first = runWfCli("mcp-eval-verdict.ts", args, { cwd: dir.path, env });
  expect(first.status).toBe(0);
  expect(JSON.parse(first.stdout)).toMatchObject({
    complete: true,
    regressed: ["B"],
    case_regressions: 1,
    usage: { total_tokens: 30, cost_usd: 3 },
  });
  expect(runWfCli("mcp-eval-verdict.ts", args, { cwd: dir.path, env }).stdout).toBe(first.stdout);
  expect(NodeFS.readFileSync(calls, "utf8")).toBe("A\nB\nC\n");
  NodeFS.writeFileSync(calls, "");
  const limited = runWfCli(
    "mcp-eval-verdict.ts",
    [...args.slice(0, -1), NodePath.join(dir.path, "limited")],
    { cwd: dir.path, env: { ...env, WF_TOKEN_BUDGET: "20" } },
  );
  expect(JSON.parse(limited.stdout)).toMatchObject({
    complete: false,
    stopped: "budget",
    cases: { finished: 2 },
  });
  expect(NodeFS.readFileSync(calls, "utf8")).toBe("A\nB\n");
  const run = (name: string, fake: unknown, baselineArgs = ["--baseline", baseline]) =>
    runWfCli(
      "mcp-eval-verdict.ts",
      [
        "--model",
        "gpt-test",
        "--case",
        "A,B",
        ...baselineArgs,
        "--out",
        NodePath.join(dir.path, name),
      ],
      {
        cwd: dir.path,
        env: { ...env, FAKE_EVAL_TABLE: JSON.stringify(fake) },
      },
    );
  const errors = run("errors", {
    A: { rows: [row("A", true), { ...row("A", false), error: "failed" }] },
    B: { rows: [{ ...row("B", false), error: "failed" }] },
  });
  expect(errors.status).toBe(0);
  expect(JSON.parse(errors.stdout)).toMatchObject({
    complete: false,
    cases: { planned: 2, finished: 1 },
    case_regressions: 0,
    regressed: [],
  });
  const skipped = run("skipped", { A: table.A, B: { exit: 1, stderr: "No case matches --case." } });
  expect(skipped.status).toBe(0);
  expect(JSON.parse(skipped.stdout)).toMatchObject({
    complete: true,
    cases: { planned: 1, finished: 1 },
  });
  const failed = run("failed", { A: { exit: 1, stderr: "runner failure tail" } });
  expect(failed.status).toBe(1);
  expect(failed.stdout).toBe("");
  expect(failed.stderr).toContain("runner failure tail");
  const noBaseline = run("no-baseline", table, []);
  expect(noBaseline.status).toBe(0);
  expect(JSON.parse(noBaseline.stdout)).toMatchObject({ case_regressions: 0, regressed: [] });
  NodeFS.writeFileSync(baseline, '{"id":42}\n');
  const malformed = run("malformed", table);
  expect(malformed.status).toBe(1);
  expect(malformed.stdout).toBe("");
  expect(malformed.stderr).toContain(baseline);
});
