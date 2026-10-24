// Entry of a guest's proxy container: the CONNECT egress proxy (:3128) and the Anthropic API
// forwarder (:8080). The credential is mounted here and never in the bot's container: a Claude
// subscription OAuth token (`claude-oauth.token`) when present, otherwise an API key. With
// T3_GUEST_FAKE_ANTHROPIC=1 (keyless tests) the forwarder's upstream is a local fake that accepts
// only the credential the forwarder injects.
import * as NodeFS from "node:fs";

import { createApiForwarder } from "./api-forward.mjs";
import { createEgressProxy } from "./egress-proxy.mjs";
import { createFakeAnthropic } from "./fake-anthropic.mjs";

const OAUTH_FILE = "/run/secrets/claude-oauth.token";
const KEY_FILE = "/run/secrets/anthropic.key";
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
}

createEgressProxy().listen(Number(process.env.EGRESS_PROXY_PORT || 3128), "0.0.0.0");
createApiForwarder({ upstream, readCredential: credentials, allowedModels, maxEffort }).listen(
  Number(process.env.API_FORWARD_PORT || 8080),
  "0.0.0.0",
);
