// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalDateInEffect:off globalConsole:off globalConsoleInEffect:off effectFnOpportunity:off preferSchemaOverJson:off - a live benchmark that times the voice in wall-clock seconds and writes its evidence to files.
/**
 * Scores the real voice against scripted cases (`bench/cases.ts`): the voice session runs in
 * process against the installed Codex's realtime voice, with a headless Chromium as the WebRTC
 * client. Tests fake realtime, so only this shows what the model does with the prompts. It uses the
 * `codex` provider's ChatGPT login and an isolated state directory.
 *
 *   node apps/server/src/bots/voice/voiceBench.ts --label <name> [--reps 3] [--cases a,b]
 *   node apps/server/src/bots/voice/voiceBench.ts --label <name> --reply <reply.md> [--mode conversation]
 *   node apps/server/src/bots/voice/voiceBench.ts --label <name> --rescore
 *
 * Writes `bench/results/<label>.jsonl` (each run's timeline) and `<label>.tsv` (one row per run),
 * and `<label>.summary.tsv` (per case), and prints the summary. `--rescore` recomputes the
 * scores from the recorded `.jsonl` without running the voice. A user's line is synthesized once by the voice itself and cached
 * in `~/.cache/voice-bench/user/`. `CHROMIUM` names the browser; `T3CODE_VOICE_LANGUAGE` and
 * `T3CODE_VOICE_READER_VOICE` apply as on the server. The turn window defaults to 4 s here.
 *
 * Per run: `recall` is the share of the reply's words the voice said in order, `precision` the
 * share of what it said after the reply arrived that is the reply's, `preWords` what it said
 * between the user's line and the reply (an acknowledgement is a few words; more is the voice
 * answering by itself), and `latency` the seconds from the reply's append to the voice starting.
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
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { parseArgs } from "node:util";
import { chromium, type Page } from "playwright-core";

import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { type BenchCase, CASES } from "./bench/cases.ts";
import * as CodexRealtime from "./CodexRealtime.ts";
import { CLIENT_SCRIPT, ClientReport, matched, words } from "./probeKit.ts";
import * as VoiceSession from "./VoiceSession.ts";

const { values } = parseArgs({
  options: {
    label: { type: "string" },
    reps: { type: "string", default: "3" },
    cases: { type: "string" },
    rescore: { type: "boolean", default: false },
    reply: { type: "string" },
    mode: { type: "string", default: "read" },
  },
});
if (values.label === undefined) {
  console.error(
    "usage: voiceBench.ts --label <name> [--reps 3] [--cases a,b | --reply file.md [--mode conversation]] [--rescore]",
  );
  process.exit(2);
}
const label = values.label;
const reps = Number(values.reps);
const selected = values.cases === undefined ? null : new Set(values.cases.split(","));
const cases: ReadonlyArray<BenchCase> =
  values.reply === undefined
    ? CASES.filter((benchCase) => selected === null || selected.has(benchCase.name))
    : [
        {
          name: NodePath.basename(values.reply),
          mode: values.mode === "conversation" ? "conversation" : "read",
          turns: [{ reply: NodeFS.readFileSync(values.reply, "utf8").trim() }],
        },
      ];
process.env.T3CODE_VOICE_TURN_SILENCE_MS ??= "4000";

const resultsDir = NodePath.join(import.meta.dirname, "bench", "results");
const userAudioDir = NodePath.join(NodeOS.homedir(), ".cache", "voice-bench", "user");
NodeFS.mkdirSync(resultsDir, { recursive: true });
NodeFS.mkdirSync(userAudioDir, { recursive: true });
const codexVersion = values.rescore
  ? ""
  : execFileSync("codex", ["--version"], { encoding: "utf8" }).trim();
const threadId = ThreadId.make("voice-bench");
const USER_VOICE_PROMPT =
  "Você é um dublador. Fale sempre em português brasileiro. Cada texto que receber é uma fala sua: diga exatamente essas palavras, uma vez, com entonação natural de quem pergunta ou pede algo, e nada mais. Não responda, não comente, não cumprimente.";

interface Entry {
  readonly t: number;
  readonly what:
    | "append"
    | "voice-start"
    | "said"
    | "user-start"
    | "user-end"
    | "reply"
    | "posted"
    | "note";
  readonly text?: string;
}

/** One run's timeline in seconds since it started; the recording layer writes into the current one. */
let log: Entry[] = [];
let runStarted = Date.now();
const at = () => (Date.now() - runStarted) / 1000;
const note = (entry: Omit<Entry, "t">) => {
  const stamped: Entry = { ...entry, t: at() };
  log.push(stamped);
  if (stamped.what !== "voice-start")
    console.log(
      `  [${stamped.t.toFixed(1)}s] ${stamped.what}${stamped.text === undefined ? "" : `: ${stamped.text.replace(/\s+/g, " ").slice(0, 140)}`}`,
    );
};
const textOf = (entries: ReadonlyArray<Entry>) =>
  entries.map((entry) => entry.text ?? "").join(" ");

