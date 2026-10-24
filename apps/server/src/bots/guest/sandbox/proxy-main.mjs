// Entry of a guest's proxy container: the CONNECT egress proxy (:3128) and the Anthropic API
// forwarder (:8080). The API key file is mounted here and never in the bot's container. With
// T3_GUEST_FAKE_ANTHROPIC=1 (keyless tests) the forwarder's upstream is a local fake that accepts
// only the key the forwarder injects.
import * as NodeFS from "node:fs";

import { createApiForwarder } from "./api-forward.mjs";
import { createEgressProxy } from "./egress-proxy.mjs";
import { createFakeAnthropic } from "./fake-anthropic.mjs";

const KEY_FILE = "/run/secrets/anthropic.key";
const FAKE_KEY = "sk-fake-injected-by-forwarder";

const fake = process.env.T3_GUEST_FAKE_ANTHROPIC === "1";
const allowedModels = (process.env.T3_GUEST_ANTHROPIC_MODELS ?? "")
  .split(",")
  .map((model) => model.trim())
  .filter((model) => model !== "");
const maxEffort = process.env.T3_GUEST_ANTHROPIC_MAX_EFFORT || undefined;

const readKeyFile = () => {
  try {
    return NodeFS.readFileSync(KEY_FILE, "utf8").trim();
  } catch {
    return null;
  }
};

let upstream = process.env.T3_GUEST_ANTHROPIC_UPSTREAM || "https://api.anthropic.com";
let readKey = readKeyFile;
if (fake) {
  createFakeAnthropic({
    expectKey: FAKE_KEY,
    chunkDelayMs: Number(process.env.FAKE_ANTHROPIC_CHUNK_DELAY_MS || 120),
  }).listen(8099, "127.0.0.1");
  upstream = "http://127.0.0.1:8099";
  readKey = () => FAKE_KEY;
}

createEgressProxy().listen(Number(process.env.EGRESS_PROXY_PORT || 3128), "0.0.0.0");
createApiForwarder({ upstream, readKey, allowedModels, maxEffort }).listen(
  Number(process.env.API_FORWARD_PORT || 8080),
  "0.0.0.0",
);
