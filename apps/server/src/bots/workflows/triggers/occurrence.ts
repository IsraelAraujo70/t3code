// @effect-diagnostics globalDate:off - Pure trigger boundaries accept explicit Date values without reading the clock.
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

/** Decides the latest due occurrence and advances only past handled occurrences. */
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
    const second = new Date(Math.floor(input.now.getTime() / 1000) * 1000);
    const at = Cron.match(parsed.success, second) ? second : Cron.prev(parsed.success, input.now);
    if (at <= input.watermark) return { _tag: "Idle" };
    const grace = input.misfire.mode === "latest" ? input.misfire.graceMs : input.toleranceMs;
    return input.now.getTime() - at.getTime() <= grace
      ? { _tag: "Fire", occurrence: occurrenceKey.cron(input.triggerId, at), at, watermark: at }
      : { _tag: "Skip", at, watermark: at };
  } catch (error) {
    return { _tag: "Invalid", message: String(error) };
  }
};

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

/** Selects the highest matching remote tag in numeric version order. */
export const latestTag = (
  output: string,
  pattern: string,
): { readonly tag: string; readonly objectSha: string } | null => {
  const glob = new RegExp(
    `^${pattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );
  const tags = output.split(/\r?\n/).flatMap((line) => {
    const match = /^([a-fA-F0-9]+)\trefs\/tags\/(\S+)$/.exec(line);
    return match && match[1] && match[2] && glob.test(match[2])
      ? [{ tag: match[2], objectSha: match[1] }]
      : [];
  });
  tags.sort(
    (a, b) =>
      a.tag.localeCompare(b.tag, "en", { numeric: true }) || a.tag.localeCompare(b.tag, "en"),
  );
  return tags.at(-1) ?? null;
};

// Replaced by isWorkflowStepThreadId from @t3tools/contracts when the hide work lands.
const isWorkflowStepThread = (threadId: string) => threadId.startsWith("wf:");

/** Matches all supplied filters while excluding workflow step threads. */
export const settledMatches = (
  trigger: { readonly projectId?: string; readonly botId?: string; readonly titlePrefix?: string },
  thread: { readonly threadId: string; readonly projectId: string; readonly title: string },
): boolean =>
  !isWorkflowStepThread(thread.threadId) &&
  (trigger.projectId === undefined || trigger.projectId === thread.projectId) &&
  (trigger.botId === undefined || thread.threadId.startsWith(`bot:${trigger.botId}:`)) &&
  (trigger.titlePrefix === undefined || thread.title.startsWith(trigger.titlePrefix));

/** Stops failure subscriptions before causal depth two. */
export const childCausalDepth = (parentDepth: number): number | null =>
  parentDepth + 1 < 2 ? parentDepth + 1 : null;
