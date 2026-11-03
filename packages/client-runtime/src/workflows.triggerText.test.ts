import { describe, expect, it } from "vite-plus/test";

import { describeCron, describeTrigger, shortRepo } from "./workflows.triggerText.ts";

describe("describeCron", () => {
  it.each([
    ["40 * * * *", "Every hour at :40"],
    ["*/15 * * * *", "Every 15 minutes"],
    ["* * * * *", "Every minute"],
    ["5 */6 * * *", "Every 6 hours at :05"],
    ["0 21 * * *", "Daily at 21:00"],
    ["30 2 * * *", "Daily at 02:30"],
    ["0 9,18 * * *", "Daily at 09:00 and 18:00"],
    ["0 9 * * 1-5", "Weekdays at 09:00"],
    ["0 10 * * 0,6", "Weekends at 10:00"],
    ["0 8 * * 1", "Mondays at 08:00"],
    ["0 8 * * 7", "Sundays at 08:00"],
    ["0 8 * * 1,3", "Mon, Wed at 08:00"],
    ["0 3 1 * *", "Monthly on day 1 at 03:00"],
  ])("%s → %s", (expr, words) => {
    expect(describeCron(expr)).toBe(words);
  });

  it.each(["0 3 * 1 *", "0-5 * * * *", "0 3 * * 1-3", "@daily", "0 3 * *"])(
    "leaves %s to the raw expression",
    (expr) => {
      expect(describeCron(expr)).toBeNull();
    },
  );
});

describe("describeTrigger", () => {
  it.each([
    [
      { kind: "cron", title: null, label: "40 * * * * (America/Sao_Paulo)" },
      { text: "Every hour at :40", detail: "40 * * * * · America/Sao_Paulo" },
    ],
    [
      {
        kind: "upstreamTag",
        title: null,
        label: "tag ^v\\d+\\.\\d+\\.\\d+$ on https://github.com/pingdotgg/t3code",
      },
      {
        text: "New stable release of pingdotgg/t3code",
        detail: "tag ^v\\d+\\.\\d+\\.\\d+$ on https://github.com/pingdotgg/t3code",
      },
    ],
    [
      { kind: "upstreamTag", title: null, label: "tag ^v.*-beta$ on git@github.com:a/b.git" },
      { text: "New tag ^v.*-beta$ on a/b", detail: "tag ^v.*-beta$ on git@github.com:a/b.git" },
    ],
    [
      { kind: "bot", title: "Pedido do Trader", label: "bot · 1 bot" },
      { text: "Pedido do Trader", detail: "1 bot can run it" },
    ],
    [
      { kind: "cron", title: "Nightly", label: "0 3 * * * (UTC)" },
      { text: "Nightly", detail: "Daily at 03:00 (UTC) · 0 3 * * * · UTC" },
    ],
    [
      { kind: "cron", title: null, label: "0 3 * 1 * (UTC)" },
      { text: "Cron 0 3 * 1 *", detail: "0 3 * 1 * · UTC" },
    ],
    [
      { kind: "workflowFailed", title: null, label: "any failed" },
      { text: "When any workflow fails", detail: "" },
    ],
    [
      { kind: "someFutureKind", title: null, label: "something new" },
      { text: "something new", detail: "" },
    ],
  ])("%o", (trigger, expected) => {
    expect(describeTrigger(trigger, "America/Sao_Paulo")).toEqual(expected);
  });

  it("names the schedule's zone only when it differs from the viewer's", () => {
    const trigger = { kind: "cron", title: null, label: "0 21 * * * (America/Sao_Paulo)" };
    expect(describeTrigger(trigger, "America/Sao_Paulo").text).toBe("Daily at 21:00");
    expect(describeTrigger(trigger, "Europe/Lisbon").text).toBe("Daily at 21:00 (Sao Paulo)");
  });
});

it("shortRepo keeps non-GitHub remotes as written", () => {
  expect(shortRepo("https://github.com/pingdotgg/t3code.git")).toBe("pingdotgg/t3code");
  expect(shortRepo("https://gitlab.com/a/b")).toBe("https://gitlab.com/a/b");
});
