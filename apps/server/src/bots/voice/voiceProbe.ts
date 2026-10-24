// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalDateInEffect:off globalConsole:off preferSchemaOverJson:off - a live probe that prints its evidence and times the voice in wall-clock seconds.
/**
 * Speaks a reply through the real voice session against the installed Codex's realtime voice, with
 * a headless Chromium as the WebRTC client, and reports how much of the reply the voice said. This
 * is how the voice prompts are proven: tests fake realtime, so only this run shows what the model
 * does with them. It uses the `codex` provider's ChatGPT login and an isolated state directory.
 *
 *   node apps/server/src/bots/voice/voiceProbe.ts <reply.md> [read|conversation] [report.json]
 *
 * `T3CODE_VOICE_READER_VOICE` applies as on the server; `CHROMIUM` names the browser (default
 * `/usr/bin/chromium`). The model varies between runs: compare several runs of each prompt, and
 * repeat a run that reports "did not start reading" (the voice sometimes ignores an append).
 */
import { BotsError, MessageId, ThreadId, type VoiceSessionEvent } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeFS from "node:fs";
import { chromium } from "playwright-core";

import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as CodexRealtime from "./CodexRealtime.ts";
import * as VoiceSession from "./VoiceSession.ts";

const [replyPath, modeArg = "read", reportPath] = process.argv.slice(2);
if (replyPath === undefined) {
  console.error("usage: voiceProbe.ts <reply.md> [read|conversation] [report.json]");
  process.exit(2);
}
const reply = NodeFS.readFileSync(replyPath, "utf8").trim();
const mode = modeArg === "conversation" ? "conversation" : "read";
const threadId = ThreadId.make("voice-probe");
const messageId = MessageId.make("voice-probe-reply");
const started = Date.now();
const at = () => (Date.now() - started) / 1000;

const log: Array<{ t: number; what: string; text?: string }> = [];
const note = (what: string, text?: string) => {
  log.push(text === undefined ? { t: at(), what } : { t: at(), what, text });
  console.log(
    `[${at().toFixed(1)}s] ${what}${text === undefined ? "" : `: ${text.slice(0, 160)}`}`,
  );
};

/**
 * The client in the page: a microphone track carrying silence (realtime answers nothing until the
 * track carries audio), `oai-events`, and the voice's audio measured as it plays. Plain JavaScript,
 * because the server's program has no DOM types.
 */
const CLIENT_SCRIPT = String.raw`
window.probe = { channel: [], audible: 0, firstAudio: null, lastAudio: null };
window.probeOffer = async () => {
  const probe = window.probe;
  const context = new AudioContext();
  const silence = context.createMediaStreamDestination();
  const tone = context.createOscillator();
  const mute = context.createGain();
  mute.gain.value = 0;
  tone.connect(mute).connect(silence);
  tone.start();
  await context.resume();
  const pc = new RTCPeerConnection();
  probe.pc = pc;
  pc.addTrack(silence.stream.getAudioTracks()[0], silence.stream);
  pc.createDataChannel("oai-events").addEventListener("message", (message) => {
    let type = "?";
    try {
      type = String(JSON.parse(String(message.data)).type);
    } catch {}
    probe.channel.push({ t: Date.now(), type });
    if (/turn\.|delegation|context/.test(type)) console.log("probe:channel " + type);
  });
  pc.addEventListener("track", (event) => {
    const stream = new MediaStream([event.track]);
    // Chrome feeds a remote track to Web Audio only while a media element plays it.
    const element = new Audio();
    element.srcObject = stream;
    element.muted = true;
    void element.play();
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    context.createMediaStreamSource(stream).connect(analyser);
    const samples = new Float32Array(analyser.fftSize);
    setInterval(() => {
      analyser.getFloatTimeDomainData(samples);
      let sum = 0;
      for (const sample of samples) sum += sample * sample;
      if (Math.sqrt(sum / samples.length) > 0.01) {
        probe.audible += 0.05;
        probe.firstAudio ??= Date.now();
        probe.lastAudio = Date.now();
      }
    }, 50);
  });
  await pc.setLocalDescription(await pc.createOffer());
  await new Promise((resolve) => {
    if (pc.iceGatheringState === "complete") resolve();
    pc.addEventListener("icegatheringstatechange", () => {
      if (pc.iceGatheringState === "complete") resolve();
    });
    setTimeout(resolve, 3000);
  });
  return pc.localDescription.sdp;
};
window.probeAccept = async (sdp) => {
  const pc = window.probe.pc;
  await pc.setRemoteDescription({ type: "answer", sdp });
  await new Promise((resolve, reject) => {
    const check = () => {
      if (pc.connectionState === "connected") resolve();
      if (pc.connectionState === "failed") reject(new Error("peer failed"));
    };
    pc.addEventListener("connectionstatechange", check);
    check();
  });
};
window.probeReport = () => {
  const { audible, firstAudio, lastAudio, channel } = window.probe;
  return { audibleSeconds: Math.round(audible * 10) / 10, firstAudio, lastAudio, channel };
};
`;

