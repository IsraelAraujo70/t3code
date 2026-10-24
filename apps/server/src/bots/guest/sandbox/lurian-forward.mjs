// The guest's way to Lurian's Bot API with a token the bot never holds. It runs in the proxy
// container: the bot calls http://egress:8081/api/bot/v1/... (LURIAN_BOT_API_URL) without a token,
// and this forwarder sends the request to Lurian over HTTPS with `Authorization: Bearer <token>`.
// Only the Bot API prefix exists here; the token never travels with any other path.
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";

export const BOT_API_PREFIX = "/api/bot/v1";
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const DROPPED_HEADERS = new Set([
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "host",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Pure. Whether `rawPath` (the request target before any decoding) stays inside the Bot API once
 * the upstream decodes it: no dot segments, no encoded dots, slashes or backslashes.
 */
export function isBotApiPath(rawPath) {
  const path = rawPath.split("?")[0] ?? "";
  if (path !== BOT_API_PREFIX && !path.startsWith(`${BOT_API_PREFIX}/`)) return false;
  if (/%2e|%2f|%5c|\\/i.test(path)) return false;
  return !path.split("/").some((segment) => segment === "." || segment === "..");
}

function refuse(response, status, message) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: message }));
}

/** An unbound server; `readToken` runs per request and returns null when none is configured. */
export function createLurianForwarder({
  upstream = "https://lurian.israeldeveloper.com.br",
  readToken,
  log = (line) => process.stderr.write(`${line}\n`),
}) {
  const target = new URL(upstream);
  const send = target.protocol === "https:" ? NodeHttps.request : NodeHttp.request;

  return NodeHttp.createServer((request, response) => {
    const rawPath = request.url ?? "/";
    if (!isBotApiPath(rawPath)) {
      log(`deny ${String(request.method)} ${rawPath.split("?")[0].replace(/[\r\n]/g, "")} (path)`);
      request.resume();
      return refuse(response, 403, `Only ${BOT_API_PREFIX} is reachable here.`);
    }
    const token = readToken();
    if (token === null || token === "") {
      request.resume();
      return refuse(response, 503, "No Lurian Bot API token is configured for this guest.");
    }
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        refuse(response, 413, "Request too large.");
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (response.headersSent) return;
      const body = Buffer.concat(chunks);
      const headers = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (!DROPPED_HEADERS.has(name.toLowerCase()) && value !== undefined) headers[name] = value;
      }
      headers.authorization = `Bearer ${token}`;
      if (body.length > 0) headers["content-length"] = String(body.length);
      const outgoing = send(
        new URL(rawPath, target),
        { method: request.method, headers },
        (upstreamResponse) => {
          const responseHeaders = { ...upstreamResponse.headers };
          delete responseHeaders["transfer-encoding"];
          delete responseHeaders.connection;
          delete responseHeaders["set-cookie"];
          response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
          upstreamResponse.pipe(response);
        },
      );
      outgoing.setTimeout(120_000, () => outgoing.destroy(new Error("timeout")));
      outgoing.on("error", () => {
        if (!response.headersSent) refuse(response, 502, "Could not reach Lurian.");
        else response.destroy();
      });
      response.on("close", () => outgoing.destroy());
      outgoing.end(body);
    });
  });
}
