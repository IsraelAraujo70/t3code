// The guest's only way to the Anthropic API. It runs in the egress proxy container, never in the
// bot's, so the bot never holds the credential: it talks to http://egress:8080 with a placeholder
// and this forwarder adds the real one, either an API key or a Claude subscription's OAuth token
// (`claude setup-token`), sent the way Claude Code's own subscription login sends it. It is also where the guest's limits hold no matter what
// the bot does inside its sandbox (a subagent on another model, a settings file it wrote):
// - only the Messages API routes the CLI needs;
// - only the allowed models;
// - `output_config.effort` capped at the allowed maximum.
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const ROUTES = new Set(["POST /v1/messages", "POST /v1/messages/count_tokens", "GET /v1/models"]);
/** Images travel inline as base64, so a request can be large, but never unbounded. */
const MAX_BODY_BYTES = 48 * 1024 * 1024;
/** The beta Claude Code adds when it signs in with a subscription; the API requires it for OAuth. */
export const OAUTH_BETA = "oauth-2025-04-20";
/** Hop-by-hop headers and every credential the client sends; the forwarder sets its own key. */
const DROPPED_HEADERS = new Set([
  "authorization",
  "connection",
  "content-length",
  "host",
  "keep-alive",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "x-api-key",
]);

/** Pure. Whether `model` is an allowed id or a dated version of one (`<id>-20260101`). */
export function isAllowedModel(model, allowedModels) {
  if (typeof model !== "string") return false;
  return allowedModels.some((allowed) => model === allowed || model.startsWith(`${allowed}-`));
}

/** Pure. The `anthropic-beta` value with `beta` added once, keeping the client's betas in order. */
export function withBeta(header, beta) {
  const betas = (Array.isArray(header) ? header.join(",") : (header ?? ""))
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value !== "");
  return (betas.includes(beta) ? betas : [...betas, beta]).join(",");
}

/** Pure. The request body with its effort lowered to `maxEffort` when it asks for more. */
export function capEffort(body, maxEffort) {
  const limit = EFFORTS.indexOf(maxEffort);
  const effort = body?.output_config?.effort;
  if (limit === -1 || typeof effort !== "string") return body;
  const asked = EFFORTS.indexOf(effort);
  if (asked !== -1 && asked <= limit) return body;
  return { ...body, output_config: { ...body.output_config, effort: maxEffort } };
}

function refuse(response, status, message) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      type: "error",
      error: { type: status === 403 ? "permission_error" : "invalid_request_error", message },
    }),
  );
}

/**
 * An unbound HTTP server forwarding to `upstream`. `readCredential` runs per request, so a rotated
 * credential file takes effect without a restart; it returns null when none is configured.
 * `{ kind: "oauth" }` is sent as `Authorization: Bearer` with the OAuth beta, `{ kind: "apiKey" }`
 * as `x-api-key`. Whatever credential the client sent is dropped either way.
 */
export function createApiForwarder({
  upstream = "https://api.anthropic.com",
  readCredential,
  allowedModels,
  maxEffort,
  log = (line) => process.stderr.write(`${line}\n`),
}) {
  const target = new URL(upstream);
  const send = target.protocol === "https:" ? NodeHttps.request : NodeHttp.request;

  return NodeHttp.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://forward.invalid");
    const route = `${request.method} ${url.pathname}`;
    if (!ROUTES.has(route)) {
      log(`deny ${route.replace(/[\r\n]/g, "")} (route)`);
      request.resume();
      return refuse(response, 403, `The guest sandbox does not allow ${route}.`);
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
      let body = Buffer.concat(chunks);
      if (request.method === "POST") {
        let parsed;
        try {
          parsed = JSON.parse(body.toString("utf8"));
        } catch {
          return refuse(response, 400, "The request body must be JSON.");
        }
        if (!isAllowedModel(parsed?.model, allowedModels)) {
          log(`deny model ${String(parsed?.model).slice(0, 80)}`);
          return refuse(
            response,
            403,
            `The model ${String(parsed?.model)} is not available to this assistant.`,
          );
        }
        body = Buffer.from(JSON.stringify(capEffort(parsed, maxEffort)));
      }
      const credential = readCredential();
      if (credential === null || credential.value === "") {
        return refuse(response, 503, "No Anthropic credential is configured for this guest.");
      }
      const headers = {};
      for (const [name, value] of Object.entries(request.headers)) {
        if (!DROPPED_HEADERS.has(name.toLowerCase()) && value !== undefined) headers[name] = value;
      }
      if (credential.kind === "oauth") {
        headers.authorization = `Bearer ${credential.value}`;
        headers["anthropic-beta"] = withBeta(request.headers["anthropic-beta"], OAUTH_BETA);
      } else {
        headers["x-api-key"] = credential.value;
      }
      headers["content-length"] = String(body.length);
      const outgoing = send(
        new URL(`${target.pathname.replace(/\/$/, "")}${url.pathname}${url.search}`, target),
        { method: request.method, headers },
        (upstreamResponse) => {
          const responseHeaders = { ...upstreamResponse.headers };
          delete responseHeaders["transfer-encoding"];
          delete responseHeaders.connection;
          response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
          upstreamResponse.pipe(response);
        },
      );
      outgoing.setTimeout(600_000, () => outgoing.destroy(new Error("timeout")));
      outgoing.on("error", () => {
        if (!response.headersSent) refuse(response, 502, "Could not reach the Anthropic API.");
        else response.destroy();
      });
      response.on("close", () => outgoing.destroy());
      outgoing.end(body);
    });
  });
}