/** Records what the session appends and what the voice says, around the real realtime host. */
const recordingRealtime = Layer.effect(
  CodexRealtime.CodexRealtime,
  Effect.map(CodexRealtime.CodexRealtime, (real) => ({
    open: Effect.map(real.open, (host) => ({
      startSession: (input: Parameters<CodexRealtime.RealtimeHost["startSession"]>[0]) =>
        Effect.map(host.startSession(input), (session) => {
          let talking = false;
          return {
            ...session,
            events: session.events.pipe(
              Stream.tap((event) =>
                Effect.sync(() => {
                  if (event.type === "transcript" && !talking) {
                    talking = true;
                    note({ what: "voice-start" });
                  } else if (event.type === "transcript-done") {
                    talking = false;
                    note({ what: "said", text: event.text });
                  } else if (event.type === "error" || event.type === "closed")
                    note({
                      what: "note",
                      text: `${event.type} ${event.type === "error" ? event.message : (event.reason ?? "")}`,
                    });
                }),
              ),
            ),
            appendSpeech: (text: string) =>
              Effect.sync(() => note({ what: "append", text })).pipe(
                Effect.andThen(session.appendSpeech(text)),
              ),
          };
        }),
    })),
  })),
).pipe(Layer.provide(CodexRealtime.layer));

/** What the bench's thread holds for the run in progress. */
const thread = {
  reply: "",
  activity: null as Queue.Queue<VoiceSession.ThreadActivity, BotsError> | null,
};

const sleep = (ms: number) => Effect.promise(() => new Promise((done) => setTimeout(done, ms)));
const waitFor = (ms: number, until: () => boolean) =>
  Effect.gen(function* () {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline && !until()) yield* sleep(250);
    return until();
  });
/** The voice has said something after the last append and been quiet for `ms`. */
const quietAfterAppends = (ms: number) => () => {
  const lastAppend = log.findLast((entry) => entry.what === "append");
  const lastSaid = log.findLast((entry) => entry.what === "said");
  const lastStart = log.findLast((entry) => entry.what === "voice-start");
  return (
    lastAppend !== undefined &&
    lastSaid !== undefined &&
    lastSaid.t > lastAppend.t &&
    (lastStart === undefined || lastStart.t <= lastSaid.t) &&
    at() - lastSaid.t > ms / 1000
  );
};

