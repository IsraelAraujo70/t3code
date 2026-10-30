/**
 * A reply as text to be read aloud word for word. The realtime voice paraphrases whatever it is
 * asked to describe, so markup never reaches it: markdown is dropped, and what has no spoken form
 * (a code block, a table, a URL, a long inline command) becomes a short phrase in the voice's
 * language.
 */

/** The phrases that stand in for what cannot be read aloud, in one language. */
export interface SpokenStandIns {
  /** One sentence for a fenced code block. */
  readonly codeBlock: string;
  /** One sentence for a table. */
  readonly table: string;
  /** A few words for a URL. */
  readonly link: string;
  /** A few words for inline code too long to say. */
  readonly code: string;
}

/** Inline code up to this many characters is said; longer is replaced with `SpokenStandIns.code`. */
const SAYABLE_CODE_CHARS = 32;

/** Short code as it is; a long path by its last segment; anything else has no spoken form. */
const sayableCode = (code: string) => {
  if (code.length <= SAYABLE_CODE_CHARS) return code;
  const name = /^[^\s]*\/([^\s/]+)\/?$/u.exec(code)?.[1];
  return name !== undefined && name.length <= SAYABLE_CODE_CHARS ? name : null;
};

const TABLE_SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/u;

const endSentence = (text: string) => (/[.!?…:;]$/u.test(text) ? text : `${text}.`);

const inline = (line: string, standIns: SpokenStandIns) =>
  line
    .replace(/`([^`]+)`/gu, (_, code: string) => sayableCode(code) ?? standIns.code)
    .replace(/!?\[([^\]]*)\]\((?:[^()\s]|\([^()\s]*\))*\)/gu, "$1")
    .replace(/<https?:\/\/[^>\s]+>/gu, standIns.link)
    // Punctuation right after a URL ends the sentence; balanced parentheses belong to the URL.
    .replace(
      /https?:\/\/(?:[^\s()<>\]]|\([^\s()]*\))*(?:[^\s()<>\].,;:!?]|\([^\s()]*\))/gu,
      standIns.link,
    )
    .replace(/(\*\*|~~)(?=\S)(.+?)(?<=\S)\1/gu, "$2")
    .replace(/(^|[^\p{L}\p{N}_])__(?=\S)(.+?)(?<=\S)__(?![\p{L}\p{N}_])/gu, "$1$2")
    .replace(/(^|[^\p{L}\p{N}*])\*(?=\S)([^*]+?)(?<=\S)\*(?![\p{L}\p{N}])/gu, "$1$2")
    .replace(/(^|[^\p{L}\p{N}_])_(?=\S)([^_]+?)(?<=\S)_(?![\p{L}\p{N}])/gu, "$1$2")
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, "")
    .replace(/[ \t]+/gu, " ")
    .trim();

/**
 * `reply` with its markdown turned into plain spoken text. Paragraphs stay separated by a blank
 * line; a heading or a list item becomes a sentence of its own.
 */
export const speakable = (reply: string, standIns: SpokenStandIns): string => {
  const out: string[] = [];
  const lines = reply.replace(/\r\n?/gu, "\n").split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const fence = /^\s*(```|~~~)/u.exec(line);
    if (fence !== null) {
      while (index + 1 < lines.length && !lines[index + 1]!.trimStart().startsWith(fence[1]!))
        index++;
      index++;
      out.push(standIns.codeBlock);
      continue;
    }
    // A table is a row of cells over a separator row, with or without outer pipes.
    if (line.includes("|") && TABLE_SEPARATOR.test(lines[index + 1] ?? "")) {
      index++;
      while (index + 1 < lines.length && lines[index + 1]!.includes("|")) index++;
      out.push(standIns.table);
      continue;
    }
    if (/^\s*([-*_]\s*){3,}$/u.test(line)) continue;
    const heading = /^\s*#{1,6}\s+(.*)$/u.exec(line);
    // Up to three digits: "2026. foi" opens a sentence, not a list.
    const item = /^\s*(?:[-*+]|\d{1,3}[.)])\s+(.*)$/u.exec(line);
    const quote = /^\s*>\s?(.*)$/u.exec(line);
    // A line that is bold and nothing else is a heading too.
    const title = heading ?? /^\s*(?:\*\*|__)([^*_]+)(?:\*\*|__)\s*$/u.exec(line);
    const text = inline(title?.[1] ?? item?.[1] ?? quote?.[1] ?? line, standIns);
    if (text === "") {
      if (out.at(-1) !== "") out.push("");
      continue;
    }
    out.push(title !== null || item !== null ? endSentence(text) : text);
  }
  // Lines of one paragraph join with a space; a stand-in or blank line keeps the paragraph break.
  return out
    .join("\n")
    .replace(/\n{2,}/gu, "\n\n")
    .replace(/([^\n])\n(?!\n)/gu, "$1 ")
    .trim();
};
