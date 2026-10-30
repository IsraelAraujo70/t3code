#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - a dev-time generator that reads CSS and writes JSON.
/**
 * Generates the VS Code tab's "T3 Dark"/"T3 Light" theme from index.css and the Pierre syntax
 * theme (FORK.md, "VS Code in the right panel"). `--check` fails when the committed theme is stale:
 *   node scripts/friend/vscode-theme.ts [--check]
 */
import * as NodeAssert from "node:assert";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

const ROOT = NodePath.join(import.meta.dirname, "..", "..");
const WEB = NodePath.join(ROOT, "apps", "web");
export const THEME_DIR = NodePath.join(ROOT, "apps", "server", "src", "bots", "vscode", "theme");

type Declarations = Map<string, string>;

/** Declarations of one selector, by appearance. */
interface RuleTokens {
  readonly light: Declarations;
  readonly dark: Declarations;
}

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Top-level `prelude { body }` rules, with nested braces kept in the body. */
function topLevelRules(css: string): Array<{ prelude: string; body: string }> {
  const rules: Array<{ prelude: string; body: string }> = [];
  let depth = 0;
  let preludeStart = 0;
  let bodyStart = 0;
  let prelude = "";
  for (let index = 0; index < css.length; index += 1) {
    const char = css[index];
    if (char === "{") {
      if (depth === 0) {
        prelude = css.slice(preludeStart, index).trim();
        bodyStart = index + 1;
      }
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        rules.push({ prelude, body: css.slice(bodyStart, index) });
        preludeStart = index + 1;
      }
    } else if (char === ";" && depth === 0) {
      preludeStart = index + 1;
    }
  }
  return rules;
}

/** `--name: value` pairs directly in `body`, skipping nested rules. */
function declarations(body: string): Declarations {
  const found: Declarations = new Map();
  let depth = 0;
  let start = 0;
  const flush = (end: number) => {
    const text = body.slice(start, end).trim();
    const match = /^(--[\w-]+)\s*:\s*([\s\S]+)$/.exec(text);
    if (match) found.set(match[1]!, match[2]!.trim());
  };
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) start = index + 1;
    } else if (char === ";" && depth === 0) {
      flush(index);
      start = index + 1;
    }
  }
  flush(body.length);
  return found;
}

/** Collects every rule whose selector list names `selector`, in source order. */
export function tokensFor(css: string, selector: string): RuleTokens {
  const light: Declarations = new Map();
  const dark: Declarations = new Map();
  for (const rule of topLevelRules(stripComments(css))) {
    const selectors = rule.prelude.split(",").map((part) => part.trim());
    if (!selectors.includes(selector)) continue;
    for (const [name, value] of declarations(rule.body)) light.set(name, value);
    for (const nested of topLevelRules(rule.body)) {
      if (nested.prelude !== "@variant dark") continue;
      for (const [name, value] of declarations(nested.body)) dark.set(name, value);
    }
  }
  return { light, dark };
}

/** One element's custom properties, inheriting what it does not declare from `parent`. */
export interface Scope {
  readonly declared: Declarations;
  readonly parent: Scope | undefined;
  readonly appearance: "light" | "dark";
}

/** Splits on `separator` outside parentheses. */
function splitTopLevel(text: string, separator: "," | " " | "/"): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "(") depth += 1;
    else if (char === ")") depth -= 1;
    else if (depth === 0 && (separator === " " ? /\s/.test(char!) : char === separator)) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part !== "");
}

/**
 * `value` with every `var()` replaced, the way the browser computes a custom property: each
 * variable resolves on the element that declares it, from that element's own variables.
 */
export function substitute(value: string, scope: Scope): string {
  let result = "";
  let index = 0;
  while (index < value.length) {
    const start = value.indexOf("var(", index);
    if (start === -1) return result + value.slice(index);
    result += value.slice(index, start);
    let depth = 0;
    let end = start + 3;
    for (; end < value.length; end += 1) {
      if (value[end] === "(") depth += 1;
      else if (value[end] === ")" && --depth === 0) break;
    }
    const [name, ...fallback] = splitTopLevel(value.slice(start + 4, end), ",");
    result += resolveVariable(name!, scope) ?? substitute(fallback.join(","), scope);
    index = end + 1;
  }
  return result;
}

