import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodePlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { EnvironmentHttpApi, EnvironmentId, ScheduledTaskUpsertInput } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as RelayDeliveryProof from "../scheduledTasks/RelayDeliveryProof.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as WebhookRoute from "../scheduledTasks/webhookRoute.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import {
  WEBHOOK_PUBLIC_BASE_URL_ENV,
  parseWebhookPublicBaseUrl,
  withWebhookPublicBase,
} from "./webhookPublicBase.ts";

const PUBLIC_BASE = "https://omarchy.example.ts.net:8443";
const RELAY_BASE = "https://relay.example.com/v1/hooks/0123456789abcdef";

const configLayer = (env: Record<string, string>) =>
  ConfigProvider.layer(ConfigProvider.fromEnv({ env }));

const originFor = (env: Record<string, string>, relayHookBaseUrl: string | null) =>
  withWebhookPublicBase(Effect.succeed({ relayHookBaseUrl })).pipe(
    Effect.flatten,
    Effect.map((origin) => origin.relayHookBaseUrl),
    Effect.provide(configLayer(env)),
  );

describe("webhook public base", () => {
  it.effect("keeps the T3 Connect relay URL ahead of the public base", () =>
    Effect.gen(function* () {
      assert.equal(
        yield* originFor({ [WEBHOOK_PUBLIC_BASE_URL_ENV]: PUBLIC_BASE }, RELAY_BASE),
        RELAY_BASE,
      );
    }),
  );

  it.effect("serves the direct hook route from the public base when the relay has none", () =>
    Effect.gen(function* () {
      assert.equal(
        yield* originFor({ [WEBHOOK_PUBLIC_BASE_URL_ENV]: PUBLIC_BASE }, null),
        `${PUBLIC_BASE}/api/hooks`,
      );
    }),
  );

  it.effect("gives no URL without a relay or a public base", () =>
    Effect.gen(function* () {
      assert.isNull(yield* originFor({}, null));
    }),
  );

  it.effect("ignores an invalid public base", () =>
    Effect.gen(function* () {
      assert.isNull(yield* originFor({ [WEBHOOK_PUBLIC_BASE_URL_ENV]: `${PUBLIC_BASE}/` }, null));
    }),
  );

  it("accepts only https bases without a trailing slash, query, hash or credentials", () => {
    assert.equal(parseWebhookPublicBaseUrl(PUBLIC_BASE), PUBLIC_BASE);
    assert.equal(parseWebhookPublicBaseUrl(`${PUBLIC_BASE}/t3`), `${PUBLIC_BASE}/t3`);
    for (const invalid of [
      "",
      "omarchy.example.ts.net",
      "http://omarchy.example.ts.net:8443",
      `${PUBLIC_BASE}/`,
      `${PUBLIC_BASE}/t3/`,
      `${PUBLIC_BASE}?a=1`,
      `${PUBLIC_BASE}#x`,
      "https://user:pass@omarchy.example.ts.net",
      " https://omarchy.example.ts.net",
    ]) {
      assert.isNull(parseWebhookPublicBaseUrl(invalid), invalid);
    }
  });
});

class WebhookTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.webhooks) {}

const decodeUpsertInput = Schema.decodeUnknownEffect(ScheduledTaskUpsertInput);

it.effect("starts the task's run when its public webhook URL is posted on a real listener", () =>
  Effect.gen(function* () {
    const launches = yield* Queue.unbounded<ThreadLaunchService.ThreadLaunchInput>();
    const scheduledTasks = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          NodePlatformCrypto.layer,
          Scheduler.layer,
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({
            launch: (input) =>
              Queue.offer(launches, input).pipe(
                Effect.as({ threadId: "thread-1", resumed: false } as never),
              ),
          }),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.effect(
            ScheduledTaskService.ScheduledTaskWebhookOrigin,
            withWebhookPublicBase(Effect.succeed({ relayHookBaseUrl: null })),
          ),
        ),
      ),
    );
    const services = yield* Layer.build(
      HttpRouter.serve(
        HttpApiBuilder.layer(WebhookTestApi).pipe(
          Layer.provide(WebhookRoute.layer),
          Layer.provide(RelayDeliveryProof.layer),
        ),
        { disableListenLog: true },
      ).pipe(
        Layer.provideMerge(NodeHttpServer.layerTest),
        Layer.provideMerge(scheduledTasks),
        Layer.provide(
          Layer.mock(ServerSecretStore.ServerSecretStore)({
            get: () => Effect.succeedNone,
          }),
        ),
        Layer.provide(
          Layer.mock(ServerEnvironment.ServerEnvironment)({
            getEnvironmentId: Effect.succeed(EnvironmentId.make("env-1")),
          }),
        ),
        Layer.provide(
          HttpPlatform.layer.pipe(
            Layer.provideMerge(NodeServices.layer),
            Layer.provideMerge(Etag.layerWeak),
          ),
        ),
        Layer.provide(SqlitePersistence.layerMemory),
        Layer.provide(configLayer({ [WEBHOOK_PUBLIC_BASE_URL_ENV]: PUBLIC_BASE })),
      ),
    );
    const service = Context.get(services, ScheduledTaskService.ScheduledTaskService);
    const client = Context.get(services, HttpClient.HttpClient);

    const { task } = yield* service.upsert(
      yield* decodeUpsertInput({
        id: "scheduled-task:whatsapp",
        title: "WhatsApp callback",
        prompt: "Message: {{body.text}}",
        enabled: true,
        schedule: { type: "webhook" },
        projectId: "project-webhook",
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      }),
    );
    const url = task.webhook?.url;
    assert.isString(url);
    const token = task.webhook!.path.split("/").at(-1)!;
    assert.equal(url, `${PUBLIC_BASE}/api/hooks/${encodeURIComponent(task.id)}/${token}`);

    const response = yield* client.execute(
      HttpClientRequest.post(new URL(url!).pathname).pipe(
        HttpClientRequest.bodyJsonUnsafe({ text: "oi" }),
      ),
    );
    assert.equal(response.status, 202);
    const launched = yield* Queue.take(launches);
    assert.include(launched.initialMessage?.text ?? "", "oi");

    const wrongToken = yield* client.execute(
      HttpClientRequest.post(`/api/hooks/${encodeURIComponent(task.id)}/not-the-token`),
    );
    assert.equal(wrongToken.status, 404);
  }).pipe(Effect.scoped),
);
