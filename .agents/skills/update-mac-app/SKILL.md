---
name: update-mac-app
description: Update the user's macOS T3 Code desktop app from omarchy to a pushed commit of this fork, including after a production deploy.
---

# Update the Mac app

After each successful production deploy on omarchy, use this skill to bring the
Mac desktop app to the same commit. This skill does not schedule or detect deploys.
Run from this repository on omarchy. SSH host `mac` must be available.

```bash
scripts/friend/update-mac-app.sh [--dry-run] [ref]
```

Without a ref, the script reads `t3-friend.service`'s effective WorkingDirectory
and resolves its HEAD. An explicit ref resolves in the current checkout. The
commit must already be reachable from origin; if it is not, stop and report it.
Do not push unrelated work to satisfy this prerequisite.

The script refuses a dirty Mac checkout, fetches origin, checks out the commit
detached in `~/Projetos/t3code-friend`, and builds the arm64 DMG. It logs to
`~/t3-mac-build.log` on the Mac. It never enables `T3CODE_BOTS_HOST`.

A real run quits the app, backs it up, installs the DMG's app with `ditto`, removes
quarantine, opens it, compares the installed app.asar with the DMG, and verifies
the process is running. It records the commit in `~/.t3-mac-app-commit` and inside
the installed app. Matching markers skip subsequent builds and installs. It keeps
the two newest timestamp-named `~/t3-app-backup-*.app` backups.

`--dry-run` still checks out and builds, even when the marker matches, and mounts
the DMG read-only to verify the app. It does not quit, back up, install, open,
rotate backups, or write installation markers. Use it when installation is not
authorized or the user must keep using the app. Respect the active session's
confirmation rules before a real run; a skill does not grant additional authority.

On failure, report the failing step and Mac log path. Do not retry installation
blindly or delete a partial install or backup. Report the resolved commit and
whether the result was `DRY_RUN_OK`, `UPDATE_OK`, or already installed.
