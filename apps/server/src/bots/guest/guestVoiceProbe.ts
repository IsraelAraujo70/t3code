// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalConsole:off globalFetch:off preferSchemaOverJson:off - a live probe that drives a running server over HTTP and prints its evidence.
/**
 * The voice probe over the guest API: a guest's voice session on a running bots host, signaled
 * exactly as the guest app does it (POST the offer, read the SSE stream, POST ready), with a
 * headless Chromium as the WebRTC client and the host's real Codex realtime voice. It reports how
 * much of the bot's reply the voice said, read from the server's log.
 *
 *   T3CODE_GUEST_TOKEN=… node apps/server/src/bots/guest/guestVoiceProbe.ts \
 *     <guest origin> <botId> <conversation|read> --server-log <server.log> [options]
 *
 *   --type <text>         conversation: send <text> as the guest once the voice is live
 *   --mic <file.wav>      conversation: the microphone plays this file instead of silence
 *   --message <id>        read: the reply to read (default: the bot's latest reply)
 *   --record <file.webm>  record the voice as the client receives it
 *   --report <file.json>
 *
 * The token comes from the environment so it stays out of process listings and logs. Run it
 * against an isolated server (its own --base-dir and port), never the live one.
 */
import * as NodeFS from "node:fs";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeUtil from "node:util";

import type { GuestHistoryResponse, GuestVoiceEvent } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { chromium } from "playwright-core";

import { CLIENT_SCRIPT, ClientReport, scoreSpeech } from "../voice/probeKit.ts";

const { positionals, values } = NodeUtil.parseArgs({
  allowPositionals: true,
  options: {
    type: { type: "string" },
    mic: { type: "string" },
    message: { type: "string" },
    record: { type: "string" },
    report: { type: "string" },
    "server-log": { type: "string" },
  },
});
const [origin, botId, mode] = positionals;
const token = process.env.T3CODE_GUEST_TOKEN;
const serverLog = values["server-log"];
if (
  origin === undefined ||
  botId === undefined ||
  (mode !== "conversation" && mode !== "read") ||
  token === undefined ||
  serverLog === undefined
) {
  console.error(
    "usage: T3CODE_GUEST_TOKEN=… guestVoiceProbe.ts <origin> <botId> <conversation|read> --server-log <path> [--type text] [--mic file.wav] [--message id] [--record file.webm] [--report file.json]",
  );
  process.exit(2);
}

const started = Date.now();
const at = () => (Date.now() - started) / 1000;
const log: Array<{ t: number; what: string; text?: string }> = [];
const note = (what: string, text?: string) => {
  log.push(text === undefined ? { t: at(), what } : { t: at(), what, text });
  console.log(
    `[${at().toFixed(1)}s] ${what}${text === undefined ? "" : `: ${text.slice(0, 160)}`}`,
  );
};

