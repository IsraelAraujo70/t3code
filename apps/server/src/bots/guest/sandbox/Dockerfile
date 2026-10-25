# The guest sandbox (friend fork): Claude Code, git and SSH for a guest's bots, plus the proxy
# container's egress proxy and Anthropic API forwarder, the bot network's only way out.
# Build from this directory:
#   docker build -t t3-guest-sandbox:latest apps/server/src/bots/guest/sandbox
FROM node:24-bookworm-slim

# Match the CLI the server's Agent SDK was tested with.
ARG CLAUDE_CODE_VERSION=2.1.301

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates curl git jq netcat-openbsd openssh-client python3 ripgrep \
  && rm -rf /var/lib/apt/lists/*

RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
  && npm cache clean --force

# GitHub's host keys from its TLS-authenticated API, so SSH never trusts on first use.
RUN curl -fsSL https://api.github.com/meta \
    | jq -r '.ssh_keys[] | "github.com " + .' > /etc/ssh/ssh_known_hosts \
  && test -s /etc/ssh/ssh_known_hosts

# Reuse the image's uid 1000 as `guest`; the launcher runs as 1000:1000.
RUN usermod -l guest -d /home/guest -m node && groupmod -n guest node

COPY --chmod=0755 entrypoint.sh /usr/local/bin/t3-guest-entrypoint
COPY proxy-main.mjs egress-proxy.mjs api-forward.mjs lurian-forward.mjs google-forward.mjs \
  fake-anthropic.mjs google-apis.md subagent-budget.mjs /opt/t3-guest/
# Managed settings outrank anything the bot writes in its home: the helper agents it may start and
# their limits (subagent-budget.mjs). Root-owned on a read-only root, so the bot cannot change them.
COPY claude/managed-settings.json /etc/claude-code/managed-settings.json
COPY claude/agents/ /etc/claude-code/.claude/agents/

ENV HOME=/home/guest \
    DISABLE_AUTOUPDATER=1 \
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
USER guest
WORKDIR /home/guest
