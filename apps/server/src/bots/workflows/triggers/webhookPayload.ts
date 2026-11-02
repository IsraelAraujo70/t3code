import type { Json } from "effect/Schema";
import {
  redactHeaders,
  redactQuery,
  type WebhookRequest,
} from "../../../scheduledTasks/webhookTemplate.ts";

/** JSON size limit of a webhook payload in the journal; above it body is dropped. */
const WEBHOOK_PAYLOAD_MAX_BYTES = 256 * 1024;

/** Builds trigger data with redacted credentials and a size-limited parsed body plus rendered text. */
export const webhookPayload = (request: WebhookRequest, text: string): Json => {
  let body: Json = null;
  if (request.bodyText !== "") {
    if (
      (request.headers["content-type"] ?? "")
        .toLowerCase()
        .includes("application/x-www-form-urlencoded")
    ) {
      body = Object.fromEntries(new URLSearchParams(request.bodyText));
    } else {
      try {
        body = JSON.parse(request.bodyText) as Json;
      } catch {
        body = request.bodyText;
      }
    }
  }
  const payload = {
    method: request.method,
    path: request.path,
    query: Object.fromEntries(new URLSearchParams(redactQuery(request.query))),
    headers: redactHeaders(request.headers),
    body,
    text,
  };
  return JSON.stringify(payload).length > WEBHOOK_PAYLOAD_MAX_BYTES
    ? {
        ...payload,
        body: null,
        bodyBytes: new TextEncoder().encode(request.bodyText).length,
        bodyTruncated: true,
      }
    : payload;
};