function resolveVariable(name: string, scope: Scope): string | undefined {
  for (let current: Scope | undefined = scope; current; current = current.parent) {
    const value = current.declared.get(name);
    if (value !== undefined) return substitute(value, current);
  }
  return undefined;
}

/** sRGB channels in 0..1, unclipped until written out, and alpha. */
export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly alpha: number;
}

const toLinear = (channel: number) =>
  Math.abs(channel) <= 0.04045
    ? channel / 12.92
    : Math.sign(channel) * ((Math.abs(channel) + 0.055) / 1.055) ** 2.4;
const fromLinear = (channel: number) =>
  Math.abs(channel) <= 0.0031308
    ? channel * 12.92
    : Math.sign(channel) * (1.055 * Math.abs(channel) ** (1 / 2.4) - 0.055);

/** Björn Ottosson's OKLab, the space Tailwind's palette and `--alpha()` use. */
function oklabToRgb(lightness: number, a: number, b: number): [number, number, number] {
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

function rgbToOklab({ r, g, b }: Rgba): [number, number, number] {
  const [lr, lg, lb] = [toLinear(r), toLinear(g), toLinear(b)];
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

// `none` is a missing component, which converts as zero.
const number = (text: string, percentScale = 1) =>
  text === "none"
    ? 0
    : text.endsWith("%")
      ? (Number.parseFloat(text) / 100) * percentScale
      : Number.parseFloat(text);

const KEYWORDS: Record<string, Rgba> = {
  transparent: { r: 0, g: 0, b: 0, alpha: 0 },
  white: { r: 1, g: 1, b: 1, alpha: 1 },
  black: { r: 0, g: 0, b: 0, alpha: 1 },
};

/** Channels and alpha as they would be after splitting on "/". */
function channelsAndAlpha(args: string): { channels: string[]; alpha: number } {
  const [channels, alpha] = splitTopLevel(args, "/");
  return {
    channels: splitTopLevel(channels!.replaceAll(",", " "), " "),
    alpha: alpha === undefined ? 1 : number(alpha),
  };
}

/** `color-mix()` per CSS Color 5: premultiplied interpolation, percentages normalized. */
function colorMix(args: string, appearance: "light" | "dark"): Rgba {
  const [method, ...colors] = splitTopLevel(args, ",");
  const space = method!.replace(/^in\s+/, "").trim();
  NodeAssert.ok(space === "srgb" || space === "oklab", `unsupported color-mix space: ${space}`);
  NodeAssert.equal(colors.length, 2, `color-mix needs two colors: ${args}`);
  const parsed = colors.map((part) => {
    const tokens = splitTopLevel(part, " ");
    const percent = tokens.find((token) => /^-?[\d.]+%$/.test(token));
    const color = tokens.filter((token) => token !== percent).join(" ");
    return { color: parseColor(color, appearance), weight: percent ? number(percent) : undefined };
  });
  let [first, second] = [parsed[0]!.weight, parsed[1]!.weight];
  if (first === undefined && second === undefined) [first, second] = [0.5, 0.5];
  else if (first === undefined) first = 1 - second!;
  else if (second === undefined) second = 1 - first;
  const sum = first + second!;
  const alphaScale = sum < 1 ? sum : 1;
  const weights = sum === 0 ? [0, 0] : [first / sum, second! / sum];
  const components = parsed.map(({ color }) =>
    space === "srgb" ? [color.r, color.g, color.b] : rgbToOklab(color),
  );
  const alpha = parsed[0]!.color.alpha * weights[0]! + parsed[1]!.color.alpha * weights[1]!;
  const mixed = [0, 1, 2].map((channel) =>
    alpha === 0
      ? 0
      : (components[0]![channel]! * parsed[0]!.color.alpha * weights[0]! +
          components[1]![channel]! * parsed[1]!.color.alpha * weights[1]!) /
        alpha,
  ) as [number, number, number];
  const [r, g, b] = space === "srgb" ? mixed : oklabToRgb(...mixed);
  return { r, g, b, alpha: alpha * alphaScale };
}

/** A var-free CSS color: hex, keywords, rgb(), oklch(), color-mix(), light-dark(), --alpha(). */
export function parseColor(text: string, appearance: "light" | "dark"): Rgba {
  const value = text.trim();
  const keyword = KEYWORDS[value.toLowerCase()];
  if (keyword) return keyword;
  const hex = /^#([0-9a-f]{3,8})$/i.exec(value)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((digit) => digit + digit).join("") : hex;
    const byte = (start: number) => Number.parseInt(full.slice(start, start + 2), 16) / 255;
    return { r: byte(0), g: byte(2), b: byte(4), alpha: full.length === 8 ? byte(6) : 1 };
  }
  const call = /^(--alpha|[a-z-]+)\(([\s\S]*)\)$/i.exec(value);
  NodeAssert.ok(call, `unsupported color: ${value}`);
  const [, fn, args] = call;
  switch (fn!.toLowerCase()) {
    case "rgb":
    case "rgba": {
      const { channels, alpha } = channelsAndAlpha(args!);
      const [r, g, b] = channels.map((channel) => number(channel, 255) / 255);
      return { r: r!, g: g!, b: b!, alpha };
    }
    case "oklch": {
      const { channels, alpha } = channelsAndAlpha(args!);
      const lightness = number(channels[0]!);
      const chroma = number(channels[1]!, 0.4);
      const hue = (number(channels[2]!) * Math.PI) / 180;
      const [r, g, b] = oklabToRgb(lightness, chroma * Math.cos(hue), chroma * Math.sin(hue));
      return { r, g, b, alpha };
    }
    case "color-mix":
      return colorMix(args!, appearance);
    case "light-dark": {
      const [light, dark] = splitTopLevel(args!, ",");
      return parseColor(appearance === "dark" ? dark! : light!, appearance);
    }
    case "--alpha": {
      // Tailwind compiles `--alpha(color / n%)` to this.
      const [color, percent] = splitTopLevel(args!, "/");
      return colorMix(`in oklab, ${color} ${percent}, transparent`, appearance);
    }
  }
  throw new Error(`unsupported color function: ${fn}`);
}

const byte = (channel: number) =>
  Math.round(Math.min(Math.max(channel, 0), 1) * 255)
    .toString(16)
    .padStart(2, "0");

/** `#rrggbb`, or `#rrggbbaa` when not opaque; channels outside sRGB are clipped like the browser. */
export function toHex(color: Rgba): string {
  const alpha = Math.round(color.alpha * 255);
  return `#${byte(color.r)}${byte(color.g)}${byte(color.b)}${alpha === 255 ? "" : byte(color.alpha)}`;
}

/**
 * Workbench colors as CSS over T3's tokens. `app` keys read the root's tokens, `sidebar` keys the
 * app sidebar's, which T3 overrides (pure black in dark mode, zinc in light).
 */
const APP_COLORS: Record<string, string> = {
  foreground: "var(--foreground)",
  descriptionForeground: "var(--muted-foreground)",
  disabledForeground: "color-mix(in srgb, var(--muted-foreground) 60%, transparent)",
  errorForeground: "var(--error-foreground)",
  focusBorder: "var(--ring)",
  "icon.foreground": "var(--muted-foreground)",
  "selection.background": "var(--terminal-selection-background)",
  "widget.border": "var(--border)",
  "widget.shadow": "rgb(0 0 0 / 20%)",
  "sash.hoverBorder": "var(--ring)",
  "textLink.foreground": "var(--info-foreground)",
  "textLink.activeForeground": "var(--info-foreground)",
  "textPreformat.foreground": "var(--foreground)",
  "textPreformat.background": "var(--muted)",
  "textBlockQuote.background": "var(--muted)",
  "textBlockQuote.border": "var(--border)",
  "textCodeBlock.background": "var(--code-background)",
  "textSeparator.foreground": "var(--border)",

  "button.background": "var(--primary)",
  "button.foreground": "var(--primary-foreground)",
  "button.hoverBackground": "var(--message-action-hover)",
  "button.border": "transparent",
  "button.separator": "color-mix(in srgb, var(--primary-foreground) 40%, transparent)",
  "button.secondaryBackground": "var(--secondary)",
  "button.secondaryForeground": "var(--secondary-foreground)",
  "button.secondaryHoverBackground": "var(--accent)",
  "checkbox.background": "var(--card)",
  "checkbox.border": "var(--input)",
  "checkbox.foreground": "var(--foreground)",
  "dropdown.background": "var(--popover)",
  "dropdown.listBackground": "var(--popover)",
  "dropdown.border": "var(--input)",
  "dropdown.foreground": "var(--popover-foreground)",
  "input.background": "var(--card)",
  "input.border": "var(--input)",
  "input.foreground": "var(--foreground)",
  "input.placeholderForeground": "var(--placeholder)",
  "inputOption.activeBackground": "color-mix(in srgb, var(--primary) 20%, transparent)",
  "inputOption.activeBorder": "var(--ring)",
  "inputOption.activeForeground": "var(--foreground)",
  "inputValidation.errorBackground": "var(--popover)",
  "inputValidation.errorBorder": "var(--error)",
  "inputValidation.infoBackground": "var(--popover)",
  "inputValidation.infoBorder": "var(--info)",
  "inputValidation.warningBackground": "var(--popover)",
  "inputValidation.warningBorder": "var(--warning)",
  "badge.background": "var(--primary)",
  "badge.foreground": "var(--primary-foreground)",
  "progressBar.background": "var(--primary)",
  "scrollbar.shadow": "transparent",
  "scrollbarSlider.background": "var(--app-scrollbar-thumb)",
  "scrollbarSlider.hoverBackground": "var(--app-scrollbar-thumb-hover)",
  "scrollbarSlider.activeBackground": "var(--app-scrollbar-thumb-hover)",

  "editor.background": "var(--background)",
  "editor.foreground": "var(--foreground)",
  "editorCursor.foreground": "var(--terminal-cursor)",
  "editor.selectionBackground": "var(--terminal-selection-background)",
  "editor.inactiveSelectionBackground":
    "color-mix(in srgb, var(--terminal-selection-background) 60%, transparent)",
  "editor.selectionHighlightBackground":
    "color-mix(in srgb, var(--terminal-selection-background) 50%, transparent)",
  "editor.wordHighlightBackground":
    "color-mix(in srgb, var(--terminal-selection-background) 50%, transparent)",
  "editor.wordHighlightStrongBackground":
    "color-mix(in srgb, var(--terminal-selection-background) 70%, transparent)",
  "editor.findMatchBackground": "color-mix(in srgb, var(--warning) 45%, transparent)",
  "editor.findMatchHighlightBackground": "color-mix(in srgb, var(--warning) 22%, transparent)",
  "editor.lineHighlightBackground": "var(--accent)",
  "editor.lineHighlightBorder": "transparent",
  "editorLineNumber.foreground": "color-mix(in srgb, var(--muted-foreground) 65%, transparent)",
  "editorLineNumber.activeForeground": "var(--foreground)",
  "editorIndentGuide.background1": "var(--border)",
  "editorIndentGuide.activeBackground1": "var(--input)",
  "editorWhitespace.foreground": "var(--border)",
  "editorRuler.foreground": "var(--border)",
  "editorBracketMatch.background": "var(--accent)",
  "editorBracketMatch.border": "var(--input)",
  "editorGutter.background": "var(--background)",
  "editorGutter.addedBackground": "var(--diff-addition)",
  "editorGutter.modifiedBackground": "var(--info)",
  "editorGutter.deletedBackground": "var(--diff-deletion)",
  "editorError.foreground": "var(--error)",
  "editorWarning.foreground": "var(--warning)",
  "editorInfo.foreground": "var(--info)",
  "editorLink.activeForeground": "var(--info-foreground)",
  "editorOverviewRuler.border": "transparent",
  "editorWidget.background": "var(--popover)",
  "editorWidget.foreground": "var(--popover-foreground)",
  "editorWidget.border": "var(--border)",
  "editorSuggestWidget.background": "var(--popover)",
  "editorSuggestWidget.border": "var(--border)",
  "editorSuggestWidget.foreground": "var(--popover-foreground)",
  "editorSuggestWidget.selectedBackground": "var(--accent)",
  "editorSuggestWidget.highlightForeground": "var(--primary)",
  "editorHoverWidget.background": "var(--popover)",
  "editorHoverWidget.border": "var(--border)",
  "editorStickyScroll.background": "var(--background)",
  "editorStickyScrollHover.background": "var(--accent)",
  "diffEditor.insertedTextBackground": "color-mix(in srgb, var(--diff-addition) 18%, transparent)",
  "diffEditor.insertedLineBackground": "color-mix(in srgb, var(--diff-addition) 10%, transparent)",
  "diffEditor.removedTextBackground": "color-mix(in srgb, var(--diff-deletion) 18%, transparent)",
  "diffEditor.removedLineBackground": "color-mix(in srgb, var(--diff-deletion) 10%, transparent)",
  "diffEditor.border": "var(--border)",
  "peekView.border": "var(--ring)",
  "peekViewEditor.background": "var(--background)",
  "peekViewResult.background": "var(--card)",
  "peekViewTitle.background": "var(--card)",
  "minimap.background": "var(--background)",

  "editorGroup.border": "var(--border)",
  "editorGroupHeader.tabsBackground": "var(--background)",
  "editorGroupHeader.tabsBorder": "var(--border)",
  "editorGroupHeader.noTabsBackground": "var(--background)",
  "tab.activeBackground": "var(--background)",
  "tab.activeForeground": "var(--foreground)",
  "tab.activeBorder": "var(--background)",
  "tab.activeBorderTop": "var(--primary)",
  "tab.inactiveBackground": "var(--background)",
  "tab.inactiveForeground": "var(--muted-foreground)",
  "tab.hoverBackground": "var(--accent)",
  "tab.border": "var(--border)",
  "tab.unfocusedActiveBorderTop": "var(--border)",
  "breadcrumb.foreground": "var(--muted-foreground)",
  "breadcrumb.focusForeground": "var(--foreground)",
  "breadcrumb.activeSelectionForeground": "var(--foreground)",
  "breadcrumb.background": "var(--background)",

  "panel.background": "var(--background)",
  "panel.border": "var(--border)",
  "panelTitle.activeForeground": "var(--foreground)",
  "panelTitle.inactiveForeground": "var(--muted-foreground)",
  "panelTitle.activeBorder": "var(--primary)",
  "panelInput.border": "var(--input)",
  "terminal.background": "var(--terminal-background)",
  "terminal.foreground": "var(--terminal-foreground)",
  "terminalCursor.foreground": "var(--terminal-cursor)",
  "terminal.selectionBackground": "var(--terminal-selection-background)",
  "terminal.border": "var(--border)",

  "menu.background": "var(--popover)",
  "menu.foreground": "var(--popover-foreground)",
  "menu.border": "var(--border)",
  "menu.separatorBackground": "var(--border)",
  "menu.selectionBackground": "var(--accent)",
  "menu.selectionForeground": "var(--accent-foreground)",
  "quickInput.background": "var(--popover)",
  "quickInput.foreground": "var(--popover-foreground)",
  "quickInputTitle.background": "var(--popover)",
  "quickInputList.focusBackground": "var(--accent)",
  "quickInputList.focusForeground": "var(--accent-foreground)",
  "pickerGroup.border": "var(--border)",
  "pickerGroup.foreground": "var(--muted-foreground)",
  "keybindingLabel.background": "var(--muted)",
  "keybindingLabel.foreground": "var(--foreground)",
  "keybindingLabel.border": "var(--border)",
  "keybindingLabel.bottomBorder": "var(--border)",
  "notifications.background": "var(--popover)",
  "notifications.foreground": "var(--popover-foreground)",
  "notifications.border": "var(--border)",
  "notificationCenterHeader.background": "var(--popover)",
  "notificationToast.border": "var(--border)",
  "notificationsErrorIcon.foreground": "var(--error)",
  "notificationsWarningIcon.foreground": "var(--warning)",
  "notificationsInfoIcon.foreground": "var(--info)",
  "settings.headerForeground": "var(--foreground)",
  "settings.modifiedItemIndicator": "var(--primary)",
  "welcomePage.background": "var(--background)",
  "walkThrough.embeddedEditorBackground": "var(--code-background)",

  "gitDecoration.addedResourceForeground": "var(--success-foreground)",
  "gitDecoration.untrackedResourceForeground": "var(--success-foreground)",
  "gitDecoration.modifiedResourceForeground": "var(--diff-modified-icon)",
  "gitDecoration.deletedResourceForeground": "var(--error-foreground)",
  "gitDecoration.conflictingResourceForeground": "var(--warning-foreground)",
  "gitDecoration.ignoredResourceForeground": "var(--muted-foreground)",
};

const SIDEBAR_COLORS: Record<string, string> = {
  "titleBar.activeBackground": "var(--sidebar)",
  "titleBar.activeForeground": "var(--sidebar-foreground)",
  "titleBar.inactiveBackground": "var(--sidebar)",
  "titleBar.inactiveForeground": "var(--sidebar-muted-foreground)",
  "titleBar.border": "var(--sidebar-border)",
  "activityBar.background": "var(--sidebar)",
  "activityBar.foreground": "var(--sidebar-foreground)",
  "activityBar.inactiveForeground": "var(--sidebar-muted-foreground)",
  "activityBar.border": "var(--sidebar-border)",
  "activityBar.activeBorder": "var(--sidebar-foreground)",
  "activityBar.activeBackground": "var(--sidebar-row-active)",
  "activityBarBadge.background": "var(--primary)",
  "activityBarBadge.foreground": "var(--primary-foreground)",
  "sideBar.background": "var(--sidebar)",
  "sideBar.foreground": "var(--sidebar-foreground)",
  "sideBar.border": "var(--sidebar-border)",
  "sideBarTitle.foreground": "var(--sidebar-foreground)",
  "sideBarSectionHeader.background": "var(--sidebar)",
  "sideBarSectionHeader.foreground": "var(--sidebar-foreground)",
  "sideBarSectionHeader.border": "var(--sidebar-border)",
  "sideBarStickyScroll.background": "var(--sidebar)",
  "list.hoverBackground": "var(--sidebar-row-hover)",
  "list.activeSelectionBackground": "var(--sidebar-row-active)",
  "list.activeSelectionForeground": "var(--sidebar-foreground)",
  "list.inactiveSelectionBackground": "var(--sidebar-row-selected)",
  "list.inactiveSelectionForeground": "var(--sidebar-foreground)",
  "list.focusBackground": "var(--sidebar-row-active)",
  "list.focusOutline": "var(--ring)",
  "list.highlightForeground": "var(--primary)",
  "list.errorForeground": "var(--error-foreground)",
  "list.warningForeground": "var(--warning-foreground)",
  "tree.indentGuidesStroke": "var(--sidebar-border)",
  "statusBar.background": "var(--sidebar)",
  "statusBar.foreground": "var(--sidebar-muted-foreground)",
  "statusBar.border": "var(--sidebar-border)",
  "statusBar.noFolderBackground": "var(--sidebar)",
  "statusBar.debuggingBackground": "var(--warning)",
  "statusBar.debuggingForeground": "#000",
  "statusBarItem.hoverBackground": "var(--sidebar-row-hover)",
  "statusBarItem.prominentBackground": "var(--sidebar-row-active)",
  "statusBarItem.prominentForeground": "var(--sidebar-foreground)",
  "statusBarItem.prominentHoverBackground": "var(--sidebar-row-hover)",
  "statusBarItem.remoteBackground": "var(--sidebar)",
  "statusBarItem.remoteForeground": "var(--sidebar-foreground)",
};

/** Everything the theme reads from the repo, so tests can build it without the filesystem. */
export interface ThemeSources {
  /** apps/web/src/index.css */
  readonly appCss: string;
  /** tailwindcss/theme.css, the palette the tokens name. */
  readonly tailwindCss: string;
  /** @pierre/theme's VS Code themes, the palette T3's code highlighting uses. */
  readonly pierreDark: VsCodeThemeJson;
  readonly pierreLight: VsCodeThemeJson;
  /** t3-light's darkening of pierre-light syntax colors (readableSyntaxTheme.ts). */
  readonly readableSyntaxColor: (color: string) => string;
  readonly codeFontFamily: string;
  readonly codeFontSize: number;
}

interface TokenColor {
  readonly name?: string;
  readonly scope?: string | readonly string[];
  readonly settings: { readonly foreground?: string; readonly fontStyle?: string };
}

/** The parts of a VS Code color theme this generator reads or writes. */
export interface VsCodeThemeJson {
  readonly name?: string;
  readonly type?: string;
  readonly colors?: Record<string, string>;
  readonly tokenColors: readonly TokenColor[];
  readonly semanticHighlighting?: boolean;
  readonly semanticTokenColors?: Record<string, string | { readonly foreground?: string }>;
}

export const THEME_LABELS = { dark: "T3 Dark", light: "T3 Light" } as const;

function scopes(sources: ThemeSources) {
  const tailwind = tokensFor(sources.tailwindCss, "@theme default");
  const theme = tokensFor(sources.appCss, "@theme");
  const themeInline = tokensFor(sources.appCss, "@theme inline");
  const root = tokensFor(sources.appCss, ":root");
  const sidebar = tokensFor(sources.appCss, "[data-app-sidebar]");
  const build = (appearance: "light" | "dark") => {
    const merge = (...maps: Declarations[]) => new Map(maps.flatMap((map) => [...map]));
    const pick = (tokens: RuleTokens) =>
      appearance === "dark" ? merge(tokens.light, tokens.dark) : tokens.light;
    const app: Scope = {
      declared: merge(tailwind.light, theme.light, themeInline.light, pick(root)),
      parent: undefined,
      appearance,
    };
    return { app, sidebar: { declared: pick(sidebar), parent: app, appearance } satisfies Scope };
  };
  return { light: build("light"), dark: build("dark") };
}

/** Each workbench color as the var-free CSS it was computed from, for checking against a browser. */
export function resolvedCss(sources: ThemeSources, appearance: "light" | "dark") {
  const scope = scopes(sources)[appearance];
  return {
    ...Object.fromEntries(
      Object.entries(APP_COLORS).map(([key, css]) => [key, substitute(css, scope.app)]),
    ),
    ...Object.fromEntries(
      Object.entries(SIDEBAR_COLORS).map(([key, css]) => [key, substitute(css, scope.sidebar)]),
    ),
  } as Record<string, string>;
}

function recolor(theme: VsCodeThemeJson, map: (color: string) => string) {
  const tokenColors = theme.tokenColors.map((rule) =>
    rule.settings.foreground === undefined
      ? rule
      : { ...rule, settings: { ...rule.settings, foreground: map(rule.settings.foreground) } },
  );
  const semanticTokenColors = Object.fromEntries(
    Object.entries(theme.semanticTokenColors ?? {}).map(([selector, style]) => [
      selector,
      typeof style === "string"
        ? map(style)
        : style.foreground === undefined
          ? style
          : { ...style, foreground: map(style.foreground) },
    ]),
  );
  return { tokenColors, semanticTokenColors };
}

/** The extension's files, path relative to the extension root mapped to JSON content. */
export function buildThemeExtension(sources: ThemeSources): Record<string, unknown> {
  const theme = (appearance: "light" | "dark") => {
    const css = resolvedCss(sources, appearance);
    const colors = Object.fromEntries(
      Object.entries(css).map(([key, value]) => [key, toHex(parseColor(value, appearance))]),
    );
    const syntax =
      appearance === "dark"
        ? recolor(sources.pierreDark, (color) => color)
        : recolor(sources.pierreLight, sources.readableSyntaxColor);
    return {
      $schema: "vscode://schemas/color-theme",
      name: THEME_LABELS[appearance],
      type: appearance,
      semanticHighlighting: true,
      colors,
      ...syntax,
    };
  };
  return {
    "package.json": {
      name: "t3-theme",
      displayName: "T3 Code Theme",
      description:
        "T3 Code's default look, generated by scripts/friend/vscode-theme.ts. Syntax colors from @pierre/theme (Apache-2.0).",
      version: "1.0.0",
      publisher: "t3code",
      license: "Apache-2.0",
      engines: { vscode: "^1.80.0" },
      categories: ["Themes"],
      contributes: {
        themes: [
          { label: THEME_LABELS.dark, uiTheme: "vs-dark", path: "./themes/t3-dark.json" },
          { label: THEME_LABELS.light, uiTheme: "vs", path: "./themes/t3-light.json" },
        ],
        // Defaults only: anything the user sets in VS Code wins over these.
        configurationDefaults: {
          "window.autoDetectColorScheme": true,
          "workbench.preferredDarkColorTheme": THEME_LABELS.dark,
          "workbench.preferredLightColorTheme": THEME_LABELS.light,
          "workbench.colorTheme": THEME_LABELS.dark,
          "editor.fontFamily": sources.codeFontFamily,
          "editor.fontSize": sources.codeFontSize,
          "terminal.integrated.fontSize": sources.codeFontSize,
        },
      },
    },
    "themes/t3-dark.json": theme("dark"),
    "themes/t3-light.json": theme("light"),
  };
}

/** Reads the theme's inputs from this checkout. */
export async function readSources(): Promise<ThemeSources> {
  const webRequire = NodeModule.createRequire(NodePath.join(WEB, "package.json"));
  // @pierre/theme comes with @pierre/diffs, the highlighter T3 renders code with.
  const diffsDir = NodeFS.realpathSync(NodePath.join(WEB, "node_modules", "@pierre", "diffs"));
  const diffsRequire = NodeModule.createRequire(NodePath.join(diffsDir, "package.json"));
  const readJson = (path: string) => JSON.parse(NodeFS.readFileSync(path, "utf8"));
  // Loaded at run time: the scripts project does not typecheck the web app or contracts.
  const exported = async (path: string, name: string, type: "function" | "string" | "number") => {
    const value: unknown = (await import(path))[name];
    NodeAssert.equal(typeof value, type, `${name} in ${path} is not a ${type}`);
    return value;
  };
  const readableSyntaxColor = (await exported(
    NodePath.join(WEB, "src", "lib", "readableSyntaxTheme.ts"),
    "readableSyntaxColor",
    "function",
  )) as (color: string) => string;
  const codeFontFamily = (await exported(
    NodePath.join(WEB, "src", "appearanceFonts.ts"),
    "DEFAULT_CODE_FONT_STACK",
    "string",
  )) as string;
  const codeFontSize = (await exported(
    NodePath.join(ROOT, "packages", "contracts", "src", "settings.ts"),
    "DEFAULT_CODE_FONT_SIZE",
    "number",
  )) as number;
  return {
    appCss: NodeFS.readFileSync(NodePath.join(WEB, "src", "index.css"), "utf8"),
    tailwindCss: NodeFS.readFileSync(webRequire.resolve("tailwindcss/theme.css"), "utf8"),
    pierreDark: readJson(diffsRequire.resolve("@pierre/theme/themes/pierre-dark.json")),
    pierreLight: readJson(diffsRequire.resolve("@pierre/theme/themes/pierre-light.json")),
    readableSyntaxColor,
    codeFontFamily,
    codeFontSize,
  };
}

/** Paths of the extension's files that differ from what the sources produce now. */
export function staleFiles(files: Record<string, unknown>, dir = THEME_DIR): string[] {
  return Object.entries(files).flatMap(([path, content]) => {
    const file = NodePath.join(dir, path);
    if (!NodeFS.existsSync(file)) return [path];
    try {
      NodeAssert.deepStrictEqual(JSON.parse(NodeFS.readFileSync(file, "utf8")), content);
      return [];
    } catch {
      return [path];
    }
  });
}

async function main() {
  const files = buildThemeExtension(await readSources());
  if (NodeProcess.argv.includes("--check")) {
    const stale = staleFiles(files);
    if (stale.length > 0) {
      NodeProcess.stderr.write(
        `Stale VS Code theme: ${stale.join(", ")}. Run node scripts/friend/vscode-theme.ts.\n`,
      );
      NodeProcess.exit(1);
    }
    NodeProcess.stdout.write("VS Code theme is up to date.\n");
    return;
  }
  for (const [path, content] of Object.entries(files)) {
    const file = NodePath.join(THEME_DIR, path);
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(file, `${JSON.stringify(content, null, 2)}\n`);
  }
  const pierreDir = NodeFS.realpathSync(
    NodePath.join(
      NodeFS.realpathSync(NodePath.join(WEB, "node_modules", "@pierre", "diffs")),
      "..",
      "theme",
    ),
  );
  NodeFS.copyFileSync(NodePath.join(pierreDir, "LICENSE"), NodePath.join(THEME_DIR, "LICENSE"));
  NodeFS.copyFileSync(NodePath.join(pierreDir, "NOTICE.md"), NodePath.join(THEME_DIR, "NOTICE.md"));
  NodeChildProcess.execFileSync("vp", ["fmt", THEME_DIR], { cwd: ROOT, stdio: "inherit" });
  NodeProcess.stdout.write(
    `Wrote ${Object.keys(files).join(", ")} to ${NodePath.relative(ROOT, THEME_DIR)}.\n`,
  );
}

if (import.meta.main) await main();
