import type { Root } from "mdast";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

// The same parser apps/mobile uses: CommonMark plus GitHub's tables, task lists, strikethrough
// and autolinks.
const parser = unified().use(remarkParse).use(remarkGfm);

/** The markdown tree of a bot reply. A reply still streaming parses the same way. */
export function parseMarkdown(text: string): Root {
  return parser.parse(text);
}

/** Only these open outside the app; anything else in a link stays plain text. */
export function safeLinkUrl(url: string): string | null {
  try {
    const parsed = new URL(url.trim());
    return /^(?:https?|mailto|tel):$/.test(parsed.protocol) ? parsed.href : null;
  } catch {
    return null;
  }
}

/** The language a fenced block names, as the highlighter knows it; null when it knows none. */
export function codeLanguage(lang: string | null | undefined): CodeLanguage | null {
  const name = lang?.trim().toLowerCase().split(/[\s{]/, 1)[0] ?? "";
  return LANGUAGE_ALIASES[name] ?? null;
}

export type CodeLanguage =
  | "javascript"
  | "typescript"
  | "tsx"
  | "jsx"
  | "json"
  | "bash"
  | "python"
  | "html"
  | "css"
  | "sql"
  | "yaml";

const LANGUAGE_ALIASES: Readonly<Record<string, CodeLanguage>> = {
  js: "javascript",
  javascript: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  ts: "typescript",
  typescript: "typescript",
  tsx: "tsx",
  jsx: "jsx",
  json: "json",
  jsonc: "json",
  sh: "bash",
  bash: "bash",
  shell: "bash",
  zsh: "bash",
  console: "bash",
  py: "python",
  python: "python",
  html: "html",
  xml: "html",
  css: "css",
  sql: "sql",
  yaml: "yaml",
  yml: "yaml",
};
