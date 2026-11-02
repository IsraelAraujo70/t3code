/**
 * The three notices a run sends the user (§10): "needs you", "run failed" and "run finished".
 * One notice per logical event, never one per step; the key names the event, so a resend after a
 * crash shows once on the phone (Android deduplicates by `alert_id`). Pure builders.
 */
import type { BotPushData } from "../../push/BotPushDelivery.ts";
import type { Intent } from "../facts.ts";

const clip = (text: string): string => {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > 600 ? `${normalized.slice(0, 599)}…` : normalized;
};

export type NotifyIntent = Extract<Intent, { readonly _tag: "Notify" }>;

/** Why a run needs the user. */
export type NeedsYou =
  | { readonly _tag: "gate"; readonly gateKey: string; readonly ask: string }
  | { readonly _tag: "fatigue"; readonly pause: number; readonly streak: number }
  | { readonly _tag: "daily_cap"; readonly pause: number; readonly cap: number };

/** The run screen on web and desktop. */
export const workflowRunWebPath = (environmentId: string, runId: string): string => {
  return `/workflows/${encodeURIComponent(environmentId)}/runs/${encodeURIComponent(runId)}`;
};

/** The run screen on Android (`alert_path`). */
export const workflowRunAppPath = (environmentId: string, runId: string): string => {
  return `/bots/workflows/${encodeURIComponent(environmentId)}/runs/${encodeURIComponent(runId)}`;
};

/** "Needs you": an open gate (`notify:gate:<gateKey>`), a fatigue or daily-cap pause (`notify:<reason>:<n>`). */
export const needsYouNotice = (title: string, runId: string, why: NeedsYou): NotifyIntent => ({
  _tag: "Notify",
  key: why._tag === "gate" ? `notify:gate:${why.gateKey}` : `notify:${why._tag}:${why.pause}`,
  kind: "needs_you",
  title,
  body:
    why._tag === "gate"
      ? clip(why.ask)
      : why._tag === "fatigue"
        ? `Paused after ${why.streak} failures in a row. Resume it on the run screen.`
        : `Paused: workflows reached today's ${why.cap} token cap. It resumes when the workflow day turns.`,
});

/** "Run failed", key `notify:end`: failed, cancelled or out of budget. */
export const failedNotice = (
  title: string,
  runId: string,
  status: "failed" | "cancelled" | "budget_exhausted",
): NotifyIntent => ({
  _tag: "Notify",
  key: "notify:end",
  kind: "failed",
  title,
  body: {
    failed: "The run failed.",
    cancelled: "The run was cancelled.",
    budget_exhausted: "The run used its whole budget.",
  }[status],
});

/**
 * "Run finished", key `notify:end`: sent for `ready_for_review` and `no_gain`, and for any other
 * output status whose node sets `notify: true`; null otherwise.
 */
export const finishedNotice = (
  title: string,
  runId: string,
  output: { readonly status: string; readonly notify: boolean; readonly report: string | null },
): NotifyIntent | null => {
  if (output.status !== "ready_for_review" && output.status !== "no_gain" && !output.notify)
    return null;
  return {
    _tag: "Notify",
    key: "notify:end",
    kind: "finished",
    title,
    body: output.report
      ? clip(output.report)
      : output.status === "ready_for_review"
        ? "Ready for review."
        : output.status === "no_gain"
          ? "Finished without a gain."
          : output.status,
  };
};

/**
 * "Needs you" for the workflow, key `notify:suspended`: recorded in the stream of the failed run
 * that reached `fatigue.consecutiveFailures`, so its actor delivers it although the run ended.
 */
export const suspendedNotice = (title: string, runId: string, failures: number): NotifyIntent => ({
  _tag: "Notify",
  key: "notify:suspended",
  kind: "needs_you",
  title,
  body: `Suspended after ${failures} failed runs in a row. Turn it back on in Workflows.`,
});

/** The FCM data of one notice, as `bot_message` so the Android app shows it today. */
export const workflowPushData = (
  notice: NotifyIntent,
  context: {
    readonly runId: string;
    readonly workflowId: string;
    readonly environmentId: string;
    readonly sentAt: number;
  },
): BotPushData => {
  return {
    t3_kind: "bot_message",
    alert_id: `wf:${context.runId}:${notice.key}`,
    alert_title: notice.title,
    alert_body: notice.body,
    alert_path: workflowRunAppPath(context.environmentId, context.runId),
    alert_group: `wf:${context.workflowId}`,
    sent_at: String(context.sentAt),
  };
};
