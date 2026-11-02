// @effect-diagnostics globalDate:off - Pure trigger boundaries accept explicit Date values without reading the clock.
import {
  isListedThreadLineage,
  isWorkflowStepThreadId,
  type OrchestrationV2AppThreadLineage,
} from "@t3tools/contracts";
import * as Cron from "effect/Cron";
import * as Result from "effect/Result";

/** Occurrence keys: the TriggerFired key and the input of the run id. */
export const occurrenceKey = {
  cron: (id: string, at: Date) => `cron:${id}:${at.toISOString()}`,
  webhook: (id: string) => `webhook:${id}`,
  manual: (id: string) => `manual:${id}`,
  bot: (id: string, request: string) => `bot:${id}:${request}`,
  tag: (remote: string, tag: string, sha: string) => `tag:${remote}:${tag}:${sha}`,
  prMerged: (repo: string, number: number, sha: string) => `pr:${repo}#${number}:${sha}`,
  settled: (id: string, seq: number) => `settled:${id}:${seq}`,
  runFailed: (id: string) => `run-failed:${id}`,
};

export type CronDecision =
  | {
      readonly _tag: "Fire";
      readonly occurrence: string;
      readonly at: Date;
      readonly watermark: Date;
    }
  | { readonly _tag: "Skip"; readonly at: Date; readonly watermark: Date }
  | { readonly _tag: "Idle" }
  | { readonly _tag: "Invalid"; readonly message: string };

/**
 * The latest occurrence after the watermark that is due at `now`, walked forward with `Cron.next`:
 * `Cron.prev` throws across a spring-forward gap. A wall time that repeats when clocks go back
 * fires once, at its first passage.
 */
export const cronDecision = (input: {
  readonly triggerId: string;
  readonly expr: string;
  readonly tz: string;
  readonly misfire: { readonly mode: "latest" | "skip"; readonly graceMs: number };
  readonly toleranceMs: number;
  readonly watermark: Date;
  readonly now: Date;
}): CronDecision => {
  try {
    const parsed = Cron.parse(input.expr, input.tz);
    if (Result.isFailure(parsed)) return { _tag: "Invalid", message: parsed.failure.message };
    let at = Cron.next(parsed.success, input.watermark);
    if (at > input.now) return { _tag: "Idle" };
    let following = Cron.next(parsed.success, at);
    for (let step = 0; following <= input.now && step < MAX_CATCH_UP_STEPS; step++) {
      at = following;
      following = Cron.next(parsed.success, at);
    }
    // Still behind after a full walk: `at` is not the latest due occurrence, so advance only.
    if (following <= input.now) return { _tag: "Skip", at, watermark: at };
    const grace = input.misfire.mode === "latest" ? input.misfire.graceMs : input.toleranceMs;
    return input.now.getTime() - at.getTime() <= grace
      ? { _tag: "Fire", occurrence: occurrenceKey.cron(input.triggerId, at), at, watermark: at }
      : { _tag: "Skip", at, watermark: at };
  } catch (error) {
    return { _tag: "Invalid", message: String(error) };
  }
};

/** Bounds one catch-up walk; a longer gap is skipped over the next ticks without firing. */
const MAX_CATCH_UP_STEPS = 10_000;

/** Uses the definition's misfire policy when provided. */
export const misfirePolicy = (
  trigger: {
    readonly misfire?: { readonly mode: "latest" | "skip"; readonly grace: string } | undefined;
  },
  host: { readonly mode: "latest" | "skip"; readonly graceMs: number },
): { readonly mode: "latest" | "skip"; readonly graceMs: number } => {
  if (!trigger.misfire) return host;
  const units: Record<string, number> = { s: 1000, m: 60000, h: 3600000 };
  return {
    mode: trigger.misfire.mode,
    graceMs:
      Number(trigger.misfire.grace.slice(0, -1)) * (units[trigger.misfire.grace.slice(-1)] ?? NaN),
  };
};

/**
 * The highest tag in `git ls-remote --tags --refs` output whose name matches `pattern`, a regular
 * expression as the compiler checks it, in version order (v0.10.0 > v0.9.3). Unparsable lines and
 * an invalid pattern match nothing.
 */
export const latestTag = (
  output: string,
  pattern: string,
): { readonly tag: string; readonly objectSha: string } | null => {
  let matcher: RegExp;
  try {
    matcher = new RegExp(pattern);
  } catch {
    return null;
  }
  const tags = output.split(/\r?\n/).flatMap((line) => {
    const match = /^([a-fA-F0-9]+)\trefs\/tags\/(\S+)$/.exec(line);
    return match && match[1] && match[2] && matcher.test(match[2])
      ? [{ tag: match[2], objectSha: match[1] }]
      : [];
  });
  tags.sort(
    (a, b) =>
      a.tag.localeCompare(b.tag, "en", { numeric: true }) || a.tag.localeCompare(b.tag, "en"),
  );
  return tags.at(-1) ?? null;
};

/** Matches all supplied filters while excluding workflow step threads. */
export const settledMatches = (
  trigger: { readonly projectId?: string; readonly botId?: string; readonly titlePrefix?: string },
  thread: {
    readonly threadId: string;
    readonly projectId: string;
    readonly title: string;
    readonly lineage: OrchestrationV2AppThreadLineage;
  },
): boolean =>
  !isWorkflowStepThreadId(thread.threadId) &&
  isListedThreadLineage(thread.lineage) &&
  (trigger.projectId === undefined || trigger.projectId === thread.projectId) &&
  (trigger.botId === undefined || thread.threadId.startsWith(`bot:${trigger.botId}:`)) &&
  (trigger.titlePrefix === undefined || thread.title.startsWith(trigger.titlePrefix));

/** Stops failure subscriptions before causal depth two. */
export const childCausalDepth = (parentDepth: number): number | null =>
  parentDepth + 1 < 2 ? parentDepth + 1 : null;
