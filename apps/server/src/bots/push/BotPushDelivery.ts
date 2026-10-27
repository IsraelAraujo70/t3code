/**
 * Sends a bot push to every registered phone through the FCM HTTP v1 API, signed in as the Google
 * service account whose JSON key file `T3CODE_FCM_SERVICE_ACCOUNT_FILE` names. Unset, push is off.
 * The key is read once at startup and never logged, and neither is a device token. A token FCM no
 * longer knows is deleted; every other failure is logged and dropped, never raised.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto cannot sign RS256.
import * as NodeCrypto from "node:crypto";

import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import type { BotsError } from "@t3tools/contracts";

export const FCM_SERVICE_ACCOUNT_ENV = "T3CODE_FCM_SERVICE_ACCOUNT_FILE";

const FCM_SCOPE = "https://www.googleapis.com/auth/firebase.messaging";
const DEFAULT_TOKEN_URI = "https://oauth2.googleapis.com/token";
/** Sends in flight across every push, so a burst of bot replies cannot flood the uplink. */
const MAX_CONCURRENT_SENDS = 4;
/** Refresh this long before Google's expiry, so a token never lapses mid-request. */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;

/** FCM data values must be strings. */
export type BotPushData = Readonly<Record<string, string>>;

/** Devices and token cleanup belong to the same recipient. */
export interface BotPushAudience {
  readonly devices: Effect.Effect<
    ReadonlyArray<{ readonly token: string; readonly label: string | null }>,
    BotsError
  >;
  /** Forgets a token FCM no longer accepts. */
  readonly drop: (token: string) => Effect.Effect<void, BotsError>;
  /** Also sent as FCM notification for apps without a data-push handler. */
  readonly notification?: { readonly title: string; readonly body: string };
}

const ServiceAccount = Schema.Struct({
  project_id: Schema.String,
  client_email: Schema.String,
  private_key: Schema.String,
  token_uri: Schema.optional(Schema.String),
});

const decodeServiceAccount = Schema.decodeEffect(Schema.fromJsonString(ServiceAccount));

const TokenResponse = Schema.Struct({
  access_token: Schema.String,
  expires_in: Schema.Number,
});

const FcmErrorResponse = Schema.Struct({
  error: Schema.optional(
    Schema.Struct({
      status: Schema.optional(Schema.String),
      message: Schema.optional(Schema.String),
      details: Schema.optional(
        Schema.Array(
          Schema.Struct({
            errorCode: Schema.optional(Schema.String),
            fieldViolations: Schema.optional(
              Schema.Array(Schema.Struct({ field: Schema.optional(Schema.String) })),
            ),
          }),
        ),
      ),
    }),
  ),
});
type FcmErrorResponse = typeof FcmErrorResponse.Type;

/**
 * Pure. Whether FCM rejected a send because the token itself is dead: the app was uninstalled
 * or the token rotated (404 or UNREGISTERED), or it was never a token (400 naming it).
 */
export function isFcmTokenGone(status: number, body: FcmErrorResponse | null): boolean {
  if (status === 404) return true;
  const error = body?.error;
  const details = error?.details ?? [];
  if (details.some((detail) => detail.errorCode === "UNREGISTERED")) return true;
  if (status !== 400 || error?.status !== "INVALID_ARGUMENT") return false;
  return (
    details.some((detail) =>
      (detail.fieldViolations ?? []).some((violation) => violation.field === "message.token"),
    ) || (error.message ?? "").toLowerCase().includes("registration token")
  );
}

class FcmRequestError extends Schema.TaggedError<FcmRequestError>()("FcmRequestError", {
  stage: Schema.Literals(["token", "send"]),
  status: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.status === undefined
      ? `FCM ${this.stage} request failed.`
      : `FCM ${this.stage} request failed with HTTP ${this.status}.`;
  }
}

export class BotPushDelivery extends Context.Service<
  BotPushDelivery,
  {
    /** False when no service account is configured; then `deliver` does nothing. */
    readonly enabled: boolean;
    /** Sends to the audience devices. Never fails; failures are logged. */
    readonly deliver: (data: BotPushData, audience: BotPushAudience) => Effect.Effect<void>;
  }
>()("t3/bots/push/BotPushDelivery") {}

const disabled = BotPushDelivery.of({
  enabled: false,
  deliver: Effect.fn("BotPushDelivery.deliver")(() => Effect.void),
});

const readServiceAccount = Effect.fn("BotPushDelivery.readServiceAccount")(function* (
  path: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const text = yield* fileSystem.readFileString(path);
  const account = yield* decodeServiceAccount(text);
  const privateKey = yield* Effect.try(() => NodeCrypto.createPrivateKey(account.private_key));
  return { ...account, tokenUri: account.token_uri ?? DEFAULT_TOKEN_URI, privateKey };
});