const ClientReport = Schema.Struct({
  audibleSeconds: Schema.Number,
  firstAudio: Schema.NullOr(Schema.Number),
  lastAudio: Schema.NullOr(Schema.Number),
  channel: Schema.Array(Schema.Struct({ t: Schema.Number, type: Schema.String })),
});

/** Records what the session appends and what the voice says, around the real realtime host. */
const recordingRealtime = Layer.effect(
  CodexRealtime.CodexRealtime,
  Effect.map(CodexRealtime.CodexRealtime, (real) => ({
    open: Effect.map(real.open, (host) => ({
      startSession: (input: Parameters<CodexRealtime.RealtimeHost["startSession"]>[0]) =>
        Effect.map(host.startSession(input), (session) => ({
          ...session,
          events: session.events.pipe(
            Stream.tap((event) =>
              Effect.sync(() => {
                if (event.type === "transcript-done") note("voice said", event.text);
                else if (event.type === "error" || event.type === "closed")
                  note(event.type, event.type === "error" ? event.message : (event.reason ?? ""));
              }),
            ),
          ),
          appendSpeech: (text: string) =>
            Effect.sync(() => note("append", text)).pipe(
              Effect.andThen(session.appendSpeech(text)),
            ),
        })),
    })),
  })),
).pipe(Layer.provide(CodexRealtime.layer));