const program = Effect.gen(function* () {
  const threads = Layer.succeed(VoiceSession.VoiceThreads, {
    replyText: Effect.fn("VoiceSession.VoiceThreads.replyText")(() => Effect.succeed(thread.reply)),
    post: Effect.fn("VoiceSession.VoiceThreads.post")((_thread, text) =>
      Effect.sync(() => note({ what: "posted", text })),
    ),
    activity: () => (thread.activity === null ? Stream.empty : Stream.fromQueue(thread.activity)),
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

  /** One voice session on a fresh page; `drive` runs once the peer is ready. */
  const session = (mode: BenchCase["mode"], drive: (page: Page) => Effect.Effect<void>) =>
    Effect.scoped(
      Effect.gen(function* () {
        const page = yield* Effect.acquireRelease(
          Effect.promise(() => browser.newPage()),
          (page) => Effect.promise(() => page.close()),
        );
        yield* Effect.promise(() => page.addScriptTag({ content: CLIENT_SCRIPT }));
        const offer = yield* Effect.promise(() => page.evaluate("window.probeOffer(false)")).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.String)),
        );
        const events = yield* Queue.unbounded<VoiceSessionEvent, BotsError | Cause.Done>();
        const sessionFiber = yield* Stream.runForEach(
          service.session(
            mode === "read"
              ? { threadId, mode: { type: "read", messageId: MessageId.make("bench") }, sdp: offer }
              : { threadId, mode: { type: "conversation" }, sdp: offer },
          ),
          (event) => Queue.offer(events, event),
        ).pipe(
          Effect.tapError((error) =>
            Effect.sync(() => note({ what: "note", text: error.message })),
          ),
          Effect.exit,
          Effect.forkScoped,
        );
        const answer = yield* Queue.take(events);
        if (answer.type !== "answer") return yield* Effect.die(new Error("no answer"));
        yield* Effect.promise(() =>
          page.evaluate(`window.probeAccept(${JSON.stringify(answer.sdp)})`),
        );
        yield* service.ready({ sessionId: answer.sessionId });
        if (mode === "read")
          yield* Fiber.join(sessionFiber).pipe(Effect.timeoutOption("6 minutes"));
        else yield* drive(page);
        yield* Fiber.interrupt(sessionFiber);
        const report = yield* Effect.promise(() => page.evaluate("window.probeReport()")).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(ClientReport)),
        );
        return report;
      }),
    );

  const codex = yield* CodexRealtime.CodexRealtime.pipe(Effect.provide(recordingRealtime));
  /**
   * The user's line as audio, spoken by the realtime voice under a dubbing prompt, trimmed of
   * silence and cached by text. A take whose transcript is not the line is thrown away.
   */
  const userAudio = Effect.fn("voiceBench.userAudio")(function* (text: string) {
    const base = NodePath.join(
      userAudioDir,
      createHash("sha1").update(text).digest("hex").slice(0, 12),
    );
    if (NodeFS.existsSync(`${base}.wav`))
      return NodeFS.readFileSync(`${base}.wav`).toString("base64");
    for (let take = 1; take <= 4; take++) {
      console.log(`synthesizing the user's line (take ${take}): ${text}`);
      log = [];
      runStarted = Date.now();
      const recording = yield* Effect.scoped(
        Effect.gen(function* () {
          const page = yield* Effect.acquireRelease(
            Effect.promise(() => browser.newPage()),
            (page) => Effect.promise(() => page.close()),
          );
          yield* Effect.promise(() => page.addScriptTag({ content: CLIENT_SCRIPT }));
          const offerSdp = yield* Effect.promise(() =>
            page.evaluate("window.probeOffer(false)"),
          ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.String)));
          const host = yield* codex.open;
          const realtime = yield* host.startSession({
            offerSdp,
            prompt: USER_VOICE_PROMPT,
            voice: "cove",
            delegationAckFiller: false,
          });
          yield* Effect.forkScoped(Stream.runDrain(realtime.events));
          yield* Effect.promise(() =>
            page.evaluate(`window.probeAccept(${JSON.stringify(realtime.answerSdp)})`),
          );
          yield* Effect.promise(() => page.evaluate("window.probeRecord()"));
          yield* realtime.appendSpeech(
            `Diga em voz alta exatamente esta frase, palavra por palavra, e nada mais: "${text}"`,
          );
          yield* waitFor(30_000, quietAfterAppends(2_000));
          return yield* Effect.promise(() => page.evaluate("window.probeRecording()")).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Schema.NullOr(Schema.String))),
          );
        }),
      );
      const spoken = textOf(log.filter((entry) => entry.what === "said"));
      const expected = words(text);
      const said = words(spoken);
      if (
        recording === null ||
        matched(expected, said) < expected.length ||
        said.length > expected.length + 2
      )
        continue;
      NodeFS.writeFileSync(`${base}.webm`, Buffer.from(recording, "base64"));
      execFileSync("ffmpeg", [
        "-loglevel",
        "error",
        "-y",
        "-i",
        `${base}.webm`,
        "-af",
        "silenceremove=start_periods=1:start_threshold=-45dB,areverse,silenceremove=start_periods=1:start_threshold=-45dB,areverse",
        "-ar",
        "48000",
        "-ac",
        "1",
        `${base}.wav`,
      ]);
      NodeFS.writeFileSync(`${base}.txt`, spoken);
      return NodeFS.readFileSync(`${base}.wav`).toString("base64");
    }
    return yield* Effect.die(new Error(`could not synthesize: ${text}`));
  });

  const runCase = Effect.fn("voiceBench.runCase")(function* (benchCase: BenchCase) {
    const audio = new Map<string, string>();
    for (const turn of benchCase.turns)
      if (turn.user !== undefined) audio.set(turn.user, yield* userAudio(turn.user));
    log = [];
    runStarted = Date.now();
    if (benchCase.mode === "read") {
      thread.reply = benchCase.turns[0]!.reply;
      note({ what: "reply" });
      return yield* session("read", () => Effect.void);
    }
    const activity = yield* Queue.unbounded<VoiceSession.ThreadActivity, BotsError>();
    thread.activity = activity;
    yield* Queue.offer(activity, { type: "working", working: false });
    return yield* session("conversation", (page) =>
      Effect.gen(function* () {
        for (const turn of benchCase.turns) {
          if (turn.user !== undefined) {
            const posts = log.filter((entry) => entry.what === "posted").length;
            note({ what: "user-start", text: turn.user });
            yield* Effect.promise(() =>
              page.evaluate(`window.probePlay(${JSON.stringify(audio.get(turn.user!))})`),
            );
            note({ what: "user-end" });
            const posted = yield* waitFor(
              30_000,
              () => log.filter((entry) => entry.what === "posted").length > posts,
            );
            if (!posted) note({ what: "note", text: "the user's turn was never posted" });
          }
          yield* Queue.offer(activity, { type: "working", working: true });
          yield* sleep(turn.botDelayMs ?? 5_000);
          note({ what: "reply" });
          yield* Queue.offerAll(activity, [
            { type: "reply", text: turn.reply },
            { type: "working", working: false },
          ]);
          yield* waitFor(5 * 60_000, quietAfterAppends(8_000));
        }
      }),
    );
  });

  const rows: Array<Record<string, string | number | null>> = [];
  const jsonl = NodePath.join(resultsDir, `${label}.jsonl`);
  NodeFS.writeFileSync(jsonl, "");
  for (let rep = 1; rep <= reps; rep++)
    for (const benchCase of cases) {
      console.log(`${benchCase.name} #${rep} (${codexVersion})`);
      const report = yield* runCase(benchCase);
      const scores = score(benchCase, log);
      console.log(`  => ${JSON.stringify(scores)}`);
      rows.push({ label, case: benchCase.name, rep, codex: codexVersion, ...scores });
      // The first run keeps the data channel's first messages, to see what the backend reports.
      NodeFS.appendFileSync(
        jsonl,
        `${JSON.stringify({ label, case: benchCase.name, rep, codex: codexVersion, log, raw: rows.length === 1 ? report.raw : [] })}\n`,
      );
      yield* sleep(2_000);
    }
  return rows;
});

