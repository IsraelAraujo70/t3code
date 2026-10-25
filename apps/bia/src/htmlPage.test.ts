import { describe, expect, it } from "vite-plus/test";

import {
  allowsPageLoad,
  BIA_HTML_THEME,
  BIA_HTML_THEME_FRAGMENT,
  externalLink,
  inlineFrameHeight,
  MAX_INLINE_PAGE_HEIGHT,
  readPageHeight,
} from "./htmlPage";
import { colors } from "./theme";

const page = "http://100.64.0.1:3794/guest/v1/bots/b_1/html/abc-html";

describe("the page frame", () => {
  it("never lets the page navigate itself away", () => {
    expect(allowsPageLoad({ url: page, isTopFrame: true }, page)).toBe(true);
    expect(allowsPageLoad({ url: `${page}#secao`, isTopFrame: true }, page)).toBe(true);
    for (const url of [
      "http://100.64.0.1:3794/guest/v1/bots",
      "https://phishing.example/login",
      "file:///data/data/com.israelaraujo.bia/files/pairing",
      "javascript:alert(1)",
    ]) {
      expect(allowsPageLoad({ url, isTopFrame: true }, page)).toBe(false);
    }
    // Frames inside the page (an embedded video) may load, as in T3.
    expect(
      allowsPageLoad({ url: "https://www.youtube.com/embed/x", isTopFrame: false }, page),
    ).toBe(true);
  });

  it("opens only http(s) windows, in the browser", () => {
    expect(externalLink("https://exemplo.com")).toBe("https://exemplo.com");
    expect(externalLink("intent://scan#Intent;end")).toBeNull();
    expect(externalLink("file:///sdcard/x")).toBeNull();
  });

  it("reads only a well-formed height from the page's messages", () => {
    expect(readPageHeight('{"type":"bia-html-height","height":512}')).toBe(512);
    for (const data of [
      "512",
      "{}",
      '{"type":"bia-html-height","height":"9e9"}',
      "not json",
      '{"type":"bia-html-height","height":-1}',
    ]) {
      expect(readPageHeight(data)).toBeNull();
    }
  });

  it("fits the page between the minimum and the inline cap", () => {
    expect(inlineFrameHeight(400, null)).toBe(400);
    expect(inlineFrameHeight(400, 237.4)).toBe(237);
    expect(inlineFrameHeight(400, 10)).toBe(80);
    expect(inlineFrameHeight(400, 99_999)).toBe(MAX_INLINE_PAGE_HEIGHT);
  });

  it("themes the page in Bia's colors on the chat's background", () => {
    expect(BIA_HTML_THEME.appearance).toBe("light");
    expect(BIA_HTML_THEME.variables["--background"]).toBe(colors.background);
    expect(BIA_HTML_THEME.variables["--accent"]).toBe(colors.primary);
    expect(BIA_HTML_THEME_FRAGMENT.startsWith("#t3-theme=")).toBe(true);
  });
});