const api = async (path: string, body?: unknown) => {
  const response = await fetch(
    `${origin}${path}`,
    body === undefined
      ? { headers: { authorization: `Bearer ${token}` } }
      : {
          method: "POST",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  const text = await response.text();
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${text}`);
  return JSON.parse(text) as unknown;
};
const history = async () =>
  (await api(`/guest/v1/bots/${botId}/messages?limit=20`)) as GuestHistoryResponse;
const decodeClientReport = Schema.decodeUnknownSync(ClientReport);
const clientReport = async () => decodeClientReport(await page.evaluate("window.probeReport()"));
const latestReply = async () =>
  (await history()).messages.findLast(
    (message) => message.role === "assistant" && !message.streaming,
  );

const messageId = mode === "read" ? (values.message ?? (await latestReply())?.id ?? null) : null;
if (mode === "read" && messageId === null) {
  console.error("This bot has no reply to read yet.");
  process.exit(2);
}

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
  args: [
    "--autoplay-policy=no-user-gesture-required",
    ...(values.mic === undefined
      ? []
      : [
          "--use-fake-ui-for-media-stream",
          "--use-fake-device-for-media-stream",
          // `%noloop`: the file plays once, then the microphone is silent.
          `--use-file-for-fake-audio-capture=${values.mic}%noloop`,
        ]),
  ],
});
const page = await browser.newPage();
// getUserMedia needs a secure context, which about:blank is not; a loopback origin is (its 404 page
// is enough).
if (values.mic !== undefined) await page.goto(`${origin}/probe`);
page.on("console", (message) => {
  const text = message.text();
  if (text.startsWith("probe:")) note(text.slice(6));
});
await page.addScriptTag({ content: CLIENT_SCRIPT });
const offer = String(await page.evaluate(`window.probeOffer(${values.mic !== undefined})`));

const hangUp = new AbortController();
const response = await fetch(`${origin}/guest/v1/bots/${botId}/voice`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    accept: "text/event-stream",
    "content-type": "application/json",
  },
  body: JSON.stringify({
    mode: messageId === null ? { type: "conversation" } : { type: "read", messageId },
    sdp: offer,
  }),
  signal: hangUp.signal,
});
if (response.status !== 200 || response.body === null) {
  console.error(`The voice route answered ${response.status}: ${await response.text()}`);
  await browser.close();
  process.exit(1);
}

let sessionId: string | null = null;
let worked = false;
let settledAt: number | null = null;
let ended = false;
let answered: (sdp: string) => void = () => {};
const answer = new Promise<string>((resolve) => {
  answered = resolve;
});
const reading = (async () => {
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      let cut: number;
      while ((cut = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, cut);
        buffer = buffer.slice(cut + 2);
        if (!frame.startsWith("data: ")) continue;
        const event = JSON.parse(frame.slice(6)) as GuestVoiceEvent;
        if (event.type === "answer") {
          sessionId = event.sessionId;
          note("answer", event.sessionId);
          answered(event.sdp);
        } else if (event.type === "bot") {
          note(`event bot ${event.working}`);
          if (event.working) worked = true;
          else if (worked) settledAt = Date.now();
        } else note("session failed", event.message);
      }
    }
  } catch (error) {
    if (!hangUp.signal.aborted) note("stream broke", String(error));
  }
  ended = true;
  note("session stream ended");
})();

await page.evaluate(`window.probeAccept(${JSON.stringify(await answer)})`);
note("peer connected");
await api("/guest/v1/voice/ready", { sessionId });
note("ready");
if (values.record !== undefined) await page.evaluate("window.probeRecord()");
if (mode === "conversation" && values.type !== undefined) {
  await api(`/guest/v1/bots/${botId}/messages`, { text: values.type });
  note("typed", values.type);
}

// A read ends by itself. A conversation hangs up once the bot has replied and the voice has been
// quiet for a while after speaking.
const deadline = started + 15 * 60_000;
while (Date.now() < deadline) {
  await NodeTimersPromises.setTimeout(1_000);
  if (ended) break;
  if (mode !== "conversation" || settledAt === null) continue;
  const client = await clientReport();
  if (
    client.lastAudio !== null &&
    client.lastAudio > settledAt &&
    Date.now() - client.lastAudio > 20_000
  )
    break;
}
hangUp.abort();
await reading;
const client = await clientReport();
if (values.record !== undefined) {
  const recording = (await page.evaluate("window.probeRecording()")) as string | null;
  if (recording !== null) NodeFS.writeFileSync(values.record, Buffer.from(recording, "base64"));
}
await browser.close();

// The server writes what the voice generated as `Voice <id> said: <text>`.
await NodeTimersPromises.setTimeout(1_000);
const said = NodeFS.readFileSync(serverLog, "utf8")
  .split("\n")
  .flatMap((line) => {
    const marker = `Voice ${sessionId} said: `;
    const index = line.indexOf(marker);
    return index === -1 ? [] : [line.slice(index + marker.length).replace(/["'}\s]+$/u, "")];
  })
  .join(" ");
const reply =
  mode === "read"
    ? (await history()).messages.find((message) => message.id === messageId)?.text
    : (await latestReply())?.text;
const replyText = reply ?? "";
const summary = {
  mode,
  sessionId,
  reply: replyText,
  ...scoreSpeech(replyText, said),
  audibleSeconds: client.audibleSeconds,
  firstAudio: client.firstAudio === null ? null : (client.firstAudio - started) / 1000,
  lastAudio: client.lastAudio === null ? null : (client.lastAudio - started) / 1000,
  said,
};
console.log(JSON.stringify(summary, null, 2));
if (values.report !== undefined)
  NodeFS.writeFileSync(
    values.report,
    JSON.stringify({ ...summary, log, channel: client.channel }, null, 2),
  );
