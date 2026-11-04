/**
 * Pre-push guard of a `branchPolicy: agent` worktree, set with `git config --worktree` so no other
 * worktree changes: refuses protected branches, deletions and non-fast-forwards (git hides `--force`
 * from hooks, so it checks ancestry), then runs the repository's own hook. `--no-verify` skips it.
 */

export const DEFAULT_PROTECTED_REFS: ReadonlyArray<string> = ["main", "master", "friend/main"];

/** Client-side hooks the guard's directory forwards to the repository's own hooks. */
export const FORWARDED_HOOKS: ReadonlyArray<string> = [
  "applypatch-msg",
  "pre-applypatch",
  "post-applypatch",
  "pre-commit",
  "pre-merge-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "pre-rebase",
  "post-checkout",
  "post-merge",
  "pre-auto-gc",
  "post-rewrite",
];

const shellQuote = (text: string) => `'${text.replaceAll("'", `'\\''`)}'`;

/** `main` → `refs/heads/main`; a full ref stays as it is. */
const fullRef = (ref: string) => (ref.startsWith("refs/") ? ref : `refs/heads/${ref}`);

/**
 * The hook that runs the repository's own hook of that name, if any. `original` is the hooks
 * directory the repository uses without the guard; a relative one is relative to the worktree's
 * top, where git runs hooks.
 */
export const forwardingHook = (name: string, original: string): string =>
  [
    "#!/bin/sh",
    `hook=${shellQuote(original)}/${name}`,
    'if [ -x "$hook" ]; then exec "$hook" "$@"; fi',
    "exit 0",
    "",
  ].join("\n");

/** The guarded pre-push hook. */
export const prePushGuard = (protect: ReadonlyArray<string>, original: string): string => {
  const refs = [...new Set(protect.map(fullRef))];
  return [
    "#!/bin/sh",
    "# T3 workflow push guard (branchPolicy: agent), set for this worktree only.",
    "input=$(cat)",
    'refuse() { echo "workflow push guard: $1" >&2; exit 1; }',
    "while read -r local_ref local_sha remote_ref remote_sha; do",
    '  [ -z "$remote_ref" ] && continue',
    '  case "$remote_ref" in',
    ...(refs.length === 0
      ? []
      : [
          `    ${refs.map(shellQuote).join("|")})`,
          '      refuse "pushing to ${remote_ref#refs/heads/} is not allowed; push a feature branch and open a pull request" ;;',
        ]),
    "  esac",
    '  case "$local_sha" in',
    "    *[!0]*) ;;",
    '    *) refuse "deleting ${remote_ref#refs/heads/} is not allowed" ;;',
    "  esac",
    '  case "$remote_sha" in',
    "    *[!0]*)",
    '      git cat-file -e "$remote_sha^{commit}" 2>/dev/null ||',
    '        refuse "${remote_ref#refs/heads/} has commits this worktree does not have; a force push is not allowed"',
    '      git merge-base --is-ancestor "$remote_sha" "$local_sha" ||',
    '        refuse "${remote_ref#refs/heads/} would lose commits; a force push is not allowed" ;;',
    "  esac",
    "done <<EOF",
    "$input",
    "EOF",
    `hook=${shellQuote(original)}/pre-push`,
    'if [ -x "$hook" ]; then printf \'%s\\n\' "$input" | "$hook" "$@"; exit $?; fi',
    "exit 0",
    "",
  ].join("\n");
};