const make = Effect.gen(function* () {
  const path = yield* Config.String(FCM_SERVICE_ACCOUNT_ENV).pipe(
    Config.option,
    Effect.map(Option.filter((value) => value.trim().length > 0)),
    Effect.orElseSucceed(() => Option.none<string>()),
  );
  if (Option.isNone(path)) {
    yield* Effect.logInfo(`Bot push is off: ${FCM_SERVICE_ACCOUNT_ENV} is not set.`);
    return disabled;
  }
  const loaded = yield* readServiceAccount(path.value).pipe(Effect.option);
  if (Option.isNone(loaded)) {
    yield* Effect.logWarning(
      `Bot push is off: ${FCM_SERVICE_ACCOUNT_ENV} does not name a readable service account key.`,
    );
    return disabled;
  }
  const account = loaded.value;
  const httpClient = yield* HttpClient.HttpClient;
  const sends = yield* Semaphore.make(MAX_CONCURRENT_SENDS);
  const accessToken = yield* SynchronizedRef.make(
    Option.none<{ readonly token: string; readonly expiresAt: number }>(),
  );
  const sendUrl = `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`;

  const signAssertion = (nowMs: number) => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const issuedAt = Math.floor(nowMs / 1000);
    const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
      iss: account.client_email,
      scope: FCM_SCOPE,
      aud: account.tokenUri,
      iat: issuedAt,
      exp: issuedAt + 3600,
    })}`;
    const signature = NodeCrypto.createSign("RSA-SHA256")
      .update(unsigned)
      .sign(account.privateKey, "base64url");
    return `${unsigned}.${signature}`;
  };

  const fetchAccessToken = Effect.fn("BotPushDelivery.fetchAccessToken")(function* (nowMs: number) {
    const response = yield* httpClient
      .execute(
        HttpClientRequest.post(account.tokenUri).pipe(
          HttpClientRequest.bodyUrlParams({
            grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
            assertion: signAssertion(nowMs),
          }),
        ),
      )
      .pipe(
        Effect.timeout("15 seconds"),
        Effect.mapError((cause) => new FcmRequestError({ stage: "token", cause })),
      );
    if (response.status < 200 || response.status >= 300) {
      return yield* new FcmRequestError({ stage: "token", status: response.status });
    }
    const body = yield* HttpClientResponse.schemaBodyJson(TokenResponse)(response).pipe(
      Effect.mapError((cause) => new FcmRequestError({ stage: "token", cause })),
    );
    return { token: body.access_token, expiresAt: nowMs + body.expires_in * 1000 };
  });

  const currentAccessToken = SynchronizedRef.modifyEffect(accessToken, (cached) =>
    Effect.gen(function* () {
      const nowMs = yield* Clock.currentTimeMillis;
      if (Option.isSome(cached) && cached.value.expiresAt - TOKEN_EXPIRY_MARGIN_MS > nowMs) {
        return [cached.value.token, cached] as const;
      }
      const fresh = yield* fetchAccessToken(nowMs);
      return [fresh.token, Option.some(fresh)] as const;
    }),
  );

  const sendTo = Effect.fn("BotPushDelivery.sendTo")(
    function* (
      device: { readonly token: string; readonly label: string | null },
      data: BotPushData,
      audience: BotPushAudience,
    ) {
      const token = yield* currentAccessToken;
      const response = yield* HttpClientRequest.post(sendUrl).pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.bodyJson({
          message: {
            token: device.token,
            data,
            ...(audience.notification ? { notification: audience.notification } : {}),
            android: {
              priority: "HIGH",
              ttl: "600s",
              ...(audience.notification ? { notification: { channel_id: "respostas" } } : {}),
            },
          },
        }),
        Effect.flatMap((request) => httpClient.execute(request)),
        Effect.timeout("15 seconds"),
        Effect.mapError((cause) => new FcmRequestError({ stage: "send", cause })),
      );
      if (response.status >= 200 && response.status < 300) return;
      const body = yield* HttpClientResponse.schemaBodyJson(FcmErrorResponse)(response).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (isFcmTokenGone(response.status, body)) {
        yield* audience.drop(device.token);
        yield* Effect.logInfo("Dropped a bot push device FCM no longer accepts", {
          label: device.label,
          status: response.status,
        });
        return;
      }
      // A revoked or rejected access token is fetched again on the next push.
      if (response.status === 401) yield* SynchronizedRef.set(accessToken, Option.none());
      return yield* new FcmRequestError({ stage: "send", status: response.status });
    },
    (effect, device) =>
      effect.pipe(
        sends.withPermits(1),
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not send a bot push", { label: device.label, cause }),
        ),
      ),
  );

  const deliver: BotPushDelivery["Service"]["deliver"] = (data, audience) =>
    audience.devices.pipe(
      Effect.flatMap((devices) =>
        Effect.forEach(devices, (device) => sendTo(device, data, audience), {
          concurrency: "unbounded",
          discard: true,
        }),
      ),
      Effect.catchCause((cause) => Effect.logWarning("Could not send bot pushes", { cause })),
    );

  yield* Effect.logInfo("Bot push is on.", { projectId: account.project_id });
  return BotPushDelivery.of({ enabled: true, deliver });
});

/** Needs an HttpClient and the FileSystem. */
export const layer = Layer.effect(BotPushDelivery, make);
