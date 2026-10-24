// Plain-Node test of a plain-Node server: it drives real sockets and HTTP outside Effect.
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalFetch:off
import * as NodeEvents from "node:events";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import { expect, it } from "vite-plus/test";

import { createLurianForwarder, isBotApiPath } from "./lurian-forward.mjs";

async function listen(server: NodeNet.Server) {
  server.listen(0, "127.0.0.1");
  await NodeEvents.EventEmitter.once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing TCP address");
  return `http://127.0.0.1:${address.port}`;
}

const close = (server: NodeNet.Server) =>
  new Promise<void>((resolve) => server.close(() => resolve()));

/** A stand-in for Lurian that records what reached it. */
function fakeLurian() {
  const seen: Array<{
    method: string;
    url: string;
    headers: NodeHttp.IncomingHttpHeaders;
    body: string;
  }> = [];
  const server = NodeHttp.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    request.on("end", () => {
      seen.push({
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        body,
      });
      response.writeHead(200, { "content-type": "application/json", "set-cookie": "s=1" });
      response.end(JSON.stringify({ ok: true }));
    });
  });
  return { server, seen };
}

/** Raw request, so paths reach the forwarder exactly as written (fetch would normalize them). */
function raw(origin: string, method: string, path: string, headers: Record<string, string> = {}) {
  const { hostname, port } = new URL(origin);
  return new Promise<number>((resolve, reject) => {
    const request = NodeHttp.request({ hostname, port, method, path, headers }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("error", reject);
    request.end();
  });
}

it("allows only the Bot API prefix, however the path is encoded", () => {
  for (const path of [
    "/api/bot/v1",
    "/api/bot/v1/expenses",
    "/api/bot/v1/expenses?month=2026-10",
  ]) {
    expect(isBotApiPath(path), path).toBe(true);
  }
  for (const path of [
    "/",
    "/api/bot/v2/x",
    "/api/bot/v10",
    "/api/admin",
    "/api/bot/v1/../admin",
    "/api/bot/v1/./x",
    "/api/bot/v1/%2e%2e/admin",
    "/api/bot/v1/%2E%2E%2Fadmin",
    "/api/bot/v1\\..\\admin",
    "//evil.example/api/bot/v1/x",
    "http://evil.example/api/bot/v1/x",
  ]) {
    expect(isBotApiPath(path), path).toBe(false);
  }
});

it("adds the token to Bot API calls only, replacing whatever the bot sent", async () => {
  const lurian = fakeLurian();
  const forwarder = createLurianForwarder({
    upstream: await listen(lurian.server),
    readToken: () => "lurian-real-token",
    log: () => {},
  });
  try {
    const origin = await listen(forwarder);
    const response = await fetch(`${origin}/api/bot/v1/expenses?month=2026-10`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer placeholder",
        cookie: "session=stolen",
      },
      body: JSON.stringify({ amount: 210 }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toBeNull();
    const [seen] = lurian.seen;
    expect(seen).toMatchObject({
      method: "POST",
      url: "/api/bot/v1/expenses?month=2026-10",
      body: '{"amount":210}',
    });
    expect(seen?.headers.authorization).toBe("Bearer lurian-real-token");
    expect(seen?.headers.cookie).toBeUndefined();

    for (const path of ["/api/admin", "/api/bot/v1/../admin", "/api/bot/v1/%2e%2e/admin", "/"]) {
      expect(await raw(origin, "GET", path), path).toBe(403);
    }
    expect(lurian.seen.length).toBe(1);
  } finally {
    await close(forwarder);
    await close(lurian.server);
  }
});

it("answers 503 without a token and never calls Lurian", async () => {
  const lurian = fakeLurian();
  const forwarder = createLurianForwarder({
    upstream: await listen(lurian.server),
    readToken: () => null,
    log: () => {},
  });
  try {
    const origin = await listen(forwarder);
    expect(await raw(origin, "GET", "/api/bot/v1/expenses")).toBe(503);
    expect(lurian.seen).toEqual([]);
  } finally {
    await close(forwarder);
    await close(lurian.server);
  }
});
