/**
 * What a gate shows (friend fork): a short reason for lists, headers and pushes, and the full ask
 * as readable markdown. The server, web and Android word a gate alike.
 */

/** One or two lines in a list row or a push. */
export const GATE_REASON_MAX = 160;

const plain = (text: string): string =>
  text
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/\*\*|__/g, "")
    .replace(/\s+/g, " ")
    .trim();

const clip = (text: string): string => {
  if (text.length <= GATE_REASON_MAX) return text;
  const cut = text.slice(0, GATE_REASON_MAX - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > GATE_REASON_MAX / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.–—-]+$/, "")}…`;
};

/** The literal text before the template's first `{{`, when it says enough to stand alone. */
const templateLead = (template: string): string | null => {
  const lead = plain(template.split("{{")[0] ?? "").replace(/[\s,;:–—-]+$/, "");
  return lead.split(" ").length >= 3 ? lead : null;
};

/**
 * The gate's reason in a line or two. A short ask stays whole. A long one is usually a short
 * sentence of the author's with a step's output pasted in, so its template's lead names the
 * reason; then the node's title, then the ask's first sentence, then the ask cut at a word.
 */
export const gateReason = (
  ask: string,
  source?: { readonly template?: string | undefined; readonly title?: string | undefined },
): string => {
  const text = plain(ask);
  if (text.length <= GATE_REASON_MAX) return text;
  const lead = source?.template === undefined ? null : templateLead(source.template);
  if (lead !== null) return clip(lead);
  const title = source?.title === undefined ? "" : plain(source.title);
  if (title !== "") return clip(title);
  const firstLine = plain(ask.split(/\n\s*\n|\n(?=\s*(?:#|[-*] |\d+[.)] ))/)[0] ?? "");
  const sentence = /^.+?[.!?](?=\s|$)/.exec(firstLine)?.[0] ?? firstLine;
  return clip(sentence);
};

/**
 * The full ask as markdown. An ask already written in lines stays as it is; a one-line ask with
 * inline `1) … 2) …` steps gets them as a list, so a pasted plan reads as one. `<` is escaped:
 * asks carry placeholders like `/products/<id>` that markdown would drop as HTML.
 */
export const gateAskMarkdown = (ask: string): string => {
  const text = ask.trim().replace(/</g, "\\<");
  if (text.includes("\n")) return text;
  const steps = text.match(/(?:^|\s)\d+\)\s/g) ?? [];
  if (steps.length < 2) return text;
  return text
    .replace(/(^|\s)(\d+)\)\s/g, (_match, _space: string, n: string) => `\n\n${n}. `)
    .trim();
};
