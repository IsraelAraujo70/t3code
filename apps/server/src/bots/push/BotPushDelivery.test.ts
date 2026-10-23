// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as BotsStore from "../BotsStore.ts";
import * as BotPushDelivery from "./BotPushDelivery.ts";

const TOKEN_URI = "https://oauth2.test/token";
const SEND_URL = "https://fcm.googleapis.com/v1/projects/friend-push/messages:send";

const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });

const writeServiceAccount = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-bot-push-"));
  const file = NodePath.join(dir, "service-account.json");
  NodeFS.writeFileSync(
    file,
    JSON.stringify({
      type: "service_account",
      project_id: "friend-push",
      client_email: "push@friend-push.iam.gserviceaccount.com",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
      token_uri: TOKEN_URI,
    }),
  );
  return file;
};

interface Recorded {
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: string;
}

type Reply = { readonly status: number; readonly body: unknown };

/** A fake Google: issues one access token and answers each device token with its reply. */
const layerGoogle = (replies: Readonly<Record<string, Reply>>, requests: Array<Recorded>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const body =
          request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
        requests.push({ url: request.url, authorization: request.headers.authorization, body });
        const reply: Reply =
          request.url === TOKEN_URI
            ? { status: 200, body: { access_token: "ya29.test", expires_in: 3600 } }
            : (replies[JSON.parse(body).message.token] ?? { status: 200, body: {} });
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

const layerTest = (
  env: Record<string, string>,
  replies: Readonly<Record<string, Reply>>,
  requests: Array<Recorded>,
) =>
  BotPushDelivery.layer.pipe(
    Layer.provideMerge(BotsStore.layerMemory),
    Layer.provideMerge(layerGoogle(replies, requests)),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
  );

const register = (token: string) =>
  Effect.gen(function* () {
    const store = yield* BotsStore.BotsStore;
    yield* store.upsertPushDevice({
      token,
      label: null,
      createdAt: `2026-10-21T10:00:0${token.at(-1)}.000Z`,
      updatedAt: "2026-10-21T10:00:00.000Z",
    });
  });

const ownerAudience = Effect.map(BotsStore.BotsStore, (store) => ({
  devices: store.listPushDevices,
  drop: store.deletePushDevice,
}));

const DATA = { t3_kind: "bot_message", alert_id: "bot-push:run:run-1", alert_body: "Done." };

describe("BotPushDelivery", () => {
  it.effect("signs in as the service account once and sends the data to every device", () => {
    const requests: Array<Recorded> = [];
    return Effect.gen(function* () {
      const delivery = yield* BotPushDelivery.BotPushDelivery;
      assert.isTrue(delivery.enabled);
      yield* register("device-1");
      yield* register("device-2");

      yield* delivery.deliver(DATA, yield* ownerAudience);
      yield* delivery.deliver(DATA, yield* ownerAudience);

      const tokenRequests = requests.filter((request) => request.url === TOKEN_URI);
      assert.strictEqual(tokenRequests.length, 1, "the access token is cached");
      const form = new URLSearchParams(tokenRequests[0]!.body);
      assert.strictEqual(form.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
      const [header, claims, signature] = form.get("assertion")!.split(".");
      assert.isTrue(
        NodeCrypto.createVerify("RSA-SHA256")
          .update(`${header}.${claims}`)
          .verify(publicKey, signature!, "base64url"),
      );
      const decoded = JSON.parse(Buffer.from(claims!, "base64url").toString());
      assert.strictEqual(decoded.iss, "push@friend-push.iam.gserviceaccount.com");
      assert.strictEqual(decoded.scope, "https://www.googleapis.com/auth/firebase.messaging");
      assert.strictEqual(decoded.aud, TOKEN_URI);
      assert.strictEqual(decoded.exp - decoded.iat, 3600);

      const sends = requests.filter((request) => request.url === SEND_URL);
      assert.strictEqual(sends.length, 4);
      assert.isTrue(sends.every((send) => send.authorization === "Bearer ya29.test"));
      const toFirst = sends
        .map((send) => JSON.parse(send.body))
        .find((body) => body.message.token === "device-1");
      assert.deepStrictEqual(toFirst, {
        message: {
          token: "device-1",
          data: DATA,
          android: { priority: "HIGH", ttl: "600s" },
        },
      });
    }).pipe(
      Effect.provide(
        layerTest(
          { [BotPushDelivery.FCM_SERVICE_ACCOUNT_ENV]: writeServiceAccount() },
          {},
          requests,
        ),
      ),
    );
  });

  it.effect("drops tokens FCM no longer knows and keeps the rest", () => {
    const requests: Array<Recorded> = [];
    const unregistered = {
      status: 404,
      body: {
        error: {
          status: "NOT_FOUND",
          details: [
            {
              "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError",
              errorCode: "UNREGISTERED",
            },
          ],
        },
      },
    };
    return Effect.gen(function* () {
      const delivery = yield* BotPushDelivery.BotPushDelivery;
      const store = yield* BotsStore.BotsStore;
      yield* register("device-1");
      yield* register("device-2");
      yield* register("device-3");

      yield* delivery.deliver(DATA, yield* ownerAudience);

      assert.deepStrictEqual(
        (yield* store.listPushDevices).map((device) => device.token),
        ["device-3"],
      );
    }).pipe(
      Effect.provide(
        layerTest(
          { [BotPushDelivery.FCM_SERVICE_ACCOUNT_ENV]: writeServiceAccount() },
          {
            "device-1": unregistered,
            "device-2": {
              status: 400,
              body: {
                error: {
                  status: "INVALID_ARGUMENT",
                  message: "The registration token is not a valid FCM registration token",
                },
              },
            },
            "device-3": { status: 503, body: { error: { status: "UNAVAILABLE" } } },
          },
          requests,
        ),
      ),
    );
  });

  it.effect("sends guest notifications and drops rejected tokens only through the audience", () => {
    const requests: Array<Recorded> = [];
    return Effect.gen(function* () {
      const delivery = yield* BotPushDelivery.BotPushDelivery;
      const store = yield* BotsStore.BotsStore;
      yield* register("guest-token");
      const dropped: string[] = [];
      const notification = { title: "Bia's bot", body: "Done." };
      yield* delivery.deliver(DATA, {
        devices: Effect.succeed([{ token: "guest-token", label: null }]),
        drop: (token) =>
          Effect.sync(() => {
            dropped.push(token);
          }),
        notification,
      });
      assert.deepStrictEqual(dropped, ["guest-token"]);
      assert.strictEqual((yield* store.listPushDevices).length, 1);
      assert.deepStrictEqual(
        JSON.parse(requests.find((request) => request.url === SEND_URL)!.body),
        {
          message: {
            token: "guest-token",
            data: DATA,
            notification,
            android: { priority: "HIGH", ttl: "600s", notification: { channel_id: "respostas" } },
          },
        },
      );
    }).pipe(
      Effect.provide(
        layerTest(
          { [BotPushDelivery.FCM_SERVICE_ACCOUNT_ENV]: writeServiceAccount() },
          { "guest-token": { status: 404, body: {} } },
          requests,
        ),
      ),
    );
  });

  it.effect("is off and sends nothing without a service account", () => {
    const requests: Array<Recorded> = [];
    return Effect.gen(function* () {
      const delivery = yield* BotPushDelivery.BotPushDelivery;
      yield* register("device-1");

      yield* delivery.deliver(DATA, yield* ownerAudience);

      assert.isFalse(delivery.enabled);
      assert.deepStrictEqual(requests, []);
    }).pipe(Effect.provide(layerTest({}, {}, requests)));
  });
});

describe("isFcmTokenGone", () => {
  it("treats only dead tokens as gone", () => {
    assert.isTrue(BotPushDelivery.isFcmTokenGone(404, null));
    assert.isTrue(
      BotPushDelivery.isFcmTokenGone(400, {
        error: {
          status: "INVALID_ARGUMENT",
          details: [{ fieldViolations: [{ field: "message.token" }] }],
        },
      }),
    );
    assert.isFalse(
      BotPushDelivery.isFcmTokenGone(400, {
        error: { status: "INVALID_ARGUMENT", message: "Invalid data payload" },
      }),
    );
    assert.isFalse(BotPushDelivery.isFcmTokenGone(401, null));
    assert.isFalse(BotPushDelivery.isFcmTokenGone(500, { error: { status: "INTERNAL" } }));
  });
});
