/**
 * The voice reader's line to Codex realtime: a dedicated `codex app-server` (the `codex` provider
 * instance's binary, home and environment), never the agent sessions' app-server. Realtime is an
 * experimental app-server API, so its requests go through `client.raw.request`; its notifications
 * are in the generated catalog. Only WebRTC: the WebSocket/PCM transport needs an API key.
 */
import { BotsError, CodexSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Deferred from "effect/Deferred";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { withCodexAppServerClient } from "../../provider/CodexProvider.ts";
import { resolveCodexHomeLayout } from "../../provider/Drivers/CodexHomeLayout.ts";
import { deriveProviderInstanceConfigMap } from "../../provider/ProviderInstanceRegistryHydration.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ServerConfig from "../../config.ts";

/** What one realtime session reports, in order. The stream ends after `closed`. */
export type RealtimeEvent =
  /** The voice's own words (assistant role); user-role transcripts are dropped. */
  | { readonly type: "transcript"; readonly delta: string }
  /** The voice finished generating a response; its audio may still be playing on the client. */
  | { readonly type: "transcript-done" }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "closed"; readonly reason: string | null };

export interface RealtimeSession {
  /** The remote SDP for the client's peer (`thread/realtime/sdp`). */
  readonly answerSdp: string;
  readonly events: Stream.Stream<RealtimeEvent>;
  /** `thread/realtime/appendSpeech`: the model speaks about `text` per the session prompt. */
  readonly appendSpeech: (text: string) => Effect.Effect<void, BotsError>;
  /** `thread/realtime/stop`. Idempotent; also runs when the session's scope closes. */
  readonly stop: Effect.Effect<void>;
}

export interface RealtimeHost {
  /**
   * `thread/realtime/start` over WebRTC with the client's offer, then waits for the answer SDP.
   * Sessions on one host are sequential: start the next only after the previous one stopped.
   */
  readonly startSession: (input: {
    readonly offerSdp: string;
    readonly prompt: string;
  }) => Effect.Effect<RealtimeSession, BotsError, Scope.Scope>;
}

export class CodexRealtime extends Context.Service<
  CodexRealtime,
  {
    /**
     * Spawns the app-server, initializes it with the experimental API, requires a ChatGPT login
     * (`account/read`), and starts an ephemeral thread in an isolated directory. The process lives
     * until the scope closes. Fails with a `BotsError` the user can act on.
     */
    readonly open: Effect.Effect<RealtimeHost, BotsError, Scope.Scope>;
  }
>()("t3/bots/voiceReader/CodexRealtime") {}

const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);

/** @internal Payload subset consumed by the voice reader. */
export type RealtimeNotifications = {
  "thread/realtime/sdp": { threadId: string; sdp: string };
  "thread/realtime/transcript/delta": { threadId: string; role: string; delta: string };
  "thread/realtime/transcript/done": { threadId: string; role: string; text: string };
  "thread/realtime/error": { threadId: string; message: string };
  "thread/realtime/closed": { threadId: string; reason?: string | null };
};

interface ActiveSession {
  readonly answer: Deferred.Deferred<string, BotsError>;
  readonly events: Queue.Queue<RealtimeEvent>;
  readonly closed: Deferred.Deferred<void>;
}

type NotificationHandlers = {
  [M in keyof RealtimeNotifications]: (payload: RealtimeNotifications[M]) => Effect.Effect<void>;
};

/** @internal The session protocol needs only requests and scoped notification subscriptions. */
export interface RealtimeRpc {
  readonly request: (method: string, params: unknown) => Effect.Effect<unknown, Error>;
  readonly onNotification: (
    handlers: NotificationHandlers,
  ) => Effect.Effect<void, never, Scope.Scope>;
}

/** @internal ChatGPT authentication is required by the WebRTC voice protocol. */
export const isChatGptAccount = (account: { readonly type: string } | null | undefined): boolean =>
  account?.type === "chatgpt";

