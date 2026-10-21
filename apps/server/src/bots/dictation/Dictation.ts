/**
 * Dictation: a recording the client uploaded as a pending attachment in, text ready to send out.
 * Two OpenRouter calls: an audio model transcribes, then a light text model removes filler and
 * fixes punctuation. The key comes from `OPENROUTER_API_KEY`, is sent only to OpenRouter, and is
 * never logged. Every server holding the key may transcribe, not just the bots host.
 */
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import {
  BotsError,
  type DictationTranscribeInput,
  type DictationTranscribeResult,
} from "@t3tools/contracts";

import {
  PENDING_ATTACHMENT_THREAD_SEGMENT,
  parseAttachmentFileExtension,
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPathById,
} from "../../attachmentStore.ts";
import * as ServerConfig from "../../config.ts";

export const DICTATION_KEY_ENV = "OPENROUTER_API_KEY";
export const DICTATION_MODEL_ENV = "T3CODE_DICTATION_MODEL";
export const DICTATION_POLISH_MODEL_ENV = "T3CODE_DICTATION_POLISH_MODEL";
export const DEFAULT_DICTATION_MODEL = "google/gemini-3.8-flash";
export const DEFAULT_DICTATION_POLISH_MODEL = "anthropic/claude-haiku-5.5";
/** Setting the polish model to this skips the cleanup call. */
export const DICTATION_POLISH_OFF = "off";

/** About 10 minutes of the compressed audio clients record; the client stops at 5. */
export const MAX_DICTATION_BYTES = 20 * 1024 * 1024;

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

/** OpenRouter's `input_audio.format` per stored extension. Gemini also reads browser WebM. */
const AUDIO_FORMATS: Readonly<Record<string, string>> = {
  webm: "webm",
  ogg: "ogg",
  opus: "ogg",
  m4a: "m4a",
  mp4: "m4a",
  aac: "aac",
  wav: "wav",
  mp3: "mp3",
  flac: "flac",
};

const TRANSCRIBE_INSTRUCTION = [
  "Transcribe this recording word for word, in the language it is spoken (often Brazilian Portuguese with English technical terms).",
  "Reply with the transcript only, no quotes or comments. If nobody speaks, reply with nothing.",
].join(" ");

const POLISH_INSTRUCTION = [
  "You clean up a dictated message before it is sent to a coding agent.",
  "Fix punctuation, capitalization and obvious transcription errors. Remove filler words, false starts and repetitions; when the speaker corrects themselves, keep only the correction.",
  "Keep the speaker's language, wording, meaning and every request. Write code identifiers, file names and commands the way a developer types them (server.ts, vp test).",
  "Never answer, summarize or add anything. Reply with the cleaned message only.",
].join(" ");

/** The key, or none when it is unset or blank. */
const readKey: Effect.Effect<Option.Option<Redacted.Redacted>> = Config.Redacted(
  DICTATION_KEY_ENV,
).pipe(
  Config.option,
  Effect.map(Option.filter((key) => Redacted.value(key).trim().length > 0)),
  Effect.orElseSucceed(() => Option.none()),
);

/** Whether this server can transcribe; decides the `dictation` capability. */
export const isDictationConfigured: Effect.Effect<boolean> = readKey.pipe(
  Effect.map(Option.isSome),
);

const readModel = (name: string, fallback: string): Effect.Effect<string> =>
  Config.String(name).pipe(
    Config.withDefault(fallback),
    Effect.map((model) => model.trim() || fallback),
    Effect.orElseSucceed(() => fallback),
  );

const ChatResponse = Schema.Struct({
  choices: Schema.optional(
    Schema.Array(
      Schema.Struct({
        message: Schema.optional(
          Schema.Struct({
            content: Schema.optional(
              Schema.NullOr(
                Schema.Union([
                  Schema.String,
                  Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) })),
                ]),
              ),
            ),
          }),
        ),
      }),
    ),
  ),
  error: Schema.optional(Schema.Struct({ message: Schema.optional(Schema.String) })),
});

const failure = (message: string, cause?: unknown) =>
  new BotsError({ message, ...(cause === undefined ? {} : { cause }) });

export class Dictation extends Context.Service<
  Dictation,
  {
    /** Transcribes a pending recording and deletes it, whatever the outcome. */
    readonly transcribe: (
      input: DictationTranscribeInput,
    ) => Effect.Effect<DictationTranscribeResult, BotsError>;
  }
