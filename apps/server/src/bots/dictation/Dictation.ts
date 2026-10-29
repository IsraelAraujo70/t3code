/**
 * Dictation: a recording the client uploaded as a pending attachment in, text ready to send out.
 * Two OpenRouter calls: an audio model transcribes, then a light text model removes filler and
 * fixes punctuation. The key comes from `OPENROUTER_API_KEY`, is sent only to OpenRouter, and is
 * never logged. Every server holding the key may transcribe, not just the bots host.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Redacted from "effect/Redacted";
import { HttpClient } from "effect/http";

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
import {
  completeOpenRouterChat,
  OPENROUTER_KEY_ENV,
  readOpenRouterKey,
  readOpenRouterModel,
} from "../openRouter.ts";

export const DICTATION_MODEL_ENV = "T3CODE_DICTATION_MODEL";
const DICTATION_POLISH_MODEL_ENV = "T3CODE_DICTATION_POLISH_MODEL";
export const DEFAULT_DICTATION_MODEL = "google/gemini-3.8-flash";
export const DEFAULT_DICTATION_POLISH_MODEL = "anthropic/claude-haiku-5.5";
/** Setting the polish model to this skips the cleanup call. */
const DICTATION_POLISH_OFF = "off";

/** About 10 minutes of the compressed audio clients record; the client stops at 5. */
const MAX_DICTATION_BYTES = 20 * 1024 * 1024;

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

/** Whether this server can transcribe; decides the `dictation` capability. */
export const isDictationConfigured: Effect.Effect<boolean> = readOpenRouterKey.pipe(
  Effect.map(Option.isSome),
);

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

const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig.ServerConfig;

  const complete = (key: Redacted.Redacted, body: unknown, timeout: "120 seconds" | "30 seconds") =>
    completeOpenRouterChat({
      httpClient,
      key,
      body,
      timeout,
      service: "transcription",
      error: failure,
    });

  const transcribeRecording = Effect.fn("Dictation.transcribeRecording")(function* (
    path: string,
    extension: string,
    key: Redacted.Redacted,
  ) {
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
        model: yield* readOpenRouterModel(DICTATION_MODEL_ENV, DEFAULT_DICTATION_MODEL),
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

    const polishModel = yield* readOpenRouterModel(
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
      const key = yield* readOpenRouterKey;
      if (Option.isNone(key)) {
        return yield* failure(`Dictation needs ${OPENROUTER_KEY_ENV} on the server.`);
      }
      return yield* transcribeRecording(path, extension, key.value);
    }).pipe(Effect.ensuring(fileSystem.remove(path, { force: true }).pipe(Effect.ignore)));
  });

  return Dictation.of({ transcribe });
});

export const layer = Layer.effect(Dictation, make);
