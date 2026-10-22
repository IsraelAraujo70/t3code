#!/usr/bin/env bash
set -euo pipefail
trap 'echo "ERROR: update failed at line $LINENO: $BASH_COMMAND" >&2' ERR
repo=$(git rev-parse --show-toplevel)
dry_run=0
ref=
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    -*) echo "Usage: $0 [--dry-run] [ref]" >&2; exit 2 ;;
    *) [[ -z "$ref" ]] || { echo 'Only one ref is allowed' >&2; exit 2; }; ref=$arg ;;
  esac
done
if [[ -z "$ref" ]]; then
  production_dir=$(systemctl --user show t3-friend.service --property=WorkingDirectory --value)
  [[ -n "$production_dir" ]] || { echo 'ERROR: production WorkingDirectory is empty' >&2; exit 1; }
  commit=$(git -C "$production_dir" rev-parse --verify 'HEAD^{commit}')
  echo "Production: $production_dir"
else
  commit=$(git -C "$repo" rev-parse --verify "$ref^{commit}")
fi
[[ "$commit" =~ ^[0-9a-f]{40}$ ]]
echo "Target commit: $commit (dry-run=$dry_run)"
# Fetch only; never push an unreviewed commit as a side effect of updating the app.
git -C "$repo" fetch origin
[[ -n "$(git -C "$repo" branch -r --contains "$commit" --list 'origin/*')" ]] || {
  echo "ERROR: $commit is not reachable from origin. Push the intended branch first." >&2; exit 1;
}
ssh -o BatchMode=yes mac /bin/bash -s -- "$commit" "$dry_run" <<'REMOTE'
# Parse the whole routine before child commands can consume the SSH input.
remote_main() {
set -euo pipefail
commit=$1
dry_run=$2
exec > >(tee -a "$HOME/t3-mac-build.log") 2>&1
trap 'echo "ERROR: Mac update failed at line $LINENO: $BASH_COMMAND" >&2' ERR
printf '\nUpdate started %s commit=%s dry-run=%s\n' "$(date -u)" "$commit" "$dry_run"
cd "$HOME/Projetos/t3code-friend"
[[ -z "$(git status --porcelain)" ]] || { echo 'ERROR: Mac repo has uncommitted changes'; exit 1; }
app='/Applications/T3 Code (Beta).app'
marker="$HOME/.t3-mac-app-commit"
if [[ "$dry_run" == 0 && -d "$app" && -f "$marker" && "$(cat "$marker")" == "$commit" ]]; then
  echo "Already installed at $commit; skipping build and install"
  exit 0
fi
git fetch origin
git checkout --detach "$commit"
[[ "$(git rev-parse HEAD)" == "$commit" ]]
export PATH="$HOME/.local/share/mise/installs/node/24.18.1/bin:$PWD/node_modules/.bin:$PATH"
export CI=1
unset T3CODE_BOTS_HOST
vp install --frozen-lockfile
build_started=$(date +%s)
node scripts/build-desktop-artifact.ts --platform mac --target dmg --arch arm64
# The builder owns release/. Require one DMG rather than choosing a stale artifact.
shopt -s nullglob
dmgs=(release/*.dmg)
[[ ${#dmgs[@]} == 1 ]] || { echo "ERROR: expected one release DMG, found ${#dmgs[@]}"; exit 1; }
[[ "$(stat -f %m "${dmgs[0]}")" -ge "$build_started" ]] || { echo 'ERROR: DMG predates this build'; exit 1; }
mountpoint=$(mktemp -d /tmp/t3-mac-app.XXXXXX)
mounted=0
cleanup() {
  if [[ "$mounted" == 1 ]]; then hdiutil detach "$mountpoint" || return 1; fi
  rmdir "$mountpoint"
}
trap cleanup EXIT
hdiutil attach -readonly -nobrowse -mountpoint "$mountpoint" "${dmgs[0]}"
mounted=1
source_app="$mountpoint/T3 Code (Beta).app"
[[ -f "$source_app/Contents/Resources/app.asar" && -x "$source_app/Contents/MacOS/T3 Code (Beta)" ]] || {
  echo "ERROR: DMG does not contain the expected executable and app.asar at $source_app"; exit 1;
}
echo "Found app in DMG: $source_app"
if [[ "$dry_run" == 1 ]]; then
  echo "DRY_RUN_OK commit=$commit; app verified; quit/backup/install/open skipped"
  exit 0
fi
osascript -e 'tell application "T3 Code (Beta)" to quit'
for ((attempt=0; attempt<30; attempt++)); do
  if ! pgrep -x 'T3 Code \(Beta\)' >/dev/null; then break; fi
  sleep 1
done
if pgrep -x 'T3 Code \(Beta\)' >/dev/null; then echo 'ERROR: app did not quit'; exit 1; fi
if [[ -e "$app" ]]; then
  backup="$HOME/t3-app-backup-$(date +%Y%m%d%H%M%S).app"
  [[ ! -e "$backup" ]] || { echo "ERROR: backup already exists: $backup"; exit 1; }
  mv "$app" "$backup"
  echo "Backup: $backup"
fi
ditto "$source_app" "$app"
xattr -dr com.apple.quarantine "$app"
cmp "$source_app/Contents/Resources/app.asar" "$app/Contents/Resources/app.asar"
open "$app"
for ((attempt=0; attempt<30; attempt++)); do
  if pgrep -x 'T3 Code \(Beta\)' >/dev/null; then break; fi
  sleep 1
done
pgrep -x 'T3 Code \(Beta\)' >/dev/null || { echo 'ERROR: installed app is not running'; exit 1; }
printf '%s\n' "$commit" > "$marker"
# Only timestamp-named backup directories are eligible, newest names first.
python3 - "$HOME" <<'PY'
import pathlib
import re
import shutil
import sys
backups = sorted((p for p in pathlib.Path(sys.argv[1]).iterdir()
                  if re.fullmatch(r't3-app-backup-\d{12}(?:\d{2})?\.app', p.name)
                  and p.is_dir() and not p.is_symlink()), reverse=True)
for backup in backups[2:]:
    print(f'Removing old backup: {backup}', flush=True)
    shutil.rmtree(backup)
PY
echo "UPDATE_OK commit=$commit; installed app is running"
}
remote_main "$@"
REMOTE