/** @internal Builds the scoped session protocol independently of the app-server process. */
export const makeRealtimeHost = Effect.fn("CodexRealtime.makeRealtimeHost")(function* (
  rpc: RealtimeRpc,
  threadId: string,
) {
  const active = yield* Ref.make<ActiveSession | null>(null);
  const receive =
    <M extends keyof RealtimeNotifications>(
      handler: (
        session: ActiveSession,
        payload: RealtimeNotifications[M],
      ) => Effect.Effect<unknown>,
    ) =>
    (payload: RealtimeNotifications[M]) =>
      Effect.gen(function* () {
        const session = yield* Ref.get(active);
        if (payload.threadId === threadId && session) yield* handler(session, payload);
      });
  yield* rpc.onNotification({
    "thread/realtime/sdp": receive<"thread/realtime/sdp">((session, payload) =>
      Deferred.succeed(session.answer, payload.sdp),
    ),
    "thread/realtime/transcript/delta": receive<"thread/realtime/transcript/delta">(
      (session, payload) =>
        payload.role === "assistant"
          ? Queue.offer(session.events, { type: "transcript", delta: payload.delta })
          : Effect.void,
    ),
    "thread/realtime/transcript/done": receive<"thread/realtime/transcript/done">(
      (session, payload) =>
        payload.role === "assistant"
          ? Queue.offer(session.events, { type: "transcript-done" })
          : Effect.void,
    ),
    "thread/realtime/error": receive<"thread/realtime/error">((session, payload) =>
      Effect.gen(function* () {
        yield* Deferred.fail(
          session.answer,
          new BotsError({ message: `Codex realtime failed: ${payload.message}` }),
        );
        yield* Queue.offer(session.events, { type: "error", message: payload.message });
      }),
    ),
    "thread/realtime/closed": receive<"thread/realtime/closed">((session, payload) =>
      Effect.gen(function* () {
        yield* Deferred.fail(
          session.answer,
          new BotsError({ message: "Codex realtime closed before answering." }),
        );
        yield* Queue.offer(session.events, { type: "closed", reason: payload.reason ?? null });
        yield* Deferred.succeed(session.closed, undefined);
      }),
    ),
  });
  return {
    startSession: Effect.fn("CodexRealtime.startSession")(function* (input: {
      readonly offerSdp: string;
      readonly prompt: string;
    }) {
      const session: ActiveSession = {
        answer: yield* Deferred.make<string, BotsError>(),
        events: yield* Queue.unbounded<RealtimeEvent>(),
        closed: yield* Deferred.make<void>(),
      };
      const stopped = yield* Ref.make(false);
      const stop = Effect.gen(function* () {
        if (yield* Ref.getAndSet(stopped, true)) return;
        yield* rpc
          .request("thread/realtime/stop", { threadId })
          .pipe(Effect.timeoutOption("5 seconds"), Effect.ignore);
        // Notifications carry only the thread id: keep routing to this session until its
        // `closed` arrives, so a late one never lands on the next session of the thread.
        yield* Deferred.await(session.closed).pipe(Effect.timeoutOption("3 seconds"));
        yield* Ref.update(active, (current) => (current === session ? null : current));
      }).pipe(Effect.uninterruptible);
      yield* Effect.acquireRelease(Ref.set(active, session), () => stop);
      const answerSdp = yield* Effect.gen(function* () {
        yield* rpc
          .request("thread/realtime/start", {
            threadId,
            version: "v3",
            outputModality: "audio",
            includeStartupContext: false,
            clientManagedHandoffs: true,
            flushTranscriptTailOnSessionEnd: false,
            delegationAckFiller: false,
            prompt: input.prompt,
            transport: { type: "webrtc", sdp: input.offerSdp },
          })
          .pipe(
            Effect.mapError(
              (cause) =>
                new BotsError({
                  message: `This Codex can't start a realtime voice session: ${String(cause)}`,
                  cause,
                }),
            ),
          );
        return yield* Deferred.await(session.answer);
      }).pipe(
        Effect.timeoutOrElse({
          duration: "20 seconds",
          orElse: () =>
            Effect.fail(new BotsError({ message: "Codex realtime did not answer in time." })),
        }),
        Effect.onError(() => stop),
      );
      return {
        answerSdp,
        events: Stream.fromQueue(session.events).pipe(
          Stream.takeUntil((event) => event.type === "closed"),
        ),
        appendSpeech: Effect.fn("CodexRealtime.appendSpeech")((text: string) =>
          rpc.request("thread/realtime/appendSpeech", { threadId, text }).pipe(
            Effect.asVoid,
            Effect.mapError(
              (cause) =>
                new BotsError({
                  message: `Codex realtime couldn't speak: ${String(cause)}`,
                  cause,
                }),
            ),
          ),
        ),
        stop,
      } satisfies RealtimeSession;
    }),
  } satisfies RealtimeHost;
});

