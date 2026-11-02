// @effect-diagnostics nodeBuiltinImport:off - workflow CLIs run as plain Node subprocesses.
/**
 * Shared contract of the workflow CLIs (docs/friend/workflows-design.md §11). Each prints exactly
 * one JSON object on stdout and exits 0 whenever it reached a verdict, even a failing one
 * (conflicts, red checks, regressions): the workflow routes on the JSON. Exit 1 means no verdict;
 * the reason goes to stderr and stdout stays empty.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeProcess from "node:process";

export const UPSTREAM_URL = "https://github.com/pingdotgg/t3code";
export const STABLE_TAG = /^v\d+\.\d+\.\d+$/;
/** The VPS-wide lock wrapper; `T3_HEAVY_SH` overrides it in tests. */
export const HEAVY_SH = NodeProcess.env.T3_HEAVY_SH ?? "/home/israel/.cache/t3-testdata/heavy.sh";

export interface SelectUpstreamTagOutput {
  readonly tag: string;
  /** The commit the tag points to (peeled), not an annotated tag object. */
  readonly tagSha: string;
  /** Whether `--base` already contains the tag's commit. */
  readonly contained: boolean;
}

export interface MergeUpstreamOutput {
  readonly status: "merged" | "conflicts";
  /** Unmerged paths, sorted; empty when merged. */
  readonly conflicts: ReadonlyArray<string>;
  readonly tag: string;
  /** HEAD of the `--into` worktree after the run. */
  readonly head: string;
}

export type ForkCheck = "seams" | "theme" | "tests";

export interface ForkCheckFailure {
  readonly check: ForkCheck;
  readonly exitCode: number;
  /** Tail of the check's combined output. */
  readonly output: string;
}

export interface ForkChecksOutput {
  readonly seams: boolean;
  readonly theme: boolean;
  readonly tests: boolean;
  readonly failures: ReadonlyArray<ForkCheckFailure>;
}

export interface McpTokenCountOutput {
  /** `ceil(chars / 4)` over the whole advertised list. */
  readonly total: number;
  /** `ceil(chars / 4)` of each tool's advertised `{ name, description, inputSchema }`. */
  readonly perTool: Readonly<Record<string, number>>;
  readonly method: "chars/4";
  readonly tools: number;
  /** Length of `JSON.stringify` of the advertised list. */
  readonly chars: number;
}

export interface McpEvalUsage {
  /** Uncached input tokens, agent plus shell simulator. */
  readonly input: number;
  readonly output: number;
  readonly cacheWrite: number;
  readonly cacheRead: number;
  /** `input + output`: what `WF_TOKEN_BUDGET` is charged with (design §9.1). */
  readonly total_tokens: number;
  /** Sum of the eval's own estimates; null when any case had no price (Codex proxy). */
  readonly cost_usd: number | null;
}

export interface McpEvalVerdictOutput {
  /** Every planned case finished at least one graded sample, and the budget never stopped the run. */
  readonly complete: boolean;
  readonly case_regressions: number;
  readonly regressed: ReadonlyArray<string>;
  readonly usage: McpEvalUsage;
  /** The merged results.jsonl of this run, usable as a later `--baseline`. */
  readonly resultsPath: string;
  readonly cases: { readonly planned: number; readonly finished: number };
  readonly stopped: "budget" | null;
}

/** Value after `--name`, or undefined when the flag is absent. */
export function flag(
  name: string,
  argv: ReadonlyArray<string> = NodeProcess.argv,
): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

export function hasFlag(name: string, argv: ReadonlyArray<string> = NodeProcess.argv): boolean {
  return argv.includes(name);
}

export function git(args: ReadonlyArray<string>, cwd: string): string {
  return NodeChildProcess.execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** Exit status of a quiet git command, for predicates such as `merge-base --is-ancestor`. */
export function gitStatus(args: ReadonlyArray<string>, cwd: string): number {
  return NodeChildProcess.spawnSync("git", args, { cwd, stdio: "ignore" }).status ?? 1;
}

/** `WF_TOKEN_BUDGET` as a positive integer, or undefined when unset. */
export function tokenBudget(env: NodeJS.ProcessEnv = NodeProcess.env): number | undefined {
  const raw = env.WF_TOKEN_BUDGET;
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`WF_TOKEN_BUDGET must be a positive integer, got ${raw}`);
  }
  return value;
}

/**
 * Admission rule for paid units under `WF_TOKEN_BUDGET`: start the next unit only while
 * `spent + largest unit so far <= budget`, so a run stops before it would cross the budget.
 */
export function admits(budget: number | undefined, spent: number, largestUnit: number): boolean {
  return budget === undefined || spent + largestUnit <= budget;
}

/** Prints the verdict and exits 0, or prints the error and exits 1 (see the module comment). */
export async function runCli<A>(main: () => A | Promise<A>): Promise<void> {
  try {
    const output = await main();
    NodeProcess.stdout.write(`${JSON.stringify(output)}\n`);
    process.exitCode = 0;
  } catch (error) {
    NodeProcess.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
