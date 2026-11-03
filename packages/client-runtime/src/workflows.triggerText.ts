/**
 * Workflow triggers in words for lists (friend fork). Hosts send each trigger's definition as
 * structured parts (`cron`, `upstreamTag`, …); run summaries and older hosts send only `label`
 * (`40 * * * * (America/Sao_Paulo)`, `tag ^v\d+$ on https://…`), which is read back into the same
 * parts. Anything neither covers falls back to the label itself.
 */
import type { WorkflowTriggerParts, WorkflowTriggerSummary } from "@t3tools/contracts";

export type TriggerTextInput = Pick<WorkflowTriggerSummary, "kind" | "title" | "label"> &
  WorkflowTriggerParts;

export interface TriggerText {
  /** What a list shows: the trigger's title, else its definition in plain words. */
  readonly text: string;
  /** The raw definition, for a tooltip: `40 * * * * · America/Sao_Paulo`. */
  readonly detail: string;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SHORT_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const isInt = (field: string) => /^\d+$/.test(field);
const pad = (value: string) => value.padStart(2, "0");
const clock = (hour: string, minute: string) => `${pad(hour)}:${pad(minute)}`;

/** `0 21 * * *` → `Daily at 21:00`; null when the expression is not a common shape. */
export function describeCron(expr: string): string | null {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];
  const everyDay = dom === "*" && month === "*" && dow === "*";
  const step = (field: string) => /^\*\/(\d+)$/.exec(field)?.[1];

  if (everyDay && hour === "*") {
    if (minute === "*") return "Every minute";
    const minutes = step(minute);
    if (minutes !== undefined) return `Every ${minutes} minutes`;
    if (isInt(minute)) return `Every hour at :${pad(minute)}`;
    return null;
  }
  if (!isInt(minute)) return null;
  const hours = step(hour);
  if (hours !== undefined && everyDay) return `Every ${hours} hours at :${pad(minute)}`;
  const hourList = hour.split(",");
  if (!hourList.every(isInt)) return null;
  const times = hourList.map((h) => clock(h, minute));
  const at = `at ${times.length === 1 ? times[0] : `${times.slice(0, -1).join(", ")} and ${times.at(-1)}`}`;

  if (everyDay) return `Daily ${at}`;
  if (month !== "*") return null;
  if (dow === "*" && isInt(dom)) return `Monthly on day ${dom} ${at}`;
  if (dom !== "*") return null;
  if (dow === "1-5") return `Weekdays ${at}`;
  if (dow === "0,6" || dow === "6,0") return `Weekends ${at}`;
  const days = dow.split(",").map((day) => (day === "7" ? 0 : Number(day)));
  if (!dow.split(",").every(isInt) || days.some((day) => day > 6)) return null;
  if (days.length === 1) return `${WEEKDAYS[days[0]!]}s ${at}`;
  return `${days.map((day) => SHORT_WEEKDAYS[day]).join(", ")} ${at}`;
}

/** `https://github.com/pingdotgg/t3code.git` → `pingdotgg/t3code`; other remotes stay as written. */
export function shortRepo(remote: string): string {
  const match =
    /^(?:https?:\/\/|ssh:\/\/git@|git@)github\.com[/:]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(
      remote.trim(),
    );
  return match?.[1] ?? remote;
}

/** A tag pattern that only matches plain `vX.Y.Z` / `X.Y.Z` versions, without pre-release suffixes. */
const isStableReleasePattern = (pattern: string) =>
  /^\^?v?\??(\\d\+\\\.){2}\\d\+\$$/.test(pattern.replaceAll("[0-9]", "\\d"));

/** The city of an IANA zone: `America/Sao_Paulo` → `Sao Paulo`. */
const zoneCity = (timeZone: string) =>
  (timeZone.split("/").at(-1) ?? timeZone).replaceAll("_", " ");

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** The parts a host's `label` (`triggerLabel` on the server) still carries, for hosts without parts. */
function triggerPartsFromLabel(kind: string, label: string): WorkflowTriggerParts {
  switch (kind) {
    case "cron": {
      const match = /^(.*) \(([^()]+)\)$/.exec(label);
      return match === null ? {} : { cron: { expr: match[1] ?? "", tz: match[2] ?? "" } };
    }
    case "upstreamTag": {
      const match = /^tag (.+) on (\S+)$/.exec(label);
      return match === null
        ? {}
        : { upstreamTag: { pattern: match[1] ?? "", remote: match[2] ?? "" } };
    }
    case "prMerged": {
      const repo = /^PR merged in (\S+)$/.exec(label)?.[1];
      return repo === undefined ? {} : { prMerged: { repo } };
    }
    case "webhook": {
      const filters = /^webhook · (\d+) filters?$/.exec(label)?.[1];
      return { webhook: { filters: filters === undefined ? 0 : Number(filters) } };
    }
    case "workflowFailed": {
      const workflow = /^(\S+) failed$/.exec(label)?.[1];
      return {
        workflowFailed: {
          workflow: workflow === undefined || workflow === "any" ? null : workflow,
        },
      };
    }
    case "bot":
      // `bot · 2 bots` gives a count, not the ids; such a label is shown as written.
      return label === "bot · any bot" ? { bot: { bots: null } } : {};
    case "call":
      return label === "called by any workflow"
        ? { call: { from: null } }
        : label.startsWith("called by ")
          ? { call: { from: label.slice("called by ".length).split(", ") } }
          : {};
    default:
      return {};
  }
}

