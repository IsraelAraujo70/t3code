/**
 * Command output goes to the journal and every client that shows a run, so credentials a failing
 * command prints (a remote URL with a token, an API key in an error) are masked before it is kept.
 */
const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // `https://user:token@host`, `https://token@host`.
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1***@"],
  [/\b(gh[opsu]_)[A-Za-z0-9]{16,}/g, "$1***"],
  [/\b(github_pat_)[A-Za-z0-9_]{16,}/g, "$1***"],
  [/\b(sk-)[A-Za-z0-9_-]{16,}/g, "$1***"],
  [/\b(xox[bp]-)[A-Za-z0-9-]{8,}/g, "$1***"],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, "$1***"],
];

/** `text` with URL credentials and well-known token shapes replaced by `***`. */
export const redactSecrets = (text: string): string =>
  PATTERNS.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), text);
