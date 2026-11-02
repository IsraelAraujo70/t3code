// @effect-diagnostics nodeBuiltinImport:off - workflow CLI runs as a Node subprocess.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeChildProcess from "node:child_process";
import * as Schema from "effect/Schema";
import { admits, flag, runCli, tokenBudget, type McpEvalVerdictOutput } from "./cli.ts";

const ROOT = NodePath.resolve(import.meta.dirname, "../../..");
const UsageSchema = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  cacheWrite: Schema.Number,
  cacheRead: Schema.Number,
});
const RowSchema = Schema.Struct({
  id: Schema.String,
  pass: Schema.Boolean,
  error: Schema.optional(Schema.String),
  usage: Schema.optional(UsageSchema),
  shellUsage: Schema.optional(UsageSchema),
});
type Row = typeof RowSchema.Type;
const CaseSchema = Schema.Struct({
  id: Schema.String,
  setup: Schema.optional(Schema.Struct({ harness: Schema.optional(Schema.String) })),
});
const readLines = <A>(file: string, decode: (value: unknown) => A): A[] => {
  try {
    return NodeFS.readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => decode(JSON.parse(line)));
  } catch (cause) {
    throw new Error(`Invalid data in ${file}: ${String(cause)}`, { cause });
  }
};
const rows = (file: string): Row[] => readLines(file, Schema.decodeUnknownSync(RowSchema));
const finished = (items: Row[]) => items.filter((row) => row.error === undefined);
const passes = (items: Row[]) => {
  const done = finished(items);
  return done.length > 0 && done.filter((row) => row.pass).length / done.length > 0.5;
};

/** Lists repository cases compatible with the model's harness. */
export function listCases(model: string): string[] {
  const dir = NodePath.join(ROOT, "evals/mcp-tool-use/cases");
  return NodeFS.readdirSync(dir)
    .filter((file) => file.endsWith(".ndjson"))
    .flatMap((file) => readLines(NodePath.join(dir, file), Schema.decodeUnknownSync(CaseSchema)))
    .filter(
      (item) =>
        !item.setup?.harness ||
        item.setup.harness === (model.startsWith("gpt-") ? "codex" : "claude"),
    )
    .map((item) => item.id);
}

/** Runs cases sequentially and aggregates their persisted verdicts. */
export function mcpEvalVerdict(): McpEvalVerdictOutput {
  const model = flag("--model");
  const out = flag("--out");
  if (!model || !out) throw new Error("--model and --out are required");
  const baseline = flag("--baseline") ? rows(NodePath.resolve(flag("--baseline")!)) : [];
  const plan = [
    ...new Set(
      flag("--case")?.split(",") ??
        (baseline.length ? baseline.map((row) => row.id) : listCases(model)),
    ),
  ];
  const budget = tokenBudget();
  const usage = {
    input: 0,
    output: 0,
    cacheWrite: 0,
    cacheRead: 0,
    total_tokens: 0,
    cost_usd: 0 as number | null,
  };
  const all: Row[] = [];
  const regressed: string[] = [];
  let largest = 0;
  let stopped: "budget" | null = null;
  let count = 0;
  let planned = plan.length;
  for (const id of plan) {
    if (!/^[\w.-]+$/.test(id) || id === "." || id === "..")
      throw new Error(`Invalid case id: ${id}`);
    const dir = NodePath.resolve(out, "cases", id);
    const file = NodePath.join(dir, "results.jsonl");
    if (!NodeFS.existsSync(file)) {
      if (!admits(budget, usage.total_tokens, largest)) {
        stopped = "budget";
        break;
      }
      const args = [
        process.env.MCP_EVAL_RUN_TS ?? "mcp-tool-use/run.ts",
        "--model",
        model,
        "--case",
        id,
        "--out",
        dir,
      ];
      const samples = flag("--samples");
      if (samples) args.push("--samples", samples);
      if (!process.env.MCP_EVAL_RUN_TS) args.unshift("--env-file-if-exists=../.env");
      const result = NodeChildProcess.spawnSync(process.execPath, args, {
        cwd: NodePath.join(ROOT, "evals"),
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
      });
      // run.ts logs its fatal error through Effect's logger, which writes to stdout.
      const log = `${result.stdout ?? ""}${result.stderr ?? ""}`;
      process.stderr.write(log);
      if (result.status !== 0) {
        if (log.includes("No case matches --case")) {
          planned--;
          continue;
        }
        throw new Error(result.error?.message ?? (log.slice(-8000) || "Eval runner failed"));
      }
    }
    const current = rows(file);
    all.push(...current);
    if (finished(current).length) {
      count++;
      if (passes(baseline.filter((row) => row.id === id)) && !passes(current)) regressed.push(id);
    }
    let spent = 0;
    for (const row of current)
      for (const part of [row.usage, row.shellUsage])
        if (part) {
          for (const key of ["input", "output", "cacheWrite", "cacheRead"] as const)
            usage[key] += part[key] ?? 0;
          spent += (part.input ?? 0) + (part.output ?? 0);
        }
    usage.total_tokens += spent;
    largest = Math.max(largest, spent);
    const summary = NodePath.join(dir, "summary.md");
    const cost = NodeFS.existsSync(summary)
      ? NodeFS.readFileSync(summary, "utf8").match(/Estimated cost \$(\d+(?:\.\d+)?)/)
      : null;
    usage.cost_usd = cost && usage.cost_usd !== null ? usage.cost_usd + Number(cost[1]) : null;
  }
  const resultsPath = NodePath.resolve(out, "results.jsonl");
  NodeFS.mkdirSync(NodePath.dirname(resultsPath), { recursive: true });
  NodeFS.writeFileSync(
    resultsPath,
    all.map((row) => JSON.stringify(row)).join("\n") + (all.length ? "\n" : ""),
  );
  return {
    complete: planned > 0 && count === planned && stopped === null,
    case_regressions: regressed.length,
    regressed,
    usage,
    resultsPath,
    cases: { planned, finished: count },
    stopped,
  };
}

if (import.meta.main) {
  if (process.argv.includes("--help"))
    process.stdout.write(
      `--model <m> [--baseline <results.jsonl>] --out <dir>
[--case <ids>] [--samples <n>]
WF_TOKEN_BUDGET limits uncached input + output.
MCP_EVAL_RUN_TS overrides the runner.
Regression: baseline majority passes, current majority fails.
Exit 0: JSON verdict; exit 1: no verdict.
`,
    );
  else await runCli(mcpEvalVerdict);
}