/** The trigger in words from its parts; null when the part its kind needs is missing. */
function describeParts(
  kind: string,
  parts: WorkflowTriggerParts,
  localTimeZone: string | undefined,
): string | null {
  switch (kind) {
    case "cron": {
      if (parts.cron === undefined) return null;
      const { expr, tz } = parts.cron;
      const words = describeCron(expr);
      if (words === null) return `Cron ${expr}`;
      return localTimeZone === undefined || localTimeZone === tz
        ? words
        : `${words} (${zoneCity(tz)})`;
    }
    case "upstreamTag": {
      if (parts.upstreamTag === undefined) return null;
      const { pattern, remote } = parts.upstreamTag;
      return isStableReleasePattern(pattern)
        ? `New stable release of ${shortRepo(remote)}`
        : `New tag ${pattern} on ${shortRepo(remote)}`;
    }
    case "prMerged":
      return parts.prMerged === undefined ? null : `PR merged in ${shortRepo(parts.prMerged.repo)}`;
    case "webhook":
      return parts.webhook === undefined
        ? null
        : parts.webhook.filters === 0
          ? "Incoming webhook"
          : `Incoming webhook, ${plural(parts.webhook.filters, "filter")}`;
    case "threadSettled":
      return "When a thread settles";
    case "workflowFailed":
      return parts.workflowFailed === undefined
        ? null
        : parts.workflowFailed.workflow === null
          ? "When any workflow fails"
          : `When ${parts.workflowFailed.workflow} fails`;
    case "manual":
      return "Run now";
    case "bot":
      return parts.bot === undefined
        ? null
        : parts.bot.bots === null
          ? "Any bot can run it"
          : `${plural(parts.bot.bots.length, "bot")} can run it`;
    case "call":
      return parts.call === undefined
        ? null
        : parts.call.from === null
          ? "Any workflow can call it"
          : `Called by ${parts.call.from.join(", ")}`;
    default:
      return null;
  }
}

/** Kinds whose definition is worth showing as is: an expression, a pattern, a repo. */
const TECHNICAL_KINDS = new Set(["cron", "upstreamTag", "prMerged", "webhook"]);

/** The parts the host sent, else the ones its label carries. */
const partsOf = (trigger: TriggerTextInput): WorkflowTriggerParts =>
  (trigger.cron ??
    trigger.upstreamTag ??
    trigger.prMerged ??
    trigger.webhook ??
    trigger.workflowFailed ??
    trigger.bot ??
    trigger.call) === undefined
    ? triggerPartsFromLabel(trigger.kind, trigger.label)
    : trigger;

/**
 * A trigger for a list line: its title when it has one, else its definition in words.
 * `localTimeZone` (the viewer's IANA zone) adds the trigger's zone to a schedule only when the two
 * differ.
 */
export function describeTrigger(trigger: TriggerTextInput, localTimeZone?: string): TriggerText {
  const parts = partsOf(trigger);
  const words = describeParts(trigger.kind, parts, localTimeZone) ?? trigger.label;
  const raw = parts.cron === undefined ? trigger.label : `${parts.cron.expr} · ${parts.cron.tz}`;
  const technical = TECHNICAL_KINDS.has(trigger.kind) && raw !== words;
  return {
    text: trigger.title ?? words,
    detail: [trigger.title === null ? null : words, technical ? raw : null]
      .filter((part) => part !== null)
      .join(" · "),
  };
}

/** Triggers that start a run on their own, as opposed to on request (`manual`, `bot`, `call`). */
export const isAutomaticTrigger = (kind: string): boolean =>
  kind !== "manual" && kind !== "bot" && kind !== "call";
