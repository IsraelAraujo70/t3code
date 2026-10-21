import { EnvironmentId, type AttachmentCreateUploadUrlInput } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult, type AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { VoiceTranscriptionError } from "../voice-input/transcription.ts";
import { createServerVoiceTranscriber, type DictationRecording } from "./bots.ts";
import type { AttachmentByteUpload } from "./attachments.ts";

const ENVIRONMENT = EnvironmentId.make("env-1");
const RECORDING: DictationRecording = { name: "voice.webm", mimeType: "audio/webm", sizeBytes: 42 };
const registry = {} as AtomRegistry.AtomRegistry;

function harness(options: {
  readonly transfer?: (abort: () => void) => Promise<void>;
  readonly transcribe?: () => AsyncResult.AsyncResult<{ readonly text: string }, unknown>;
}) {
  const uploads: Array<AttachmentCreateUploadUrlInput> = [];
  const removed: Array<string> = [];
  const transcribed: Array<string> = [];
  let transferAborted = false;
  const transcriber = createServerVoiceTranscriber({
    registry,
    createUploadUrl: {
      label: "create-upload-url",
      run: async (_registry, { input }) => {
        uploads.push(input);
        return AsyncResult.success({
          attachmentId: "pending-1.webm",
          relativeUrl: "/api/attachments/upload/token",
          expiresAt: 0,
        });
      },
    },
    remove: {
      label: "remove",
      run: async (_registry, { input }) => {
        removed.push(input.attachmentId);
        return AsyncResult.success({});
      },
    },
    transcribe: {
      label: "transcribe",
      run: async (_registry, { input }) => {
        transcribed.push(input.attachmentId);
        return (options.transcribe?.() ??
          AsyncResult.success({ text: "Roda os testes." })) as never;
      },
    },
    environmentId: () => ENVIRONMENT,
    locale: () => "pt-BR",
    describeRecording: async () => RECORDING,
    resolveUploadUrl: (_environmentId, relativeUrl) => `https://host${relativeUrl}`,
    transport: (): AttachmentByteUpload => {
      const abort = () => {
        transferAborted = true;
      };
      return { done: options.transfer?.(abort) ?? Promise.resolve(), abort };
    },
  });
  return {
    transcriber,
    uploads,
    removed,
    transcribed,
    wasTransferAborted: () => transferAborted,
  };
}

async function transcribe(
  transcriber: ReturnType<typeof harness>["transcriber"],
  signal = new AbortController().signal,
) {
  const prepared = await transcriber.prepare({ signal });
  return prepared.transcribe("blob:recording", { signal });
}

async function rejection(promise: Promise<unknown>): Promise<VoiceTranscriptionError> {
  const error = await promise.then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(error).toBeInstanceOf(VoiceTranscriptionError);
  return error as VoiceTranscriptionError;
}

describe("createServerVoiceTranscriber", () => {
  it("uploads the recording as a file attachment and returns the server's text", async () => {
    const test = harness({});

    await expect(transcribe(test.transcriber)).resolves.toBe("Roda os testes.");
    expect(test.uploads).toEqual([{ type: "file", ...RECORDING }]);
    expect(test.transcribed).toEqual(["pending-1.webm"]);
    // The server deletes the recording it transcribed.
    expect(test.removed).toEqual([]);
  });

  it("releases the pending upload and skips transcription when the transfer fails", async () => {
    const test = harness({ transfer: () => Promise.reject(new Error("Upload rejected (413)")) });

    const error = await rejection(transcribe(test.transcriber));
    expect(error.code).toBe("transcription-failed");
    expect(test.removed).toEqual(["pending-1.webm"]);
    expect(test.transcribed).toEqual([]);
  });

  it("aborts the transfer and releases the upload when cancelled mid-upload", async () => {
    const controller = new AbortController();
    const test = harness({
      transfer: (abort) =>
        new Promise((_resolve, reject) => {
          controller.signal.addEventListener("abort", () => {
            abort();
            reject(new Error("Upload cancelled"));
          });
          queueMicrotask(() => controller.abort());
        }),
    });

    const error = await rejection(transcribe(test.transcriber, controller.signal));
    expect(error.code).toBe("cancelled");
    expect(test.wasTransferAborted()).toBe(true);
    expect(test.removed).toEqual(["pending-1.webm"]);
    expect(test.transcribed).toEqual([]);
  });

  it("reports the server's reason when transcription fails", async () => {
    const test = harness({
      transcribe: () =>
        AsyncResult.failure(
          Cause.fail({
            _tag: "BotsError",
            message: "Dictation needs OPENROUTER_API_KEY on the server.",
          }),
        ),
    });

    const error = await rejection(transcribe(test.transcriber));
    expect(error.code).toBe("transcription-failed");
    expect(error.message).toBe("Dictation needs OPENROUTER_API_KEY on the server.");
  });
});
