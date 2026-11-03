/**
 * Workflow triggers in words for lists (friend fork). The client only receives the server's
 * `label` (`40 * * * * (America/Sao_Paulo)`, `tag ^v\d+$ on https://…`), so this reads that text
 * back; anything it does not recognise falls back to the label itself.
 */

export interface TriggerTextInput {
  readonly kind: string;
  readonly title: string | null;
  readonly label: string;
}

export interface TriggerText {
  /** What a list shows: the trigger's title, else the label in plain words. */
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

function describeLabel(kind: string, label: string, localTimeZone: string | undefined): string {
  switch (kind) {
    case "cron": {
      const match = /^(.*) \(([^()]+)\)$/.exec(label);
      if (match === null) return label;
      const [, expr = "", timeZone = ""] = match;
      const words = describeCron(expr);
      if (words === null) return `Cron ${expr}`;
      return localTimeZone === undefined || localTimeZone === timeZone
        ? words
        : `${words} (${zoneCity(timeZone)})`;
    }
    case "upstreamTag": {
      const match = /^tag (.+) on (\S+)$/.exec(label);
      if (match === null) return label;
      const [, pattern = "", remote = ""] = match;
      return isStableReleasePattern(pattern)
        ? `New stable release of ${shortRepo(remote)}`
        : `New tag ${pattern} on ${shortRepo(remote)}`;
    }
    case "prMerged": {
      const repo = /^PR merged in (\S+)$/.exec(label)?.[1];
      return repo === undefined ? label : `PR merged in ${shortRepo(repo)}`;
    }
    case "webhook": {
      const filters = /^webhook · (\d+) filters?$/.exec(label)?.[1];
      return filters === undefined
        ? "Incoming webhook"
        : `Incoming webhook, ${filters} filter${filters === "1" ? "" : "s"}`;
    }
    case "threadSettled":
      return "When a thread settles";
    case "workflowFailed": {
      const workflow = /^(\S+) failed$/.exec(label)?.[1];
      return workflow === undefined || workflow === "any"
        ? "When any workflow fails"
        : `When ${workflow} fails`;
    }
    case "manual":
      return "Run now";
    case "bot": {
      const count = /^bot · (\d+) bots?$/.exec(label)?.[1];
      return count === undefined
        ? "Any bot can run it"
        : `${count} bot${count === "1" ? "" : "s"} can run it`;
    }
    case "call":
      return label === "called by any workflow"
        ? "Any workflow can call it"
        : label.replace(/^called by /, "Called by ");
    default:
      return label;
  }
}

/** Kinds whose label carries a definition worth showing as is: an expression, a pattern, a repo. */
const TECHNICAL_LABEL_KINDS = new Set(["cron", "upstreamTag", "prMerged", "webhook"]);

/**
 * A trigger for a list line: its title when it has one, else its label in words. `localTimeZone`
 * (the viewer's IANA zone) adds the trigger's zone to a schedule only when the two differ.
 */
export function describeTrigger(trigger: TriggerTextInput, localTimeZone?: string): TriggerText {
  const words = describeLabel(trigger.kind, trigger.label, localTimeZone);
  const cron = trigger.kind === "cron" ? /^(.*) \(([^()]+)\)$/.exec(trigger.label) : null;
  const raw = cron === null ? trigger.label : `${cron[1]} · ${cron[2]}`;
  const technical = TECHNICAL_LABEL_KINDS.has(trigger.kind) && raw !== words;
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
