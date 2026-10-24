// Entry of a guest's proxy container: the CONNECT egress proxy (:3128), the Anthropic API
// forwarder (:8080) and the Lurian Bot API forwarder (:8081, with `lurian-bot.token`). The credential is mounted here and never in the bot's container: a Claude
// subscription OAuth token (`claude-oauth.token`) when present, otherwise an API key. With
// T3_GUEST_FAKE_ANTHROPIC=1 (keyless tests) the forwarder's upstream is a local fake that accepts
// only the credential the forwarder injects.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";

import { createApiForwarder } from "./api-forward.mjs";
import { createEgressProxy } from "./egress-proxy.mjs";
import { createFakeAnthropic } from "./fake-anthropic.mjs";
import { createLurianForwarder } from "./lurian-forward.mjs";

const OAUTH_FILE = "/run/secrets/claude-oauth.token";
const KEY_FILE = "/run/secrets/anthropic.key";
const LURIAN_TOKEN_FILE = "/run/secrets/lurian-bot.token";
const FAKE_KEY = "sk-fake-injected-by-forwarder";

const fake = process.env.T3_GUEST_FAKE_ANTHROPIC === "1";
const allowedModels = (process.env.T3_GUEST_ANTHROPIC_MODELS ?? "")
  .split(",")
  .map((model) => model.trim())
  .filter((model) => model !== "");
const maxEffort = process.env.T3_GUEST_ANTHROPIC_MAX_EFFORT || undefined;

const readFile = (path) => {
  try {
    const value = NodeFS.readFileSync(path, "utf8").trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
};

/** The subscription token wins over the API key, as the launcher decided when it mounted them. */
const readCredential = () => {
  const token = readFile(OAUTH_FILE);
  if (token !== null) return { kind: "oauth", value: token };
  const key = readFile(KEY_FILE);
  return key === null ? null : { kind: "apiKey", value: key };
};

let upstream = process.env.T3_GUEST_ANTHROPIC_UPSTREAM || "https://api.anthropic.com";
let lurianUpstream =
  process.env.T3_GUEST_LURIAN_UPSTREAM || "https://lurian.israeldeveloper.com.br";
let credentials = readCredential;
if (fake) {
  // A mounted token is checked as a bearer, end to end; otherwise a fixed fake key.
  const token = readFile(OAUTH_FILE);
  createFakeAnthropic({
    ...(token === null ? { expectKey: FAKE_KEY } : { expectBearer: token }),
    chunkDelayMs: Number(process.env.FAKE_ANTHROPIC_CHUNK_DELAY_MS || 120),
  }).listen(8099, "127.0.0.1");
  upstream = "http://127.0.0.1:8099";
  credentials = () => (token === null ? { kind: "apiKey", value: FAKE_KEY } : readCredential());
  // Reports what reached it, so a test can tell whether the forwarder added the right token.
  const lurianToken = readFile(LURIAN_TOKEN_FILE);
  NodeHttp.createServer((request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        path: request.url,
        authorized:
          lurianToken !== null && request.headers.authorization === `Bearer ${lurianToken}`,
      }),
    );
  }).listen(8098, "127.0.0.1");
  lurianUpstream = "http://127.0.0.1:8098";
}

createEgressProxy().listen(Number(process.env.EGRESS_PROXY_PORT || 3128), "0.0.0.0");
createApiForwarder({ upstream, readCredential: credentials, allowedModels, maxEffort }).listen(
  Number(process.env.API_FORWARD_PORT || 8080),
  "0.0.0.0",
);
createLurianForwarder({
  upstream: lurianUpstream,
  readToken: () => readFile(LURIAN_TOKEN_FILE),
}).listen(Number(process.env.LURIAN_FORWARD_PORT || 8081), "0.0.0.0");
