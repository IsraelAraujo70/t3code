// Plain-Node test of a plain-Node server: it drives real sockets and HTTP outside Effect.
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalFetch:off
import * as NodeEvents from "node:events";
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import { expect, it } from "vite-plus/test";

import {
  createGoogleForwarder,
  googleTarget,
  NOT_CONFIGURED,
  type GoogleCredential,
} from "./google-forward.mjs";

async function listen(server: NodeNet.Server) {
  server.listen(0, "127.0.0.1");
  await NodeEvents.EventEmitter.once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing TCP address");
  return `http://127.0.0.1:${address.port}`;
}

const close = (server: NodeNet.Server) =>
  new Promise<void>((resolve) => server.close(() => resolve()));

const credential: GoogleCredential = {
  client_id: "client-1",
  client_secret: "secret-1",
  refresh_token: "refresh-1",
};

/**
 * A stand-in for Google: `/token` issues `access-<n>`, and every API path (prefixed with the
 * Google host by the forwarder's `resolve`) records what reached it. `reject` makes the API
 * answer 401 to the given access tokens.
 */
function fakeGoogle(reject: ReadonlySet<string> = new Set()) {
  const refreshes: Array<Record<string, string>> = [];
  const calls: Array<{
    method: string;
    url: string;
    authorization: string | undefined;
    body: string;
  }> = [];
  const server = NodeHttp.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    request.on("end", () => {
      if (request.url === "/token") {
        refreshes.push(Object.fromEntries(new URLSearchParams(body)));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({ access_token: `access-${refreshes.length}`, expires_in: 3600 }),
        );
        return;
      }
      const authorization = request.headers.authorization;
      calls.push({ method: request.method ?? "", url: request.url ?? "", authorization, body });
      const token = authorization?.replace(/^Bearer /, "") ?? "";
      response.writeHead(reject.has(token) ? 401 : 200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: !reject.has(token) }));
    });
  });
  return { server, refreshes, calls };
}

async function forwarderFor(
  google: ReturnType<typeof fakeGoogle>,
  read: () => GoogleCredential | null = () => credential,
) {
  const origin = await listen(google.server);
  const forwarder = createGoogleForwarder({
    readCredential: read,
    tokenUrl: `${origin}/token`,
    resolve: (url) => url.replace("https://", `${origin}/`),
    log: () => {},
  });
  return { forwarder, origin: await listen(forwarder) };
}

/** Raw request, so paths reach the forwarder exactly as written (fetch would normalize them). */
function raw(origin: string, path: string) {
  const { hostname, port } = new URL(origin);
  return new Promise<number>((resolve, reject) => {
    const request = NodeHttp.request({ hostname, port, method: "GET", path }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    request.on("error", reject);
    request.end();
  });
}

it("maps only Gmail, Sheets, Calendar and Drive, however the path is encoded", () => {
  expect(googleTarget("/gmail/v1/users/me/messages?q=is:unread")).toBe(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread",
  );
  expect(googleTarget("/sheets/v4/spreadsheets/abc/values/A1:B2")).toBe(
    "https://sheets.googleapis.com/v4/spreadsheets/abc/values/A1:B2",
  );
  expect(googleTarget("/calendar/v3/calendars/primary/events")).toBe(
    "https://www.googleapis.com/calendar/v3/calendars/primary/events",
  );
  expect(googleTarget("/upload/drive/v3/files?uploadType=multipart")).toBe(
    "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
  );
  for (const path of [
    "/",
    "/oauth2/v4/token",
    "/token",
    "/admin/directory/v1/users",
    "/gmail/v2/users",
    "/gmail/v1x/users",
    "/youtube/v3/videos",
    "/drive/v3/../../oauth2/v4/token",
    "/drive/v3/%2e%2e/%2e%2e/oauth2",
    "/drive/v3/files%2F..%2Fx",
    "/drive/v3\\..\\x",
    "//evil.example/drive/v3/files",
    "https://evil.example/drive/v3/files",
  ]) {
    expect(googleTarget(path), path).toBeNull();
  }
});

it("sends the guest's refreshed token, caches it, and drops what the bot sent", async () => {
  const google = fakeGoogle();
  const { forwarder, origin } = await forwarderFor(google);
  try {
    const first = await fetch(`${origin}/gmail/v1/users/me/messages?q=is:unread`, {
      headers: { authorization: "Bearer forged", cookie: "SID=stolen" },
    });
    expect(first.status).toBe(200);
    const second = await fetch(
      `${origin}/sheets/v4/spreadsheets/abc/values:append?valueInputOption=RAW`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ values: [["mercado", 210]] }),
      },
    );
    expect(second.status).toBe(200);
    expect(google.refreshes).toEqual([
      {
        grant_type: "refresh_token",
        client_id: "client-1",
        client_secret: "secret-1",
        refresh_token: "refresh-1",
      },
    ]);
    expect(google.calls).toEqual([
      {
        method: "GET",
        url: "/gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread",
        authorization: "Bearer access-1",
        body: "",
      },
      {
        method: "POST",
        url: "/sheets.googleapis.com/v4/spreadsheets/abc/values:append?valueInputOption=RAW",
        authorization: "Bearer access-1",
        body: '{"values":[["mercado",210]]}',
      },
    ]);
  } finally {
    await close(forwarder);
    await close(google.server);
  }
});

it("refreshes once when Google rejects the cached token", async () => {
  const google = fakeGoogle(new Set(["access-1"]));
  const { forwarder, origin } = await forwarderFor(google);
  try {
    const response = await fetch(`${origin}/drive/v3/files`);
    expect(response.status).toBe(200);
    expect(google.refreshes.length).toBe(2);
    expect(google.calls.map((call) => call.authorization)).toEqual([
      "Bearer access-1",
      "Bearer access-2",
    ]);
  } finally {
    await close(forwarder);
    await close(google.server);
  }
});

it("refuses other paths and answers clearly without a credential, reaching Google for neither", async () => {
  const google = fakeGoogle();
  const { forwarder, origin } = await forwarderFor(google, () => null);
  try {
    for (const path of ["/oauth2/v4/token", "/drive/v3/../../token", "/drive/v3/%2e%2e/x"]) {
      expect(await raw(origin, path), path).toBe(403);
    }
    const missing = await fetch(`${origin}/calendar/v3/calendars/primary/events`);
    expect(missing.status).toBe(503);
    expect(((await missing.json()) as { error: string }).error).toBe(NOT_CONFIGURED);
    expect(google.refreshes).toEqual([]);
    expect(google.calls).toEqual([]);
  } finally {
    await close(forwarder);
    await close(google.server);
  }
});
