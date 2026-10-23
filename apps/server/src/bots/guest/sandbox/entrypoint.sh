#!/usr/bin/env bash
# Prepares the guest's home, then runs the given command (Claude Code) in ~/work.
# stdout carries Claude's stream-json protocol, so everything before the exec logs to stderr.
set -euo pipefail
exec 3>&1 1>&2

cd "$HOME"
mkdir -p work

if [[ "${T3_GUEST_FAKE_ANTHROPIC:-}" == "1" ]]; then
  # Keyless end-to-end tests: the real CLI talks to a local echo of the Messages API.
  node /opt/t3-guest/fake-anthropic.mjs &
  export ANTHROPIC_BASE_URL=http://127.0.0.1:8099 ANTHROPIC_API_KEY=sk-fake-sandbox
  for _ in $(seq 50); do
    (exec 4<>/dev/tcp/127.0.0.1/8099) 2>/dev/null && break
    sleep 0.1
  done
elif [[ -r /run/secrets/anthropic.key ]]; then
  ANTHROPIC_API_KEY="$(tr -d '\r\n' </run/secrets/anthropic.key)"
  export ANTHROPIC_API_KEY
fi

if [[ -n "${T3_GUEST_GIT_NAME:-}" ]]; then
  git config --global user.name "$T3_GUEST_GIT_NAME"
  git config --global user.email "${T3_GUEST_GIT_EMAIL:-$T3_GUEST_ID@guest.invalid}"
fi
if [[ -r /run/secrets/git_deploy_key ]]; then
  # SSH has no proxy variable; tunnel it through the egress proxy like HTTPS.
  git config --global core.sshCommand "ssh -i /run/secrets/git_deploy_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/etc/ssh/ssh_known_hosts -o ProxyCommand='nc -X connect -x egress:3128 %h %p'"
fi

if [[ -n "${T3_GUEST_GIT_REMOTE:-}" ]]; then
  dir="$HOME/${T3_GUEST_GIT_DIR:-repo}"
  if [[ ! -d "$dir/.git" ]]; then
    git clone --quiet "$T3_GUEST_GIT_REMOTE" "$dir" ||
      echo "t3-guest-entrypoint: could not clone $T3_GUEST_GIT_REMOTE; continuing without it" >&2
  fi
fi

cd "$HOME/work"
exec "$@" 1>&3 3>&-
