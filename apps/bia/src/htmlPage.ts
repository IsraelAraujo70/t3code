import {
  HTML_RENDER_DEFAULT_FONTS,
  HTML_RENDER_MIN_HEIGHT,
  htmlRenderTheme,
  htmlRenderThemeFragment,
  type HtmlRenderTheme,
} from "@t3tools/shared/htmlRender";
import { T3_CODE_LIGHT_THEME_COLORS } from "@t3tools/shared/themePalettes";

import { colors } from "./theme";

/** A page taller than this scrolls inside its frame; the full-screen view shows all of it. */
export const MAX_INLINE_PAGE_HEIGHT = 1_400;

/** T3's light theme in Bia's colors, so a page sits on the chat's own background. */
export const BIA_HTML_THEME: HtmlRenderTheme = htmlRenderTheme(
  {
    ...T3_CODE_LIGHT_THEME_COLORS,
    canvas: colors.background,
    text: colors.text,
    textMuted: colors.muted,
    mutedForeground: colors.muted,
    surface: colors.card,
    surfaceOverlay: colors.card,
    border: colors.border,
    focus: colors.primary,
    accent: colors.primary,
    accentForeground: colors.userText,
    accentSurface: colors.primarySoft,
    accentSurfaceForeground: colors.primary,
    messageAction: colors.primary,
    messageActionForeground: colors.userText,
    codeBackground: colors.codeBackground,
    codeForeground: colors.codeText,
  },
  "light",
  HTML_RENDER_DEFAULT_FONTS,
);

export const BIA_HTML_THEME_FRAGMENT = htmlRenderThemeFragment(BIA_HTML_THEME);

const HEIGHT_MESSAGE = "bia-html-height";

/**
 * Injected into the page: reports its content height, measured the way T3's bootstrap does, so
 * the frame fits the page. The page itself can call the same bridge, so the app reads only a
 * bounded number from it.
 */
export const REPORT_HEIGHT_SCRIPT = `(function(){var h;function r(){var d=document.documentElement,v=Math.ceil(d.scrollHeight>d.clientHeight?d.scrollHeight:d.getBoundingClientRect().height);if(v===h)return;h=v;window.ReactNativeWebView.postMessage(JSON.stringify({type:${JSON.stringify(HEIGHT_MESSAGE)},height:v}));}r();if(window.ResizeObserver){var o=new ResizeObserver(r);o.observe(document.documentElement);if(document.body)o.observe(document.body);}document.addEventListener("DOMContentLoaded",r);window.addEventListener("load",r);})();true;`;

/** The height a page reported, or null for any other message. */
export function readPageHeight(data: string): number | null {
  try {
    const message: unknown = JSON.parse(data);
    if (typeof message !== "object" || message === null) return null;
    const { type, height } = message as { type?: unknown; height?: unknown };
    return type === HEIGHT_MESSAGE &&
      typeof height === "number" &&
      Number.isFinite(height) &&
      height > 0
      ? height
      : null;
  } catch {
    return null;
  }
}

/** The inline frame's height: the page's own once it reported one, else what the bot asked. */
export function inlineFrameHeight(requested: number, measured: number | null): number {
  return Math.round(
    Math.min(MAX_INLINE_PAGE_HEIGHT, Math.max(HTML_RENDER_MIN_HEIGHT, measured ?? requested)),
  );
}

const withoutFragment = (url: string) => url.split("#", 1)[0];

/**
 * The frame stays on its page, as in T3: frames inside it may load, but the page itself never
 * navigates away. Links open in the browser instead (the bootstrap turns them into new windows).
 */
export function allowsPageLoad(
  request: { readonly url: string; readonly isTopFrame?: boolean },
  pageUrl: string,
): boolean {
  return request.isTopFrame === false || withoutFragment(request.url) === withoutFragment(pageUrl);
}

/** Only web links leave the app, in the browser. */
export const externalLink = (url: string) => (/^https?:\/\//i.test(url) ? url : null);
