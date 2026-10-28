/** OpenRouter chat completions for dictation and the kanban AI filter. The key is never logged. */
import * as Config from "effect/Config";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

export const OPENROUTER_KEY_ENV = "OPENROUTER_API_KEY";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

/** The key, or none when it is unset or blank. */
export const readOpenRouterKey: Effect.Effect<Option.Option<Redacted.Redacted>> = Config.Redacted(
  OPENROUTER_KEY_ENV,
).pipe(
  Config.option,
  Effect.map(Option.filter((key) => Redacted.value(key).trim().length > 0)),
  Effect.orElseSucceed(() => Option.none()),
);

export const readOpenRouterModel = (name: string, fallback: string): Effect.Effect<string> =>
  Config.String(name).pipe(
    Config.withDefault(fallback),
    Effect.map((model) => model.trim() || fallback),
    Effect.orElseSucceed(() => fallback),
  );

const ChatResponse = Schema.Struct({
  choices: Schema.optional(
    Schema.Array(
      Schema.Struct({
        message: Schema.optional(
          Schema.Struct({
            content: Schema.optional(
              Schema.NullOr(
                Schema.Union([
                  Schema.String,
                  Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) })),
                ]),
              ),
            ),
          }),
        ),
      }),
    ),
  ),
  error: Schema.optional(Schema.Struct({ message: Schema.optional(Schema.String) })),
});

/**
 * Sends one chat completion and returns the first choice's text, trimmed. Errors name `service`
 * ("Could not reach the <service> service.", "The <service> service failed: <detail>").
 */
export const completeOpenRouterChat = Effect.fn("OpenRouter.completeChat")(function* <E>(options: {
  readonly httpClient: HttpClient.HttpClient;
  readonly key: Redacted.Redacted;
  readonly body: unknown;
  readonly timeout: Duration.Input;
  readonly service: string;
  readonly error: (message: string, cause?: unknown) => E;
}) {
  // The deadline covers the body too: headers can arrive and the body then stall.
  const { response, decoded } = yield* HttpClientRequest.post(ENDPOINT).pipe(
    HttpClientRequest.bearerToken(Redacted.value(options.key)),
    HttpClientRequest.bodyJson(options.body),
    Effect.flatMap((request) => options.httpClient.execute(request)),
    Effect.flatMap((response) =>
      HttpClientResponse.schemaBodyJson(ChatResponse)(response).pipe(
        Effect.map((decoded) => ({ response, decoded })),
        Effect.orElseSucceed(() => ({ response, decoded: null })),
      ),
    ),
    Effect.timeout(options.timeout),
    Effect.mapError((cause) =>
      options.error(`Could not reach the ${options.service} service.`, cause),
    ),
  );
  if (response.status < 200 || response.status >= 300 || decoded === null || decoded.error) {
    const detail = decoded?.error?.message ?? `HTTP ${response.status}`;
    return yield* Effect.fail(options.error(`The ${options.service} service failed: ${detail}`));
  }
  const content = decoded.choices?.[0]?.message?.content;
  const text =
    typeof content === "string" ? content : (content ?? []).map((part) => part.text ?? "").join("");
  return text.trim();
});