/** Scores the reply turn of a run: everything said from the user's line (or the start) on. */
const score = (benchCase: BenchCase, timeline: ReadonlyArray<Entry>) => {
  const reply = benchCase.turns.at(-1)!.reply;
  const replyAt = timeline.findLast((entry) => entry.what === "reply")?.t ?? 0;
  const userAt = timeline.findLast((entry) => entry.what === "user-start")?.t ?? 0;
  const firstAppend = timeline.find((entry) => entry.what === "append" && entry.t >= replyAt);
  const said = (from: number, to: number) =>
    textOf(timeline.filter((entry) => entry.what === "said" && entry.t >= from && entry.t < to));
  const pre = words(said(userAt, firstAppend?.t ?? Infinity));
  // Content words (longer than 3 letters) the voice said from the reply before it arrived.
  const content = (list: ReadonlyArray<string>) => list.filter((word) => word.length > 3);
  const spoken = words(said(firstAppend?.t ?? Infinity, Infinity));
  const expected = words(reply);
  const inOrder = matched(expected, spoken);
  const started = timeline.find(
    (entry) => entry.what === "voice-start" && firstAppend !== undefined && entry.t > firstAppend.t,
  );
  const appends = timeline.filter((entry) => entry.what === "append" && entry.t >= replyAt);
  const lastSaid = timeline.findLast((entry) => entry.what === "said");
  return {
    recall: round(inOrder / Math.max(expected.length, 1)),
    precision: round(inOrder / Math.max(spoken.length, 1)),
    replyWords: expected.length,
    saidWords: spoken.length,
    preWords: pre.length,
    /** The voice answered by itself: a long turn, or the reply's content before the reply. */
    selfAnswer: pre.length > 12 || matched(content(words(reply)), content(pre)) >= 2 ? 1 : 0,
    latency:
      started === undefined || firstAppend === undefined ? null : round(started.t - firstAppend.t),
    appends: appends.length,
    parts: new Set(appends.map((entry) => entry.text)).size,
    seconds:
      lastSaid === undefined || firstAppend === undefined
        ? null
        : round(lastSaid.t - firstAppend.t),
  };
};
const round = (value: number) => Math.round(value * 1000) / 1000;

