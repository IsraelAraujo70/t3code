// The guest's own Google account, reached through the proxy container so the bot never holds a
// Google credential. The bot calls http://egress:8082/<api path> (GOOGLE_API_URL) with no token;
// this forwarder refreshes an access token from the guest's credential file (written on the host by
// `cli.ts google-login`) and sends the request to Google with `Authorization: Bearer`. Only the APIs
// in ROUTES exist here; the token never travels anywhere else.
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";

/** Request path prefix → Google host and the path prefix it has there. */
export const ROUTES = [
  { prefix: "/gmail/v1", host: "gmail.googleapis.com", upstreamPrefix: "/gmail/v1" },
  { prefix: "/upload/gmail/v1", host: "gmail.googleapis.com", upstreamPrefix: "/upload/gmail/v1" },
  { prefix: "/sheets/v4", host: "sheets.googleapis.com", upstreamPrefix: "/v4" },
  { prefix: "/calendar/v3", host: "www.googleapis.com", upstreamPrefix: "/calendar/v3" },
  { prefix: "/drive/v3", host: "www.googleapis.com", upstreamPrefix: "/drive/v3" },
  { prefix: "/upload/drive/v3", host: "www.googleapis.com", upstreamPrefix: "/upload/drive/v3" },
];

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const NOT_CONFIGURED = "Google não configurado para este assistente.";
/** Attachments and Drive uploads can be large, but never unbounded. */
const MAX_BODY_BYTES = 64 * 1024 * 1024;
/** Refresh this long before Google's expiry, so a token never lapses mid-request. */
const EXPIRY_MARGIN_MS = 60_000;
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
 * Pure. The Google URL a request target maps to, or null when it is outside ROUTES or could leave
 * its route once decoded (dot segments, encoded dots, slashes or backslashes).
 */
export function googleTarget(rawTarget) {
  const [path = "", query] = rawTarget.split(/\?(.*)/s);
  if (/%2e|%2f|%5c|\\/i.test(path)) return null;
  if (path.split("/").some((segment) => segment === "." || segment === "..")) return null;
  const route = ROUTES.find(
    (candidate) => path === candidate.prefix || path.startsWith(`${candidate.prefix}/`),
  );
  if (route === undefined) return null;
  const rest = path.slice(route.prefix.length);
  return `https://${route.host}${route.upstreamPrefix}${rest}${query === undefined ? "" : `?${query}`}`;
}

function refuse(response, status, message) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: message }));
}

/**
 * An unbound server. `readCredential` returns `{ client_id, client_secret, refresh_token }` or
 * null, and runs whenever a token must be fetched, so a new login takes effect without a restart.
 * `resolve` maps the Google URL to the one actually requested (tests point it at a fake).
 */
export function createGoogleForwarder({
  readCredential,
  tokenUrl = GOOGLE_TOKEN_URL,
  resolve = (url) => url,
  log = (line) => process.stderr.write(`${line}\n`),
}) {
  let cached = null;

  const request = (url, options, body) =>
    new Promise((settle, reject) => {
      const target = new URL(url);
      const send = target.protocol === "https:" ? NodeHttps.request : NodeHttp.request;
      const outgoing = send(target, options, settle);
      outgoing.setTimeout(120_000, () => outgoing.destroy(new Error("timeout")));
      outgoing.on("error", reject);
      outgoing.end(body);
    });

  const readJson = (response) =>
    new Promise((settle) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => (text += chunk));
      response.on("end", () => {
        try {
          settle(JSON.parse(text));
        } catch {
          settle(null);
        }
      });
    });

  /** A valid access token, or `{ error }` the bot can read. Never logs a token. */
  const accessToken = async (forceRefresh) => {
    if (!forceRefresh && cached !== null && cached.expiresAt - EXPIRY_MARGIN_MS > Date.now()) {
      return cached.token;
    }
    const credential = readCredential();
    if (credential === null) return { error: NOT_CONFIGURED, status: 503 };
    const form = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: credential.client_id,
      client_secret: credential.client_secret,
      refresh_token: credential.refresh_token,
    }).toString();
    const response = await request(
      tokenUrl,
      {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "content-length": String(Buffer.byteLength(form)),
        },
      },
      form,
    );
    const body = await readJson(response);
    if (response.statusCode !== 200 || typeof body?.access_token !== "string") {
      cached = null;
      log(`token refresh failed (HTTP ${response.statusCode}, ${String(body?.error ?? "")})`);
      return {
        error:
          body?.error === "invalid_grant"
            ? "O acesso ao Google expirou ou foi revogado. Peça ao Israel para refazer o login."
            : "Não consegui renovar o acesso ao Google.",
        status: 502,
      };
    }
    cached = {
      token: body.access_token,
      expiresAt: Date.now() + Number(body.expires_in ?? 3600) * 1000,
    };
    return cached.token;
  };

  return NodeHttp.createServer((incoming, response) => {
    const rawTarget = incoming.url ?? "/";
    const google = googleTarget(rawTarget);
    if (google === null) {
      log(`deny ${String(incoming.method)} ${rawTarget.split("?")[0].replace(/[\r\n]/g, "")}`);
      incoming.resume();
      return refuse(
        response,
        403,
        "Só as APIs do Gmail, Sheets, Calendar e Drive passam por aqui.",
      );
    }
    const chunks = [];
    let size = 0;
    incoming.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        refuse(response, 413, "Pedido grande demais.");
        incoming.destroy();
        return;
      }
      chunks.push(chunk);
    });
    incoming.on("end", async () => {
      if (response.headersSent) return;
      const body = Buffer.concat(chunks);
      const headers = {};
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (!DROPPED_HEADERS.has(name.toLowerCase()) && value !== undefined) headers[name] = value;
      }
      if (body.length > 0) headers["content-length"] = String(body.length);
      try {
        // A token Google rejects (revoked early, clock skew) gets one fresh try.
        for (const forceRefresh of [false, true]) {
          const token = await accessToken(forceRefresh);
          if (typeof token !== "string") return refuse(response, token.status, token.error);
          const upstream = await request(
            resolve(google),
            { method: incoming.method, headers: { ...headers, authorization: `Bearer ${token}` } },
            body,
          );
          if (upstream.statusCode === 401 && !forceRefresh) {
            upstream.resume();
            continue;
          }
          const responseHeaders = { ...upstream.headers };
          delete responseHeaders["transfer-encoding"];
          delete responseHeaders.connection;
          delete responseHeaders["set-cookie"];
          response.writeHead(upstream.statusCode ?? 502, responseHeaders);
          upstream.pipe(response);
          response.on("close", () => upstream.destroy());
          return;
        }
      } catch {
        if (!response.headersSent) refuse(response, 502, "Não consegui falar com o Google.");
        else response.destroy();
      }
    });
  });
}
