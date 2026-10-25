import { createHighlighterCoreSync, type HighlighterCore } from "@shikijs/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import bash from "@shikijs/langs/bash";
import css from "@shikijs/langs/css";
import html from "@shikijs/langs/html";
import javascript from "@shikijs/langs/javascript";
import json from "@shikijs/langs/json";
import jsx from "@shikijs/langs/jsx";
import python from "@shikijs/langs/python";
import sql from "@shikijs/langs/sql";
import tsx from "@shikijs/langs/tsx";
import typescript from "@shikijs/langs/typescript";
import yaml from "@shikijs/langs/yaml";
import githubLight from "@shikijs/themes/github-light";

import type { CodeLanguage } from "./markdown";

export interface CodeToken {
  readonly content: string;
  readonly color: string | undefined;
}

const THEME = "github-light";
/** Longer blocks show as plain text: tokenizing them on every streamed chunk would stall. */
const MAX_HIGHLIGHT_CHARS = 20_000;

let highlighter: HighlighterCore | null = null;

// The JavaScript regex engine, as in apps/mobile: no native Oniguruma to build. Created on the
// first code block, so a chat without code never pays for the grammars. Hermes has no RegExp `v`
// or `d` flag, so the grammars compile to ES2018, skipping the few patterns that cannot.
function getHighlighter(): HighlighterCore {
  highlighter ??= createHighlighterCoreSync({
    themes: [githubLight],
    langs: [bash, css, html, javascript, json, jsx, python, sql, tsx, typescript, yaml],
    engine: createJavaScriptRegexEngine({ target: "ES2018", forgiving: true }),
  });
  return highlighter;
}

/** One array of tokens per line; plain text (no colors) when the language is unknown. */
export function highlightCode(
  code: string,
  language: CodeLanguage | null,
): ReadonlyArray<ReadonlyArray<CodeToken>> {
  if (language === null || code.length > MAX_HIGHLIGHT_CHARS) {
    return code.split("\n").map((line) => [{ content: line, color: undefined }]);
  }
  try {
    return getHighlighter()
      .codeToTokensBase(code, { lang: language, theme: THEME })
      .map((line) => line.map((token) => ({ content: token.content, color: token.color })));
  } catch (error) {
    console.warn("Code highlighting failed", error);
    return code.split("\n").map((line) => [{ content: line, color: undefined }]);
  }
}
