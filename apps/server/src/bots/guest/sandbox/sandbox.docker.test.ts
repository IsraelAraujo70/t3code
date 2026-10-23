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
    const first = JSON.parse(launcher(["-p", "oi", "--output-format", "json"], fake)) as {
      result: string;
      session_id: string;
    };
    expect(first.result).toBe("Eco #1: oi");
    const second = JSON.parse(
      launcher(["-p", "tudo bem?", "--output-format", "json", "--resume", first.session_id], fake),
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