const median = (values: ReadonlyArray<number>) => {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted.length === 0 ? null : sorted[Math.floor((sorted.length - 1) / 2)]!;
};

/** `--rescore` recomputes the scores of a recorded label instead of running the voice. */
const rescore = (): Array<Record<string, string | number | null>> =>
  NodeFS.readFileSync(NodePath.join(resultsDir, `${label}.jsonl`), "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as { case: string; rep: number; codex: string; log: Entry[] })
    .flatMap((run) => {
      const benchCase = cases.find((candidate) => candidate.name === run.case);
      return benchCase === undefined
        ? []
        : [{ label, case: run.case, rep: run.rep, codex: run.codex, ...score(benchCase, run.log) }];
    });

const rows = values.rescore
  ? rescore()
  : await Effect.runPromise(
      program.pipe(
        Effect.scoped,
        Effect.provide(
          Layer.mergeAll(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-voice-bench-" }),
            ServerSettings.layerTest(),
          ).pipe(Layer.provideMerge(NodeServices.layer)),
        ),
      ),
    );

const tsv = (table: ReadonlyArray<Record<string, string | number | null>>) => {
  const columns = Object.keys(table[0] ?? {});
  return `${[columns.join("\t"), ...table.map((row) => columns.map((column) => row[column] ?? "").join("\t"))].join("\n")}\n`;
};
const summary = cases.flatMap((benchCase) => {
  const runs = rows.filter((row) => row.case === benchCase.name);
  const numbers = (key: string) =>
    runs.map((row) => row[key]).filter((value): value is number => typeof value === "number");
  return runs.length === 0
    ? []
    : [
        {
          case: benchCase.name,
          runs: runs.length,
          recallMedian: median(numbers("recall")),
          recallMin: Math.min(...numbers("recall")),
          precisionMedian: median(numbers("precision")),
          selfAnswers: numbers("selfAnswer").reduce((sum, value) => sum + value, 0),
          preWordsMedian: median(numbers("preWords")),
          latencyMedian: median(numbers("latency")),
        },
      ];
});
NodeFS.writeFileSync(NodePath.join(resultsDir, `${label}.tsv`), tsv(rows));
NodeFS.writeFileSync(NodePath.join(resultsDir, `${label}.summary.tsv`), tsv(summary));
console.log(`\n${label} (${rows[0]?.codex ?? "?"})\n${tsv(summary)}`);
