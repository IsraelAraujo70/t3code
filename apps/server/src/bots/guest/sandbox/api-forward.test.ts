// Plain-Node test of a plain-Node server: it drives real sockets and HTTP outside Effect.
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalFetch:off
import * as NodeEvents from "node:events";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import { expect, it } from "vite-plus/test";

import {
  capEffort,
  createApiForwarder,
  isAllowedModel,
  OAUTH_BETA,
  withBeta,
  type ForwardCredential,
} from "./api-forward.mjs";
import { createFakeAnthropic } from "./fake-anthropic.mjs";

async function listen(server: NodeNet.Server) {
  server.listen(0, "127.0.0.1");
  await NodeEvents.EventEmitter.once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing TCP address");
  return `http://127.0.0.1:${address.port}`;
}

const close = (server: NodeNet.Server) =>
  new Promise<void>((resolve) => server.close(() => resolve()));

/** An upstream that records what reached it and answers 200. */
function recordingUpstream() {
  const seen: Array<{ headers: NodeHttp.IncomingHttpHeaders; body: string; url: string }> = [];
  const server = NodeHttp.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    request.on("end", () => {
      seen.push({ headers: request.headers, body, url: request.url ?? "" });
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  return { server, seen };
}

const post = (origin: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

it("matches allowed models and their dated versions only", () => {
  const allowed = ["claude-sonnet-5-5", "claude-haiku-5-5"];
  expect(isAllowedModel("claude-sonnet-5-5", allowed)).toBe(true);
  expect(isAllowedModel("claude-haiku-5-5-20260101", allowed)).toBe(true);
  expect(isAllowedModel("claude-opus-5-5", allowed)).toBe(false);
  expect(isAllowedModel("claude-sonnet-5-5x", allowed)).toBe(false);
  expect(isAllowedModel(undefined, allowed)).toBe(false);
});

it("caps effort above the maximum and leaves lower effort alone", () => {
  expect(capEffort({ output_config: { effort: "max" } }, "high")).toEqual({
    output_config: { effort: "high" },
  });
  expect(capEffort({ output_config: { effort: "low" } }, "high")).toEqual({
    output_config: { effort: "low" },
  });
  expect(capEffort({ output_config: { effort: "unknown" } }, "high")).toEqual({
    output_config: { effort: "high" },
  });
  expect(capEffort({ model: "x" }, "high")).toEqual({ model: "x" });
});

it("adds the real key, drops the client's, and forwards the capped body", async () => {
  const upstream = recordingUpstream();
  const forwarder = createApiForwarder({
    upstream: await listen(upstream.server),
    readCredential: () => ({ kind: "apiKey", value: "sk-real" }),
    allowedModels: ["claude-sonnet-5-5"],
    maxEffort: "high",
    log: () => {},
  });
  try {
    const origin = await listen(forwarder);
    const response = await post(
      origin,
      "/v1/messages?beta=true",
      { model: "claude-sonnet-5-5", output_config: { effort: "max" }, messages: [] },
      { "x-api-key": "sk-placeholder", authorization: "Bearer stolen" },
    );
    expect(response.status).toBe(200);
    const [seen] = upstream.seen;
    expect(seen?.url).toBe("/v1/messages?beta=true");
    expect(seen?.headers["x-api-key"]).toBe("sk-real");
    expect(seen?.headers.authorization).toBeUndefined();
    expect(JSON.parse(seen!.body).output_config.effort).toBe("high");
  } finally {
    await close(forwarder);
    await close(upstream.server);
  }
});

it("refuses other models, other routes and a missing key before reaching upstream", async () => {
  const upstream = recordingUpstream();
  let key: ForwardCredential | null = { kind: "apiKey", value: "sk-real" };
  const forwarder = createApiForwarder({
    upstream: await listen(upstream.server),
    readCredential: () => key,
    allowedModels: ["claude-sonnet-5-5"],
    maxEffort: "high",
    log: () => {},
  });
  try {
    const origin = await listen(forwarder);
    expect((await post(origin, "/v1/messages", { model: "claude-opus-5-5" })).status).toBe(403);
    expect(
      (await post(origin, "/v1/messages/batches", { model: "claude-sonnet-5-5" })).status,
    ).toBe(403);
    expect((await fetch(`${origin}/v1/files`)).status).toBe(403);
    expect((await post(origin, "/v1/messages", "not an object")).status).toBe(403);
    key = null;
    expect((await post(origin, "/v1/messages", { model: "claude-sonnet-5-5" })).status).toBe(503);
    expect(upstream.seen).toEqual([]);
  } finally {
    await close(forwarder);
    await close(upstream.server);
  }
});

it("streams the upstream's server-sent events through", async () => {
  const fake = createFakeAnthropic({ chunkDelayMs: 1, expectKey: "sk-real" });
  const forwarder = createApiForwarder({
    upstream: await listen(fake),
    readCredential: () => ({ kind: "apiKey", value: "sk-real" }),
    allowedModels: ["claude-sonnet-5-5"],
    log: () => {},
  });
  try {
    const origin = await listen(forwarder);
    const response = await post(origin, "/v1/messages", {
      model: "claude-sonnet-5-5",
      stream: true,
      messages: [{ role: "user", content: "olá mundo inteiro hoje cedo" }],
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await response.text();
    expect(text).toContain("event: message_start");
    expect(text).toContain("event: message_stop");
  } finally {
    await close(forwarder);
    await close(fake);
  }
});

it("adds the OAuth beta once and keeps the client's betas in order", () => {
  expect(withBeta("claude-code-20250219,effort-2025-11-24", OAUTH_BETA)).toBe(
    `claude-code-20250219,effort-2025-11-24,${OAUTH_BETA}`,
  );
  expect(withBeta(`claude-code-20250219, ${OAUTH_BETA}`, OAUTH_BETA)).toBe(
    `claude-code-20250219,${OAUTH_BETA}`,
  );
  expect(withBeta(undefined, OAUTH_BETA)).toBe(OAUTH_BETA);
});

it("sends a subscription token as a bearer with the OAuth beta, dropping the client's credentials", async () => {
  const upstream = recordingUpstream();
  const forwarder = createApiForwarder({
    upstream: await listen(upstream.server),
    readCredential: () => ({ kind: "oauth", value: "sk-ant-oat01-real" }),
    allowedModels: ["claude-sonnet-5-5"],
    log: () => {},
  });
  try {
    const origin = await listen(forwarder);
    const response = await post(
      origin,
      "/v1/messages?beta=true",
      { model: "claude-sonnet-5-5", messages: [] },
      {
        "x-api-key": "sk-placeholder",
        authorization: "Bearer sk-ant-oat01-guest-sandbox-placeholder",
        "anthropic-beta": "claude-code-20250219,extended-cache-ttl-2025-04-11",
      },
    );
    expect(response.status).toBe(200);
    const [seen] = upstream.seen;
    expect(seen?.headers.authorization).toBe("Bearer sk-ant-oat01-real");
    expect(seen?.headers["x-api-key"]).toBeUndefined();
    expect(seen?.headers["anthropic-beta"]).toBe(
      `claude-code-20250219,extended-cache-ttl-2025-04-11,${OAUTH_BETA}`,
    );
  } finally {
    await close(forwarder);
    await close(upstream.server);
  }
});

it("works end to end against an upstream that demands the bearer and the beta", async () => {
  const fake = createFakeAnthropic({ chunkDelayMs: 1, expectBearer: "sk-ant-oat01-real" });
  const forwarder = createApiForwarder({
    upstream: await listen(fake),
    readCredential: () => ({ kind: "oauth", value: "sk-ant-oat01-real" }),
    allowedModels: ["claude-sonnet-5-5"],
    log: () => {},
  });
  try {
    const origin = await listen(forwarder);
    const response = await post(origin, "/v1/messages", {
      model: "claude-sonnet-5-5",
      messages: [{ role: "user", content: "oi" }],
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { content: Array<{ text: string }> }).content[0]?.text).toBe(
      "Eco #1: oi",
    );
  } finally {
    await close(forwarder);
    await close(fake);
  }
});
