/**
 * The guest API against a real T3 server process: the real CLI writes guests and bots, the server
 * runs with `T3CODE_BOTS_HOST=1` and its guest listener on a loopback port, and every check goes
 * over HTTP. Opt-in with `T3CODE_GUEST_IT=1`. The chat part also needs the sandbox image and
 * `T3CODE_GUEST_SANDBOX_IT=1`: it runs real turns through the Docker sandbox with the fake
 * Anthropic API, so no key is spent.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- drives a server process, docker and sqlite.
import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { GuestBotsResponse, GuestHistoryResponse, GuestStreamEvent } from "@t3tools/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GUEST_ID_ENV, SANDBOX_LAUNCHER_PATH } from "./sandboxInstance.ts";

const enabled = process.env.T3CODE_GUEST_IT === "1";
const sandbox = enabled && process.env.T3CODE_GUEST_SANDBOX_IT === "1";

const repo = NodePath.resolve(import.meta.dirname, "../../../../..");
const suffix = Math.random().toString(36).slice(2, 7);
const bia = `bia-${suffix}`;
const ana = `ana-${suffix}`;
const instanceId = "claude_guest_it";

let base = "";
let server: NodeChildProcess.ChildProcess | undefined;
let guestOrigin = "";
let biaToken = "";
let anaToken = "";
let finance = "";
let assistant = "";
let anaBot = "";

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const probe = NodeNet.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === "object" && address !== null ? resolve(address.port) : reject(),
      );
    });
  });

const cli = (...args: string[]) =>
  JSON.parse(
    NodeChildProcess.execFileSync(
      process.execPath,
      [
        NodePath.join(repo, "apps/server/src/bots/guest/cli.ts"),
        "--base-dir",
        base,
        ...args,
        "--json",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ),
  );

const api = (path: string, init: RequestInit & { token?: string | null } = {}) => {
  const { token, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (token !== null && token !== undefined) headers.set("authorization", `Bearer ${token}`);
  return fetch(`${guestOrigin}${path}`, { ...rest, headers });
};

const send = (token: string, botId: string, body: unknown) =>
  api(`/guest/v1/bots/${botId}/messages`, {
    token,
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** Reads SSE events until `done` says stop, or fails after `ms`. `onOpen` runs once subscribed. */
async function readEvents(
  token: string,
  botId: string,
  done: (events: GuestStreamEvent[]) => boolean,
  ms: number,
  onOpen?: () => Promise<void>,
): Promise<GuestStreamEvent[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const events: GuestStreamEvent[] = [];
  try {
    const response = await api(`/guest/v1/bots/${botId}/events`, {
      token,
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    let opened = false;
    for (;;) {
      const { value, done: ended } = await reader.read();
      if (ended) break;
      buffer += value;
      let cut: number;
      while ((cut = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        if (!frame.startsWith("data: ")) continue;
        events.push(JSON.parse(frame.slice(6)) as GuestStreamEvent);
      }
      if (!opened && events.length > 0) {
        opened = true;
        await onOpen?.();
      }
      if (done(events)) break;
    }
    return events;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

const finalReply = (events: GuestStreamEvent[], text: string | RegExp) =>
  events.some(
    (event) =>
      event.type === "message" &&
      event.message.role === "assistant" &&
      !event.message.streaming &&
      (typeof text === "string" ? event.message.text === text : text.test(event.message.text)),
  );

const runningSandboxes = () =>
  NodeChildProcess.execFileSync(
    "docker",
    ["ps", "-q", "--filter", `label=t3.guest=${bia}`, "--filter", `name=t3-guest-${bia}-1`],
    { encoding: "utf8" },
  ).trim();

beforeAll(async () => {
  if (!enabled) return;
  NodeFs.mkdirSync(NodePath.join(NodeOs.homedir(), ".cache/friend-tmp"), { recursive: true });
  base = NodeFs.mkdtempSync(NodePath.join(NodeOs.homedir(), ".cache/friend-tmp/bia-it-"));
  const [port, guestPort] = [await freePort(), await freePort()];
  guestOrigin = `http://127.0.0.1:${guestPort}`;

  NodeFs.mkdirSync(NodePath.join(base, "userdata"), { recursive: true });
  // Only the sandbox instance is enabled, so the server never probes the host's own CLIs.
  NodeFs.writeFileSync(
    NodePath.join(base, "userdata/settings.json"),
    JSON.stringify({
      providerInstances: {
        codex: { driver: "codex", enabled: false },
        claudeAgent: { driver: "claudeAgent", enabled: false },
        [instanceId]: {
          driver: "claudeAgent",
          enabled: true,
          config: { binaryPath: SANDBOX_LAUNCHER_PATH },
          environment: [
            { name: GUEST_ID_ENV, value: bia },
            { name: "T3CODE_GUEST_FAKE_ANTHROPIC", value: "1" },
            { name: "T3CODE_GUEST_SECRETS_DIR", value: NodePath.join(base, "no-secrets") },
          ],
        },
      },
    }),
  );

  cli("create", bia, "--name", "Bia");
  cli("create", ana, "--name", "Ana");
  biaToken = cli("mint", bia, "--server", guestOrigin).token;
  anaToken = cli("mint", ana, "--server", guestOrigin).token;
  const model = ["--instance", instanceId, "--model", "claude-sonnet-5-5", "--effort", "high"];
  finance = cli("bot-create", bia, "--name", "Financeiro da Casa", ...model).botId;
  assistant = cli("bot-create", bia, "--name", "Assistente", ...model).botId;
  // Ana's bot uses an instance that sandboxes Bia, never Ana: sending to it must fail closed.
  anaBot = cli("bot-create", ana, "--name", "Bot da Ana", ...model).botId;

  server = NodeChildProcess.spawn(
    process.execPath,
    [
      NodePath.join(repo, "apps/server/src/bin.ts"),
      "serve",
      "--base-dir",
      base,
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--no-browser",
    ],
    {
      cwd: repo,
      env: {
        ...process.env,
        T3CODE_BOTS_HOST: "1",
        T3CODE_GUEST_LISTEN: `127.0.0.1:${guestPort}`,
        T3CODE_GUEST_IDLE_MS: "3000",
      },
      stdio: ["ignore", NodeFs.openSync(NodePath.join(base, "server.log"), "a"), "inherit"],
    },
  );
  // The server is an external process: wait for its guest listener to answer.
  for (let attempt = 0; attempt < 120; attempt++) {
    const status = await api("/guest/v1/bots").then(
      (response) => response.status,
      () => 0,
    );
    if (status === 401) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`guest listener never came up; see ${base}/server.log`);
}, 120_000);

afterAll(async () => {
  if (!enabled) return;
  if (server?.pid !== undefined && server.exitCode === null) {
    const exited = new Promise((resolve) => server!.once("exit", resolve));
    server.kill("SIGTERM");
    await exited;
  }
  if (sandbox) {
    const quiet = { stdio: "ignore" } as const;
    const ids = NodeChildProcess.execFileSync(
      "docker",
      ["ps", "-aq", "--filter", `label=t3.guest=${bia}`],
      { encoding: "utf8" },
    )
      .split("\n")
      .filter(Boolean);
    if (ids.length > 0) NodeChildProcess.spawnSync("docker", ["rm", "-f", ...ids], quiet);
    NodeChildProcess.spawnSync("docker", ["network", "rm", `t3-guest-${bia}`], quiet);
    NodeChildProcess.spawnSync("docker", ["volume", "rm", `t3-guest-${bia}-home`], quiet);
  }
  if (process.env.T3CODE_GUEST_IT_KEEP !== "1")
    NodeFs.rmSync(base, { recursive: true, force: true });
}, 60_000);

describe.skipIf(!enabled)("guest API on a real server", () => {
  it("shows a guest only their own bots", async () => {
    const forBia = (await (
      await api("/guest/v1/bots", { token: biaToken })
    ).json()) as GuestBotsResponse;
    expect(forBia.guest).toEqual({ id: bia, name: "Bia" });
    expect(forBia.bots.map((bot) => bot.name)).toEqual(["Financeiro da Casa", "Assistente"]);
    const forAna = (await (
      await api("/guest/v1/bots", { token: anaToken })
    ).json()) as GuestBotsResponse;
    expect(forAna.bots.map((bot) => bot.id)).toEqual([anaBot]);
  });

  it("refuses another guest's bot, like a bot that does not exist", async () => {
    for (const botId of [anaBot, "b_doesnotexist", "..%2F..%2Fapi"]) {
      expect((await api(`/guest/v1/bots/${botId}/messages`, { token: biaToken })).status).toBe(404);
      expect((await send(biaToken, botId, { text: "oi" })).status).toBe(404);
      expect((await api(`/guest/v1/bots/${botId}/events`, { token: biaToken })).status).toBe(404);
      expect((await api(`/guest/v1/bots/${botId}/attachments/x`, { token: biaToken })).status).toBe(
        404,
      );
    }
    const body = (await (await send(biaToken, anaBot, { text: "oi" })).json()) as {
      error: string;
    };
    expect(body.error).toBe("Bot not found.");
  });

  it("refuses unknown and revoked tokens, and an old token after a new mint", async () => {
    expect((await api("/guest/v1/bots", { token: null })).status).toBe(401);
    expect((await api("/guest/v1/bots", { token: "t3g_" + "A".repeat(43) })).status).toBe(401);
    expect((await api("/guest/v1/bots", { headers: { authorization: biaToken } })).status).toBe(
      401,
    );
    expect((await send("nope", finance, { text: "oi" })).status).toBe(401);

    cli("revoke", ana);
    expect((await api("/guest/v1/bots", { token: anaToken })).status).toBe(401);
    expect((await send(anaToken, anaBot, { text: "oi" })).status).toBe(401);
    const fresh = cli("mint", ana, "--server", guestOrigin).token as string;
    expect((await api("/guest/v1/bots", { token: fresh })).status).toBe(200);
    expect((await api("/guest/v1/bots", { token: anaToken })).status).toBe(401);
    anaToken = fresh;
  });

  it("has no way to change a bot's model or effort", async () => {
    for (const extra of [
      { model: "claude-opus-5-5" },
      { effort: "max" },
      { modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" } },
      { options: [{ id: "effort", value: "max" }] },
    ]) {
      const response = await send(biaToken, finance, { text: "oi", ...extra });
      expect(response.status, JSON.stringify(extra)).toBe(400);
    }
    for (const [method, path] of [
      ["PUT", `/guest/v1/bots/${finance}`],
      ["PATCH", `/guest/v1/bots/${finance}`],
      ["POST", `/guest/v1/bots/${finance}`],
      ["POST", "/guest/v1/bots"],
      ["DELETE", `/guest/v1/bots/${finance}`],
    ] as const) {
      expect((await api(path, { token: biaToken, method })).status, `${method} ${path}`).toBe(404);
    }
  });

  it("fails closed for a bot whose instance is not the guest's sandbox", async () => {
    const response = await send(anaToken, anaBot, { text: "oi" });
    expect(response.status).toBe(409);
  });

  it("answers 404 for everything outside the guest routes, the T3 RPC socket included", async () => {
    const paths = [
      "/",
      "/ws",
      "/api/environment",
      "/api/orchestration/threads",
      "/mcp",
      "/oauth/authorize",
      "/.well-known/oauth-authorization-server",
      "/guest/v1",
      "/guest/v1/admin",
      "/guest/v2/bots",
      "/guest/v1/bots/../../api/environment",
    ];
    for (const path of paths) {
      for (const method of ["GET", "POST", "OPTIONS"]) {
        const response = await api(path, { token: biaToken, method });
        expect(response.status, `${method} ${path}`).toBe(404);
      }
    }
    // fetch refuses an Upgrade header, so the socket handshake goes over node:http.
    const upgrade = await new Promise<number>((resolve, reject) => {
      const request = NodeHttp.request(`${guestOrigin}/ws`, {
        headers: {
          authorization: `Bearer ${biaToken}`,
          connection: "Upgrade",
          upgrade: "websocket",
          "sec-websocket-version": "13",
          "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        },
      });
      request.on("upgrade", (_response, socket) => {
        socket.destroy();
        resolve(101);
      });
      request.on("response", (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      request.on("error", reject);
      request.end();
    });
    expect(upgrade).toBe(404);
  });

  describe.skipIf(!sandbox)("chatting through the sandbox", () => {
    it("streams the reply, pins the bot's model, stops when idle and resumes", async () => {
      const first = "olá, quanto gastamos com mercado este mês? me ajuda a organizar";
      const events = await readEvents(
        biaToken,
        finance,
        (seen) => finalReply(seen, `Eco #1: ${first}`),
        90_000,
        async () => {
          expect((await send(biaToken, finance, { text: first })).status).toBe(202);
        },
      );
      // The reply came from a live sandbox container, which the idle reaper stops below.
      expect(runningSandboxes()).not.toBe("");
      // T3's Claude adapter publishes assistant text per completed block, so the stream shows
      // the bot working, then the reply, then the bot idle.
      const working = events.findIndex((event) => event.type === "working" && event.working);
      const reply = events.findIndex(
        (event) => event.type === "message" && event.message.role === "assistant",
      );
      expect(working).toBeGreaterThanOrEqual(0);
      expect(reply).toBeGreaterThan(working);
      const idle = await readEvents(
        biaToken,
        finance,
        (seen) => seen.some((event) => event.type === "working" && !event.working),
        30_000,
      );
      expect(idle.at(-1)).toEqual({ type: "working", working: false });

      const history = (await (
        await api(`/guest/v1/bots/${finance}/messages`, { token: biaToken })
      ).json()) as GuestHistoryResponse;
      expect(history.messages.map((message) => [message.role, message.text])).toEqual([
        ["user", first],
        ["assistant", `Eco #1: ${first}`],
      ]);

      const db = new DatabaseSync(NodePath.join(base, "userdata/statev2.sqlite"), {
        readOnly: true,
      });
      const runs = db
        .prepare("SELECT payload_json FROM orchestration_v2_projection_runs WHERE thread_id = ?")
        .all(`bot:${finance}:1`) as Array<{ payload_json: string }>;
      db.close();
      expect(runs.length).toBe(1);
      expect(JSON.parse(runs[0]!.payload_json).modelSelection).toMatchObject({
        instanceId,
        model: "claude-sonnet-5-5",
        options: [{ id: "effort", value: "high" }],
      });

      // T3CODE_GUEST_IDLE_MS=3000: the reaper stops the session, and `docker run --rm` goes too.
      let stopped = false;
      for (let attempt = 0; attempt < 60 && !stopped; attempt++) {
        stopped = runningSandboxes() === "";
        if (!stopped) await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect(stopped).toBe(true);

      const resumed = await readEvents(
        biaToken,
        finance,
        (seen) => finalReply(seen, "Eco #2: de novo"),
        90_000,
        async () => {
          expect((await send(biaToken, finance, { text: "de novo" })).status).toBe(202);
        },
      );
      expect(finalReply(resumed, "Eco #2: de novo")).toBe(true);
    }, 240_000);

    it("delivers a photo to the bot and serves it back to its owner only", async () => {
      // The image reaches Claude inline; T3 also appends a path hint, which the echo repeats.
      const photoReply = /^Eco #1: olha essa foto[\s\S]* \(\+1 imagem\)$/;
      // 1×1 transparent PNG.
      const png =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
      const events = await readEvents(
        biaToken,
        assistant,
        (seen) => finalReply(seen, photoReply),
        90_000,
        async () => {
          const response = await send(biaToken, assistant, {
            text: "olha essa foto",
            attachments: [
              { name: "foto.png", mimeType: "image/png", dataUrl: `data:image/png;base64,${png}` },
            ],
          });
          expect(response.status).toBe(202);
        },
      );
      expect(finalReply(events, photoReply)).toBe(true);
      const history = (await (
        await api(`/guest/v1/bots/${assistant}/messages`, { token: biaToken })
      ).json()) as GuestHistoryResponse;
      const image = history.messages[0]!.attachments[0]!;
      const own = await api(`/guest/v1/bots/${assistant}/attachments/${image.id}`, {
        token: biaToken,
      });
      expect(own.status).toBe(200);
      expect(Buffer.from(await own.arrayBuffer()).toString("base64")).toBe(png);
      const other = await api(`/guest/v1/bots/${assistant}/attachments/${image.id}`, {
        token: anaToken,
      });
      expect(other.status).toBe(404);
    }, 120_000);
  });
});
