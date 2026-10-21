import { AuthOrchestrationOperateScope, type EnvironmentId } from "@t3tools/contracts";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { createServerVoiceTranscriber } from "@t3tools/client-runtime/state/bots";

import { appAtomRegistry } from "../rpc/atomRegistry";
import { attachmentEnvironment } from "../state/attachments";
import { botsEnvironment } from "../state/bots";
import { readEnvironmentScope, readPreparedConnection } from "../state/session";

/** Containers the server transcribes, in the order a browser is asked for them. */
const RECORDING_TYPES = [
  { mimeType: "audio/webm;codecs=opus", extension: "webm" },
  { mimeType: "audio/webm", extension: "webm" },
  { mimeType: "audio/ogg;codecs=opus", extension: "ogg" },
  { mimeType: "audio/mp4", extension: "m4a" },
] as const;

export interface RecordingType {
  /** What MediaRecorder is asked to produce. */
  readonly mimeType: string;
  /** The stored file's extension, which tells the server the container. */
  readonly extension: string;
}

/**
 * The first container this browser records that the server also reads (Chromium and Electron
 * record WebM, Safari MP4), or null when it records none of them.
 */
export function pickRecordingType(
  isTypeSupported: (mimeType: string) => boolean,
): RecordingType | null {
  return RECORDING_TYPES.find((type) => isTypeSupported(type.mimeType)) ?? null;
}

const UPLOAD_TIMEOUT_MS = 2 * 60_000;

/**
 * Uploads a finished recording to `environmentId` and returns its cleaned-up transcript. Throws
 * a VoiceTranscriptionError; `cancelled` when `signal` aborts first.
 */
export async function transcribeRecording(input: {
  readonly environmentId: EnvironmentId;
  readonly recording: Blob;
  readonly type: RecordingType;
  readonly signal: AbortSignal;
}): Promise<string> {
  const mimeType = input.type.mimeType.split(";")[0]!;
  const transcriber = createServerVoiceTranscriber({
    registry: appAtomRegistry,
    createUploadUrl: attachmentEnvironment.createUploadUrl,
    remove: attachmentEnvironment.remove,
    transcribe: botsEnvironment.transcribeDictation,
    environmentId: () => input.environmentId,
    locale: () => navigator.language,
    describeRecording: async () => ({
      name: `dictation.${input.type.extension}`,
      mimeType,
      sizeBytes: input.recording.size,
    }),
    resolveUploadUrl: (environmentId, relativeUrl) => {
      if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return null;
      const connection = readPreparedConnection(environmentId);
      return connection ? resolveAssetUrl(connection.httpBaseUrl, relativeUrl) : null;
    },
    transport: (url) => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
      const done = fetch(url, {
        method: "POST",
        headers: { "Content-Type": mimeType },
        body: input.recording,
        signal: controller.signal,
      })
        .then((response) => {
          if (!response.ok) throw new Error(`Upload rejected (${response.status})`);
        })
        .finally(() => clearTimeout(timeout));
      return { done, abort: () => controller.abort() };
    },
  });
  const prepared = await transcriber.prepare({ signal: input.signal });
  // The recording is in memory, so the uri only names it.
  return prepared.transcribe("memory:dictation", { signal: input.signal });
}