const program = Effect.gen(function* () {
  const activity = yield* Queue.unbounded<VoiceSession.ThreadActivity, BotsError>();
  const threads = Layer.succeed(VoiceSession.VoiceThreads, {
    replyText: () => Effect.succeed(reply),
    post: (_thread, text) => Effect.sync(() => note("posted", text)),
    activity: () => Stream.fromQueue(activity),
  });
  const service = yield* VoiceSession.VoiceSessions.pipe(
    Effect.provide(
      VoiceSession.layer.pipe(Layer.provide(threads), Layer.provide(recordingRealtime)),
    ),
  );

  const browser = yield* Effect.acquireRelease(
    Effect.promise(() =>
      chromium.launch({
        executablePath: process.env.CHROMIUM ?? "/usr/bin/chromium",
        args: ["--autoplay-policy=no-user-gesture-required"],
      }),
    ),
    (browser) => Effect.promise(() => browser.close()),
  );
  const page = yield* Effect.promise(() => browser.newPage());
  page.on("console", (message) => {
    const text = message.text();
    if (text.startsWith("probe:")) note(text.slice(6));
  });
  yield* Effect.promise(() => page.addScriptTag({ content: CLIENT_SCRIPT }));
  const offer = yield* Effect.promise(() => page.evaluate("window.probeOffer()")).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.String)),
  );

  const events = yield* Queue.unbounded<VoiceSessionEvent, BotsError | Cause.Done>();
  const sessionFiber = yield* Stream.runForEach(
    service.session(
      mode === "read"
        ? { threadId, mode: { type: "read", messageId }, sdp: offer }
        : { threadId, mode: { type: "conversation" }, sdp: offer },
    ),
    (event) => Queue.offer(events, event),
  ).pipe(
    Effect.tap(() => Effect.sync(() => note("session stream ended"))),
    Effect.tapError((error) => Effect.sync(() => note("session failed", error.message))),
    Effect.exit,
    Effect.forkScoped,
  );
  const answer = yield* Queue.take(events);
  if (answer.type !== "answer") return yield* Effect.die(new Error("no answer"));
  yield* Effect.promise(() => page.evaluate(`window.probeAccept(${JSON.stringify(answer.sdp)})`));
  note("peer connected");
  yield* service.ready({ sessionId: answer.sessionId });
  if (mode === "conversation")
    yield* Queue.offerAll(activity, [
      { type: "working", working: true },
      { type: "reply", text: reply },
      { type: "working", working: false },
    ]);
  yield* Effect.forkScoped(
    Stream.runForEach(Stream.fromQueue(events), (event) =>
      Effect.sync(() =>
        note(`event ${event.type}${event.type === "bot" ? ` ${event.working}` : ""}`),
      ),
    ),
  );
  // A read ends by itself; a conversation is hung up once the voice has been quiet for a while.
  const deadline = started + 15 * 60_000;
  while (Date.now() < deadline && sessionFiber.pollUnsafe() === undefined) {
    yield* Effect.sleep("1 second");
    const lastSaid = log.findLast((entry) => entry.what === "voice said");
    const lastAppend = log.findLast((entry) => entry.what === "append");
    if (
      mode === "conversation" &&
      lastSaid !== undefined &&
      lastAppend !== undefined &&
      lastSaid.t > lastAppend.t &&
      at() - lastSaid.t > 20
    )
      break;
  }
  yield* Fiber.interrupt(sessionFiber);
  return yield* Effect.promise(() => page.evaluate("window.probeReport()")).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(ClientReport)),
  );
});

const client = await Effect.runPromise(
  program.pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-voice-probe-" }),
        ServerSettings.layerTest(),
      ).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  ),
);

/** Words compared without case, accents, code blocks or links, which the voice does not read. */
const words = (text: string) =>
  text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);

/** How many of the reply's words the voice said in order (longest common subsequence). */
const matched = (source: ReadonlyArray<string>, said: ReadonlyArray<string>) => {
  let previous = Array.from({ length: said.length + 1 }, () => 0);
  for (const word of source) {
    const row = [0];
    for (let j = 1; j <= said.length; j++)
      row[j] = word === said[j - 1] ? previous[j - 1]! + 1 : Math.max(previous[j]!, row[j - 1]!);
    previous = row;
  }
  return previous[said.length]!;
};

const said = log
  .filter((entry) => entry.what === "voice said")
  .map((entry) => entry.text ?? "")
  .join(" ");
const sourceWords = words(reply);
const saidWords = words(said);
const inOrder = matched(sourceWords, saidWords);
const summary = {
  mode,
  replyWords: sourceWords.length,
  saidWords: saidWords.length,
  coverage: Math.round((inOrder / Math.max(sourceWords.length, 1)) * 1000) / 1000,
  /** Words the voice said that are not the reply's, in order. */
  addedWords: saidWords.length - inOrder,
  audibleSeconds: client.audibleSeconds,
  firstAudio: client.firstAudio === null ? null : (client.firstAudio - started) / 1000,
  lastAudio: client.lastAudio === null ? null : (client.lastAudio - started) / 1000,
  said,
};
console.log(JSON.stringify(summary, null, 2));
if (reportPath !== undefined)
  NodeFS.writeFileSync(
    reportPath,
    JSON.stringify({ ...summary, log, channel: client.channel }, null, 2),
  );
