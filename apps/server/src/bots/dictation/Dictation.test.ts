// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import {
  ATTACHMENT_UPLOAD_ROUTE_PREFIX,
  issueAttachmentUploadUrl,
  storeAttachmentUpload,
  validateAttachmentUploadToken,
} from "../../assets/AttachmentUpload.ts";
import { resolveAttachmentRelativePath } from "../../attachmentPaths.ts";
import { createAttachmentId, resolveAttachmentPathById } from "../../attachmentStore.ts";
import * as ServerConfig from "../../config.ts";
import * as Dictation from "./Dictation.ts";

interface RecordedRequest {
  readonly model: string;
  readonly body: {
    readonly model: string;
    readonly messages: ReadonlyArray<{
      readonly role: string;
      readonly content:
        | string
        | ReadonlyArray<{
            readonly type: string;
            readonly input_audio?: { readonly data: string; readonly format: string };
          }>;
    }>;
  };
  readonly authorization: string | undefined;
}

/** A fake OpenRouter: answers each model with its scripted reply and records what it was sent. */
const layerOpenRouter = (
  replies: Readonly<Record<string, { readonly status: number; readonly body: unknown }>>,
  requests: Array<RecordedRequest>,
) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const text =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "{}";
        const body = JSON.parse(text) as RecordedRequest["body"];
        requests.push({ model: body.model, body, authorization: request.headers.authorization });
        const reply = replies[body.model] ?? { status: 404, body: { error: { message: "no" } } };
        return HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(reply.body), {
            status: reply.status,
            headers: { "content-type": "application/json" },
          }),
        );
      }),
    ),
  );

const answer = (content: string) => ({
  status: 200,
  body: { choices: [{ message: { content } }] },
});

const layerTest = (
  env: Record<string, string>,
  replies: Readonly<Record<string, { readonly status: number; readonly body: unknown }>>,
  requests: Array<RecordedRequest>,
) =>
  Dictation.layer.pipe(
    Layer.provideMerge(layerOpenRouter(replies, requests)),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-dictation-" })),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
  );

const KEY_ENV = { [Dictation.DICTATION_KEY_ENV]: "sk-test" };
const AUDIO = new TextEncoder().encode("fake-webm-bytes");

/** Uploads `AUDIO` the way a client does, as a pending `file` attachment. */
const uploadRecording = (name: string) =>
  Effect.gen(function* () {
    const issued = yield* issueAttachmentUploadUrl({
      type: "file",
      name,
      mimeType: "audio/webm",
      sizeBytes: AUDIO.byteLength,
    });
    const claims = yield* validateAttachmentUploadToken(
      issued.relativeUrl.slice(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/`.length),
    );
    assert.isNotNull(claims);
    const stored = yield* storeAttachmentUpload(claims!, AUDIO);
    assert.isTrue(stored.ok);
    const config = yield* ServerConfig.ServerConfig;
    const path = resolveAttachmentPathById({
      attachmentsDir: config.attachmentsDir,
      attachmentId: issued.attachmentId,
    });
    assert.isNotNull(path);
    return { attachmentId: issued.attachmentId, path: path! };
  });

describe("Dictation", () => {
  it.effect("transcribes the upload, cleans the transcript up, and deletes the recording", () => {
    const requests: Array<RecordedRequest> = [];
    return Effect.gen(function* () {
      const recording = yield* uploadRecording("voice.webm");
      const dictation = yield* Dictation.Dictation;

      const result = yield* dictation.transcribe({ attachmentId: recording.attachmentId });

      assert.deepStrictEqual(result, { text: "Roda os testes." });
      assert.deepStrictEqual(
        requests.map((request) => request.model),
        [Dictation.DEFAULT_DICTATION_MODEL, Dictation.DEFAULT_DICTATION_POLISH_MODEL],
      );
      assert.isTrue(requests.every((request) => request.authorization === "Bearer sk-test"));
      const audioPart = requests[0]!.body.messages[0]!.content;
      assert.isTrue(Array.isArray(audioPart));
      const sent = (audioPart as ReadonlyArray<{ readonly input_audio?: unknown }>).find(
        (part) => part.input_audio !== undefined,
      );
      assert.deepStrictEqual(sent?.input_audio, {
        data: Buffer.from(AUDIO).toString("base64"),
        format: "webm",
      });
      assert.strictEqual(requests[1]!.body.messages[1]!.content, "é roda os testes");
      assert.isFalse(NodeFS.existsSync(recording.path));
    }).pipe(
      Effect.provide(
        layerTest(
          KEY_ENV,
          {
            [Dictation.DEFAULT_DICTATION_MODEL]: answer("é roda os testes"),
            [Dictation.DEFAULT_DICTATION_POLISH_MODEL]: answer("Roda os testes."),
          },
          requests,
        ),
      ),
    );
  });

  it.effect("keeps the raw transcript when the cleanup call fails", () => {
    const requests: Array<RecordedRequest> = [];
    return Effect.gen(function* () {
      const recording = yield* uploadRecording("voice.m4a");
      const dictation = yield* Dictation.Dictation;

      const result = yield* dictation.transcribe({ attachmentId: recording.attachmentId });

      assert.deepStrictEqual(result, { text: "abre o server.ts" });
      assert.isFalse(NodeFS.existsSync(recording.path));
    }).pipe(
      Effect.provide(
        layerTest(
          { ...KEY_ENV, [Dictation.DICTATION_MODEL_ENV]: "custom/audio" },
          {
            "custom/audio": answer("abre o server.ts"),
            [Dictation.DEFAULT_DICTATION_POLISH_MODEL]: {
              status: 502,
              body: { error: { message: "upstream down" } },
            },
          },
          requests,
        ),
      ),
    );
  });

  it.effect("fails without a key, and still deletes the recording", () => {
    const requests: Array<RecordedRequest> = [];
    return Effect.gen(function* () {
      assert.isFalse(yield* Dictation.isDictationConfigured);
      const recording = yield* uploadRecording("voice.webm");
      const dictation = yield* Dictation.Dictation;

      const error = yield* dictation
        .transcribe({ attachmentId: recording.attachmentId })
        .pipe(Effect.flip);

      assert.include(error.message, Dictation.DICTATION_KEY_ENV);
      assert.lengthOf(requests, 0);
      assert.isFalse(NodeFS.existsSync(recording.path));
    }).pipe(Effect.provide(layerTest({ [Dictation.DICTATION_KEY_ENV]: "  " }, {}, requests)));
  });

  it.effect("never reads or deletes an attachment that belongs to a thread", () => {
    const requests: Array<RecordedRequest> = [];
    return Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const attachmentId = createAttachmentId("thread-1", "webm");
      assert.isNotNull(attachmentId);
      const path = resolveAttachmentRelativePath({
        attachmentsDir: config.attachmentsDir,
        relativePath: `${attachmentId!}.webm`,
      });
      assert.isNotNull(path);
      NodeFS.mkdirSync(NodePath.dirname(path!), { recursive: true });
      NodeFS.writeFileSync(path!, AUDIO);
      const dictation = yield* Dictation.Dictation;

      const error = yield* dictation.transcribe({ attachmentId: attachmentId! }).pipe(Effect.flip);

      assert.include(error.message, "not a pending upload");
      assert.lengthOf(requests, 0);
      assert.isTrue(NodeFS.existsSync(path!));
    }).pipe(Effect.provide(layerTest(KEY_ENV, {}, requests)));
  });
});
