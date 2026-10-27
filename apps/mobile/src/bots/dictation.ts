import { AuthOrchestrationOperateScope, type EnvironmentId } from "@t3tools/contracts";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import { createServerVoiceTranscriber } from "@t3tools/client-runtime/state/bots";
import type { VoiceTranscriber } from "@t3tools/client-runtime/voice-input";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import { File, UploadType } from "expo-file-system";

import { appAtomRegistry } from "../state/atom-registry";
import { attachmentEnvironment } from "../state/attachments";
import { environmentServerConfigsAtom } from "../state/server";
import { environmentSession, readEnvironmentScope } from "../state/session";
import { botsEnvironment } from "./state";

/** The server reads the container from the extension; expo-audio's preset records `.m4a`. */
const MIME_TYPES: Readonly<Record<string, string>> = {
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  aac: "audio/aac",
  wav: "audio/wav",
  ogg: "audio/ogg",
  webm: "audio/webm",
};

function recordingExtension(uri: string): string {
  const name = uri.split(/[?#]/)[0]!.split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

function createTranscriber(environmentId: EnvironmentId): VoiceTranscriber {
  return createServerVoiceTranscriber({
    registry: appAtomRegistry,
    createUploadUrl: attachmentEnvironment.createUploadUrl,
    remove: attachmentEnvironment.remove,
    transcribe: botsEnvironment.transcribeDictation,
    environmentId: () => environmentId,
    locale: () => Intl.DateTimeFormat().resolvedOptions().locale,
    describeRecording: async (uri) => {
      const extension = recordingExtension(uri);
      return {
        name: `dictation.${extension || "m4a"}`,
        mimeType: MIME_TYPES[extension] ?? "application/octet-stream",
        sizeBytes: new File(uri).size,
      };
    },
    resolveUploadUrl: (target, relativeUrl) => {
      if (!readEnvironmentScope(target, AuthOrchestrationOperateScope)) return null;
      const connection = appAtomRegistry.get(
        environmentSession.preparedConnectionValueAtom(target),
      );
      return Option.isNone(connection)
        ? null
        : resolveAssetUrl(connection.value.httpBaseUrl, relativeUrl);
    },
    transport: (url, uri, recording) => {
      const controller = new AbortController();
      const done = new File(uri)
        .upload(url, {
          httpMethod: "POST",
          uploadType: UploadType.BINARY_CONTENT,
          headers: { "Content-Type": recording.mimeType },
          signal: controller.signal,
        })
        .then((result) => {
          if (result.status < 200 || result.status >= 300) {
            throw new Error(`Upload rejected (${result.status})`);
          }
        });
      return { done, abort: () => controller.abort() };
    },
  });
}

const dictationEnvironmentIdAtom = Atom.make((get) => {
  for (const [environmentId, config] of get(environmentServerConfigsAtom)) {
    if (config.environment.capabilities.dictation === true) return environmentId;
  }
  return null;
});

/**
 * Server dictation for devices without on-device transcription (Android, older iOS), or null
 * when no connected server advertises `dictation`. Voice input is app-wide on the phone, so any
 * such server will do.
 */
export const serverVoiceTranscriberAtom = Atom.make((get) => {
  const environmentId = get(dictationEnvironmentIdAtom);
  return environmentId === null ? null : createTranscriber(environmentId);
}).pipe(Atom.withLabel("mobile:server-voice-transcriber"));