/** Dedicated, scoped Codex process using the configured Codex provider instance. */
export const layer = Layer.effect(
  CodexRealtime,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const settings = yield* ServerSettings.ServerSettingsService;
    const serverConfig = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const hostEnvironment = yield* HostProcess.Environment;
    const home = yield* HostProcess.HomeDirectory;
    return {
      open: Effect.gen(function* () {
        const instance = deriveProviderInstanceConfigMap(
          yield* settings.getSettings.pipe(
            Effect.mapError(
              (cause) =>
                new BotsError({
                  message: `Couldn't start Codex for the voice reader: ${String(cause)}`,
                  cause,
                }),
            ),
          ),
        )[ProviderInstanceId.make("codex")];
        if (!instance || instance.driver !== "codex")
          return yield* new BotsError({
            message: 'The voice reader needs the Codex provider (instance "codex").',
          });
        const { client, threadId } = yield* Effect.gen(function* () {
          const config = yield* decodeCodexSettings(instance.config ?? {});
          const layout = yield* resolveCodexHomeLayout(config).pipe(
            Effect.provideService(Path.Path, path),
          );
          const cwd = path.join(serverConfig.stateDir, "voice-reader");
          yield* fs.makeDirectory(cwd, { recursive: true });
          const { client } = yield* withCodexAppServerClient({
            binaryPath: expandHomePath(config.binaryPath || "codex", home),
            homePath: layout.effectiveHomePath,
            launchArgs: config.launchArgs,
            cwd,
            environment: yield* mergeProviderInstanceEnvironment(
              instance.environment,
              hostEnvironment,
            ),
          }).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          );
          return { client, cwd };
        }).pipe(
          Effect.mapError(
            (cause) =>
              new BotsError({
                message: `Couldn't start Codex for the voice reader: ${String(cause)}`,
                cause,
              }),
          ),
          Effect.flatMap(({ client, cwd }) =>
            Effect.gen(function* () {
              const account = yield* client.request("account/read", { refreshToken: false }).pipe(
                Effect.mapError(
                  (cause) =>
                    new BotsError({
                      message: `Couldn't start Codex for the voice reader: ${String(cause)}`,
                      cause,
                    }),
                ),
              );
              if (!isChatGptAccount(account.account))
                return yield* new BotsError({
                  message:
                    "The voice reader needs Codex signed in with ChatGPT (it uses ChatGPT's realtime voice, not an API key).",
                });
              const result = yield* client
                .request("thread/start", {
                  cwd,
                  ephemeral: true,
                  approvalPolicy: "never",
                  sandbox: "read-only",
                  baseInstructions: "Voice reader. Never run tools or agent tasks.",
                  config: { mcp_servers: {} },
                })
                .pipe(
                  Effect.mapError(
                    (cause) =>
                      new BotsError({
                        message: `Couldn't start Codex for the voice reader: ${String(cause)}`,
                        cause,
                      }),
                  ),
                );
              return { client, threadId: result.thread.id };
            }),
          ),
        );
        return yield* makeRealtimeHost(
          {
            request: (method, params) => client.raw.request(method, params),
            onNotification: Effect.fn("CodexRealtime.subscribe")(function* (
              handlers: NotificationHandlers,
            ) {
              yield* client.handleServerNotification(
                "thread/realtime/sdp",
                handlers["thread/realtime/sdp"],
              );
              yield* client.handleServerNotification(
                "thread/realtime/transcript/delta",
                handlers["thread/realtime/transcript/delta"],
              );
              yield* client.handleServerNotification(
                "thread/realtime/transcript/done",
                handlers["thread/realtime/transcript/done"],
              );
              yield* client.handleServerNotification(
                "thread/realtime/error",
                handlers["thread/realtime/error"],
              );
              yield* client.handleServerNotification(
                "thread/realtime/closed",
                handlers["thread/realtime/closed"],
              );
            }),
          },
          threadId,
        );
      }).pipe(Effect.withSpan("CodexRealtime.open")),
    };
  }),
);