>()("t3/bots/dictation/Dictation") {}

export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig.ServerConfig;

  const complete = (key: Redacted.Redacted, body: unknown, timeout: "120 seconds" | "30 seconds") =>
    Effect.gen(function* () {
      const response = yield* HttpClientRequest.post(ENDPOINT).pipe(
        HttpClientRequest.bearerToken(Redacted.value(key)),
        HttpClientRequest.bodyJson(body),
        Effect.flatMap((request) => httpClient.execute(request)),
        Effect.timeout(timeout),
        Effect.mapError((cause) => failure("Could not reach the transcription service.", cause)),
      );
      const decoded = yield* HttpClientResponse.schemaBodyJson(ChatResponse)(response).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (response.status < 200 || response.status >= 300 || decoded === null || decoded.error) {
        const detail = decoded?.error?.message ?? `HTTP ${response.status}`;
        return yield* failure(`The transcription service failed: ${detail}`);
      }
      const content = decoded.choices?.[0]?.message?.content;
      const text =
        typeof content === "string"
          ? content
          : (content ?? []).map((part) => part.text ?? "").join("");
      return text.trim();
    });

  const transcribeRecording = (path: string, extension: string, key: Redacted.Redacted) =>
    Effect.gen(function* () {
      const format = AUDIO_FORMATS[extension];
      if (format === undefined) {
        return yield* failure(
          "Unsupported recording format. Use WebM, Ogg, M4A, AAC, WAV, MP3 or FLAC.",
        );
      }
      const info = yield* fileSystem
        .stat(path)
        .pipe(Effect.mapError((cause) => failure("The recording was not found.", cause)));
      if (Number(info.size) > MAX_DICTATION_BYTES) {
        return yield* failure("The recording is larger than 20 MB.");
      }
      const audio = yield* fileSystem
        .readFile(path)
        .pipe(Effect.mapError((cause) => failure("Could not read the recording.", cause)));

      const raw = yield* complete(
        key,
        {
          model: yield* readModel(DICTATION_MODEL_ENV, DEFAULT_DICTATION_MODEL),
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: TRANSCRIBE_INSTRUCTION },
                {
                  type: "input_audio",
                  input_audio: { data: Buffer.from(audio).toString("base64"), format },
                },
              ],
            },
          ],
        },
        "120 seconds",
      );
      if (raw.length === 0) return { text: "" };

      const polishModel = yield* readModel(
        DICTATION_POLISH_MODEL_ENV,
        DEFAULT_DICTATION_POLISH_MODEL,
      );
      if (polishModel === DICTATION_POLISH_OFF) return { text: raw };
      // A failed cleanup still leaves a usable transcript.
      const polished = yield* complete(
        key,
        {
          model: polishModel,
          messages: [
            { role: "system", content: POLISH_INSTRUCTION },
            { role: "user", content: raw },
          ],
        },
        "30 seconds",
      ).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Dictation cleanup failed; keeping the raw transcript.", {
            message: error.message,
          }),
        ),
        Effect.orElseSucceed(() => ""),
      );
      return { text: polished.length > 0 ? polished : raw };
    });

  const transcribe = Effect.fn("Dictation.transcribe")(function* (input: DictationTranscribeInput) {
    // Only a fresh upload: a thread's attachment must never be read here, let alone deleted.
    if (
      parseThreadSegmentFromAttachmentId(input.attachmentId) !== PENDING_ATTACHMENT_THREAD_SEGMENT
    ) {
      return yield* failure("That recording is not a pending upload.");
    }
    const path = resolveAttachmentPathById({
      attachmentsDir: config.attachmentsDir,
      attachmentId: input.attachmentId,
    });
    if (path === null) return yield* failure("The recording was not found.");
    const extension = parseAttachmentFileExtension(input.attachmentId) ?? "";
    return yield* Effect.gen(function* () {
      const key = yield* readKey;
      if (Option.isNone(key)) {
        return yield* failure(`Dictation needs ${DICTATION_KEY_ENV} on the server.`);
      }
      return yield* transcribeRecording(path, extension, key.value);
    }).pipe(Effect.ensuring(fileSystem.remove(path, { force: true }).pipe(Effect.ignore)));
  });

  return Dictation.of({ transcribe });
});

export const layer = Layer.effect(Dictation, make);
