/**
 * A public origin for webhook tasks without T3 Connect. `T3CODE_WEBHOOK_PUBLIC_BASE_URL` names an
 * https origin (say a Tailscale Funnel) that forwards `/api/hooks/*` to this server, which already
 * answers direct deliveries there. Webhook tasks then get `<base>/api/hooks/<taskId>/<token>` as
 * their URL. The T3 Connect relay URL still wins when the environment has one.
 */
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

import { WEBHOOK_ROUTE_PREFIX } from "../scheduledTasks/ScheduledTaskService.ts";

export const WEBHOOK_PUBLIC_BASE_URL_ENV = "T3CODE_WEBHOOK_PUBLIC_BASE_URL";

interface WebhookOrigin {
  readonly relayHookBaseUrl: string | null;
}

/** The base when it is an https URL without a trailing slash, query, hash or credentials. */
export function parseWebhookPublicBaseUrl(raw: string): string | null {
  if (!URL.canParse(raw)) return null;
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return null;
  if (url.pathname !== "/" && url.pathname.endsWith("/")) return null;
  const canonical = url.pathname === "/" ? url.origin : `${url.origin}${url.pathname}`;
  return canonical === raw && url.search === "" && url.hash === "" ? raw : null;
}

/** The hook base for task URLs: the relay's when it has one, else the public base's hook route. */
function webhookHookBaseUrl(input: {
  readonly relayHookBaseUrl: string | null;
  readonly publicBaseUrl: string | null;
}): string | null {
  if (input.relayHookBaseUrl !== null) return input.relayHookBaseUrl;
  return input.publicBaseUrl === null ? null : `${input.publicBaseUrl}${WEBHOOK_ROUTE_PREFIX}`;
}

/** Reads the env once; an invalid value is ignored with a warning. */
export const readWebhookPublicBaseUrl = Effect.gen(function* () {
  const raw = yield* Config.String(WEBHOOK_PUBLIC_BASE_URL_ENV).pipe(
    Config.withDefault(""),
    Effect.orElseSucceed(() => ""),
  );
  if (raw === "") return null;
  const base = parseWebhookPublicBaseUrl(raw);
  if (base === null) {
    yield* Effect.logWarning(
      `${WEBHOOK_PUBLIC_BASE_URL_ENV} ignored: it must be an https URL without a trailing slash`,
    );
  }
  return base;
});

/** Wraps the relay origin reader so webhook tasks fall back to the public base. */
export const withWebhookPublicBase = Effect.fn("WebhookPublicBase.withWebhookPublicBase")(
  function* (readRelayOrigin: Effect.Effect<WebhookOrigin>) {
    const publicBaseUrl = yield* readWebhookPublicBaseUrl;
    return readRelayOrigin.pipe(
      Effect.map(({ relayHookBaseUrl }): WebhookOrigin => ({
        relayHookBaseUrl: webhookHookBaseUrl({ relayHookBaseUrl, publicBaseUrl }),
      })),
    );
  },
);
