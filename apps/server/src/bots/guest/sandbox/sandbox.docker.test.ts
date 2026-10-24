/**
 * The guest sandbox, proven from inside real containers started by the real launcher. Opt-in
 * (`T3CODE_GUEST_SANDBOX_IT=1`): it needs Docker without sudo, the `t3-guest-sandbox:latest`
 * image and internet access. Each run uses its own guest id and removes that guest's containers,
 * network and volume afterwards.
 */
// Plain-Node integration test: it drives real processes, sockets and Docker from outside Effect.
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalRandom:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterAll, describe, expect, it } from "vite-plus/test";

import { SANDBOX_LAUNCHER_PATH } from "../sandboxInstance.ts";

const enabled = process.env.T3CODE_GUEST_SANDBOX_IT === "1";
const guest = `t3it-${Math.random().toString(36).slice(2, 8)}`;
const scratch = NodeFS.mkdtempSync(
  NodePath.join(process.env.TMPDIR ?? NodeOS.tmpdir(), "t3-guest-it-"),
);

/** Every non-loopback IPv4 of this host: the LAN, the tailnet and Docker's bridges. */
const hostAddresses = Object.values(NodeOS.networkInterfaces())
  .flat()
  .flatMap((entry) => (entry && entry.family === "IPv4" && !entry.internal ? [entry.address] : []));

function launcher(args: ReadonlyArray<string>, env: Record<string, string> = {}): string {
  return NodeChildProcess.execFileSync(SANDBOX_LAUNCHER_PATH, args, {
    cwd: scratch,
    encoding: "utf8",
    timeout: 120_000,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "",
      TMPDIR: scratch,
      T3CODE_GUEST_ID: guest,
      T3CODE_GUEST_SECRETS_DIR: NodePath.join(scratch, "no-secrets"),
      ...env,
    },
  });
}

const sandboxBash = (script: string, env: Record<string, string> = {}) =>
  launcher(["--sandbox-exec", "bash", "-c", script], env);

/** `KEY=value` lines printed by a probe script, as a record. */
const fields = (output: string) =>
  Object.fromEntries(
    output
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );

afterAll(() => {
  if (!enabled) return;
  const quiet = { stdio: "ignore" } as const;
  const leftovers = NodeChildProcess.execFileSync(
    "docker",
    ["ps", "-aq", "--filter", `label=t3.guest=${guest}`],
    { encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean);
  if (leftovers.length > 0) NodeChildProcess.spawnSync("docker", ["rm", "-f", ...leftovers], quiet);
  NodeChildProcess.spawnSync("docker", ["network", "rm", `t3-guest-${guest}`], quiet);
  NodeChildProcess.spawnSync("docker", ["volume", "rm", `t3-guest-${guest}-home`], quiet);
  NodeFS.rmSync(scratch, { recursive: true, force: true });
});

describe.skipIf(!enabled)("guest sandbox (docker)", () => {
  it("hides the host and runs unprivileged", () => {
    const probe = fields(
      sandboxBash(`
        echo "uid=$(id -u)"
        echo "homes=$(ls /home | tr '\\n' ' ')"
        echo "israel=$(test -e /home/israel && echo visible || echo absent)"
        echo "dockersock=$(test -e /var/run/docker.sock && echo present || echo absent)"
        echo "nonewprivs=$(awk '/NoNewPrivs/ {print $2}' /proc/self/status)"
        echo "capeff=$(awk '/CapEff/ {print $2}' /proc/self/status)"
        echo "mounts=$(awk '$2 ~ /^\\/(home|run\\/secrets|mnt|host|var\\/run)/ {print $2}' /proc/mounts | tr '\\n' ' ')"
      `),
    );
    expect(probe).toMatchObject({
      uid: "1000",
      homes: "guest ",
      israel: "absent",
      dockersock: "absent",
      nonewprivs: "1",
      capeff: "0000000000000000",
      mounts: "/home/guest ",
    });
  });

  it("cannot reach the host, directly or through the egress proxy", () => {
    const targets = [
      "127.0.0.1:3773",
      ...hostAddresses.flatMap((ip) => [`${ip}:3773`, `${ip}:22`]),
    ];
    expect(hostAddresses.length).toBeGreaterThan(0);
    const output = sandboxBash(
      targets
        .map(
          (target) => `
            h=${target.split(":")[0]}; p=${target.split(":")[1]}
            if timeout 3 bash -c "exec 3<>/dev/tcp/$h/$p" 2>/dev/null; then echo "direct ${target}=open"; else echo "direct ${target}=blocked"; fi
            exec 4<>/dev/tcp/egress/3128
            printf 'CONNECT ${target} HTTP/1.1\\r\\nHost: ${target}\\r\\n\\r\\n' >&4
            echo "proxy ${target}=$(timeout 10 head -n1 <&4 | tr -d '\\r')"
            exec 4<&-
          `,
        )
        .join("\n"),
    );
    const result = fields(output);
    for (const target of targets) {
      expect(result[`direct ${target}`], target).toBe("blocked");
      expect(result[`proxy ${target}`], target).toMatch(/^HTTP\/1\.1 403/);
    }
  });

  it("keeps the Anthropic key in the proxy container, never in the bot's", () => {
    const secrets = NodePath.join(scratch, "secrets");
    NodeFS.mkdirSync(secrets, { recursive: true, mode: 0o700 });
    NodeFS.writeFileSync(NodePath.join(secrets, "anthropic.key"), "sk-ant-test-not-real\n", {
      mode: 0o600,
    });
    const probe = fields(
      sandboxBash(
        `
        echo "file=$(test -e /run/secrets/anthropic.key && echo present || echo absent)"
        echo "env=$ANTHROPIC_API_KEY"
        echo "base=$ANTHROPIC_BASE_URL"
        echo "grep=$(grep -rs sk-ant-test-not-real /run /home/guest /proc/self/environ >/dev/null && echo found || echo none)"
        `,
        { T3CODE_GUEST_SECRETS_DIR: secrets },
      ),
    );
    expect(probe).toEqual({
      file: "absent",
      env: "sk-guest-sandbox-placeholder",
      base: "http://egress:8080",
      grep: "none",
    });
    const inProxy = NodeChildProcess.execFileSync(
      "docker",
      ["exec", `t3-guest-${guest}-egress`, "cat", "/run/secrets/anthropic.key"],
      { encoding: "utf8" },
    );
    expect(inProxy.trim()).toBe("sk-ant-test-not-real");
  });

  it("prefers a subscription token, held only by the proxy, and signs in the bot as a subscriber", () => {
    const secrets = NodePath.join(scratch, "secrets-oauth");
    NodeFS.mkdirSync(secrets, { recursive: true, mode: 0o700 });
    for (const [file, value] of [
      ["anthropic.key", "sk-ant-api-test-not-real"],
      ["claude-oauth.token", "sk-ant-oat01-test-not-real"],
    ] as const) {
      NodeFS.writeFileSync(NodePath.join(secrets, file), `${value}\n`, { mode: 0o600 });
    }
    const env = { T3CODE_GUEST_SECRETS_DIR: secrets, T3CODE_GUEST_FAKE_ANTHROPIC: "1" };
    const probe = fields(
      sandboxBash(
        `
        echo "files=$(ls /run/secrets 2>/dev/null | tr '\n' ' ')"
        echo "oauth=$CLAUDE_CODE_OAUTH_TOKEN"
        echo "apikey=\${ANTHROPIC_API_KEY:-unset}"
        echo "grep=$(grep -rs not-real /run /home/guest /proc/self/environ >/dev/null && echo found || echo none)"
        `,
        env,
      ),
    );
    expect(probe).toEqual({
      files: "",
      oauth: "sk-ant-oat01-guest-sandbox-placeholder",
      apikey: "unset",
      grep: "none",
    });
    const proxy = `t3-guest-${guest}-egress`;
    const inProxy = NodeChildProcess.execFileSync("docker", ["exec", proxy, "ls", "/run/secrets"], {
      encoding: "utf8",
    });
    // Only the credential in use is mounted.
    expect(inProxy.trim()).toBe("claude-oauth.token");
    // The fake upstream answers only `Bearer <token>` with the OAuth beta and no API key, so a
    // finished turn proves the forwarder swapped the bot's placeholder for the real token.
    const turn = JSON.parse(
      launcher(["-p", "oi", "--model", "claude-sonnet-5-5", "--output-format", "json"], env),
    ) as { result: string; is_error: boolean };
    expect(turn).toMatchObject({ result: "Eco #1: oi", is_error: false });
  });

  it("reaches Lurian's Bot API with a token only the proxy holds, and nothing else with it", () => {
    const secrets = NodePath.join(scratch, "secrets-lurian");
    NodeFS.mkdirSync(secrets, { recursive: true, mode: 0o700 });
    NodeFS.writeFileSync(NodePath.join(secrets, "lurian-bot.token"), "lurian-test-not-real\n", {
      mode: 0o600,
    });
    const env = { T3CODE_GUEST_SECRETS_DIR: secrets, T3CODE_GUEST_FAKE_ANTHROPIC: "1" };
    // The fake Lurian in the proxy answers `authorized: true` only for `Bearer <that token>`.
    const probe = fields(
      sandboxBash(
        `
        echo "url=$LURIAN_BOT_API_URL"
        echo "api=$(curl -s -H 'Authorization: Bearer forged' "$LURIAN_BOT_API_URL/expenses?month=10")"
        echo "other=$(curl -s -o /dev/null -w '%{http_code}' http://egress:8081/api/admin)"
        echo "dots=$(curl -s -o /dev/null -w '%{http_code}' --path-as-is http://egress:8081/api/bot/v1/../admin)"
        echo "grep=$(grep -rs lurian-test-not-real /run /home/guest /proc/self/environ >/dev/null && echo found || echo none)"
        `,
        env,
      ),
    );
    expect(probe).toEqual({
      url: "http://egress:8081/api/bot/v1",
      api: JSON.stringify({ path: "/api/bot/v1/expenses?month=10", authorized: true }),
      other: "403",
      dots: "403",
      grep: "none",
    });
  });

  it("reaches the guest's own Google APIs through the proxy, with a credential only it holds", () => {
    const secrets = NodePath.join(scratch, "secrets-google");
    NodeFS.mkdirSync(NodePath.join(secrets, "google"), { recursive: true, mode: 0o700 });
    NodeFS.writeFileSync(
      NodePath.join(secrets, "google", "credentials.json"),
      JSON.stringify({
        type: "authorized_user",
        client_id: "client-test",
        client_secret: "secret-test-not-real",
        refresh_token: "refresh-test-not-real",
      }),
      { mode: 0o600 },
    );
    const env = { T3CODE_GUEST_SECRETS_DIR: secrets, T3CODE_GUEST_FAKE_ANTHROPIC: "1" };
    // The fake Google in the proxy issues its access token only for that refresh token, and its
    // APIs report whether that access token came back.
    const probe = fields(
      sandboxBash(
        `
        echo "url=$GOOGLE_API_URL"
        echo "doc=$(test -s "$GOOGLE_APIS_DOC" && echo present || echo missing)"
        echo "gmail=$(curl -s -H 'Authorization: Bearer forged' "$GOOGLE_API_URL/gmail/v1/users/me/messages?q=is:unread")"
        echo "token=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$GOOGLE_API_URL/token")"
        echo "dots=$(curl -s -o /dev/null -w '%{http_code}' --path-as-is "$GOOGLE_API_URL/drive/v3/../../token")"
        echo "grep=$(grep -rs not-real /run /home/guest /proc/self/environ >/dev/null && echo found || echo none)"
        `,
        env,
      ),
    );
    expect(probe).toEqual({
      url: "http://egress:8082",
      doc: "present",
      gmail: JSON.stringify({
        path: "/gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread",
        authorized: true,
      }),
      token: "403",
      dots: "403",
      grep: "none",
    });
    // Without a login the forwarder says so instead of failing obscurely.
    const missing = sandboxBash(`curl -s "$GOOGLE_API_URL/calendar/v3/calendars/primary/events"`, {
      T3CODE_GUEST_SECRETS_DIR: NodePath.join(scratch, "no-google"),
      T3CODE_GUEST_FAKE_ANTHROPIC: "1",
    });
    expect(missing).toContain("Google não configurado");
  });

  it("runs bots only on an internal network, apart from the shared egress bridge", () => {
    const inspect = (name: string) =>
      NodeChildProcess.execFileSync(
        "docker",
        ["network", "inspect", "-f", "{{.Internal}} {{.EnableIPv6}}", name],
        { encoding: "utf8" },
      ).trim();
    expect(inspect(`t3-guest-${guest}`)).toBe("true false");
    expect(inspect("t3-guests_egress")).toBe("false false");
  });

  it("lets the bot reach only the allowed models and routes of the Anthropic API", () => {
    const fake = { T3CODE_GUEST_FAKE_ANTHROPIC: "1" };
    const output = sandboxBash(
      `
      echo "route=$(curl -s -o /dev/null -w '%{http_code}' http://egress:8080/v1/files)"
      echo "opus=$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' \
        -d '{"model":"claude-opus-5-5","max_tokens":10,"messages":[{"role":"user","content":"oi"}]}' \
        http://egress:8080/v1/messages)"
      echo "sonnet=$(curl -s -o /dev/null -w '%{http_code}' -H 'content-type: application/json' \
        -d '{"model":"claude-sonnet-5-5","max_tokens":10,"messages":[{"role":"user","content":"oi"}]}' \
        http://egress:8080/v1/messages)"
      `,
      fake,
    );
    // 200 for Sonnet also proves the forwarder replaced the bot's placeholder key: the fake
    // upstream accepts only the key the forwarder injects.
    expect(fields(output)).toEqual({ route: "403", opus: "403", sonnet: "200" });
  });

  it("fetches public HTTPS through the proxy", () => {
    const status = sandboxBash(
      "curl -sS -o /dev/null -w '%{http_code}' --max-time 20 https://example.com/",
    );
    expect(status).toBe("200");
  });

  it("pushes to the guest's repository as the bot", () => {
    sandboxBash(`
      set -e
      git init -q --bare -b main ~/.remotes/lurian.git
      git clone -q ~/.remotes/lurian.git /tmp/seed 2>/dev/null
      cd /tmp/seed && git -c user.name=Seed -c user.email=seed@example.com commit -q --allow-empty -m seed
      git push -q origin HEAD:main
    `);
    const git = {
      T3CODE_GUEST_GIT_REMOTE: "/home/guest/.remotes/lurian.git",
      T3CODE_GUEST_GIT_DIR: "lurian-ai",
      T3CODE_GUEST_GIT_NAME: "Bot da Bia",
      T3CODE_GUEST_GIT_EMAIL: "bot-da-bia@users.noreply.github.com",
    };
    const pushed = sandboxBash(
      `
      set -e
      cd ~/lurian-ai
      echo "Conta de luz: R$ 210" > contas.md
      git add contas.md && git commit -q -m "Anota a conta de luz"
      git push -q origin HEAD:main
      git --git-dir ~/.remotes/lurian.git log -1 --format='%an <%ae>|%s' main
      `,
      git,
    );
    expect(pushed.trim()).toBe(
      "Bot da Bia <bot-da-bia@users.noreply.github.com>|Anota a conta de luz",
    );
  });

  it("reaches GitHub over SSH through the proxy with a pinned host key", () => {
    const key = NodePath.join(scratch, "deploy_key");
    NodeChildProcess.execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
    // An unknown key proves the route and the host key check: GitHub answers, then refuses it.
    const output = sandboxBash(
      "git ls-remote git@github.com:IsraelAraujo70/lurian-ai.git 2>&1 || true",
      { T3CODE_GUEST_GIT_KEY_FILE: key },
    );
    expect(output).toContain("Permission denied (publickey)");
    expect(output).not.toContain("Host key verification failed");
  });

  it("runs the real Claude CLI and resumes its conversation in a new container", () => {
    const fake = { T3CODE_GUEST_FAKE_ANTHROPIC: "1" };
    // T3 always passes the bot's model; the forwarder refuses the CLI's own default (Opus).
    const model = ["--model", "claude-sonnet-5-5"];
    const first = JSON.parse(launcher(["-p", "oi", ...model, "--output-format", "json"], fake)) as {
      result: string;
      session_id: string;
    };
    expect(first.result).toBe("Eco #1: oi");
    const second = JSON.parse(
      launcher(
        ["-p", "tudo bem?", ...model, "--output-format", "json", "--resume", first.session_id],
        fake,
      ),
    ) as { result: string };
    expect(second.result).toBe("Eco #2: tudo bem?");
    const running = NodeChildProcess.execFileSync(
      "docker",
      ["ps", "-q", "--filter", `label=t3.guest=${guest}`, "--filter", `name=t3-guest-${guest}-1`],
      { encoding: "utf8" },
    );
    // `docker run --rm`: a finished session leaves no container behind.
    expect(running.trim()).toBe("");
  });
});
