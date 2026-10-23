import * as NodeHttp from "node:http";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeURL from "node:url";

function echo(messages) {
  let count = 0;
  let text = "";
  let images = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role !== "user") continue;
    const blocks =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : Array.isArray(message.content)
          ? message.content
          : [];
    const texts = blocks.filter(
      (block) =>
        block?.type === "text" &&
        typeof block.text === "string" &&
        !block.text.startsWith("<system-reminder>"),
    );
    if (texts.length === 0) continue;
    count++;
    text = texts
      .map((block) => block.text)
      .join("\n")
      .trim()
      .slice(0, 500);
    images = blocks.filter((block) => block?.type === "image").length;
  }
  return `Eco #${count}: ${text}${images ? ` (+${images} ${images === 1 ? "imagem" : "imagens"})` : ""}`;
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function error(response, status, type, message) {
  json(response, status, { type: "error", error: { type, message } });
}

/** Creates a standalone echo API; conversation history is supplied by the caller. */
export function createFakeAnthropic({ chunkDelayMs = 25 } = {}) {
  let counter = 0;
  return NodeHttp.createServer(async (request, response) => {
    const path = new URL(request.url, "http://localhost").pathname;
    if (process.env.FAKE_ANTHROPIC_DEBUG) console.error(request.method, path);
    if (request.method === "GET" && path === "/v1/models") {
      const id = "claude-sonnet-5-5";
      json(response, 200, {
        data: [
          {
            type: "model",
            id,
            display_name: "Claude Sonnet 5.5",
            created_at: "2026-01-01T00:00:00Z",
          },
        ],
        has_more: false,
        first_id: id,
        last_id: id,
      });
      return;
    }
    if (
      request.method !== "POST" ||
      !["/v1/messages", "/v1/messages/count_tokens"].includes(path)
    ) {
      error(response, 404, "not_found_error", `Unknown route: ${path}`);
      return;
    }
    let body;
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (body === null || typeof body !== "object" || Array.isArray(body))
        throw new Error("Expected object");
    } catch {
      error(response, 400, "invalid_request_error", "Expected a JSON object");
      return;
    }
    const input_tokens = Math.ceil(JSON.stringify(body.messages ?? []).length / 4);
    if (path === "/v1/messages/count_tokens") {
      json(response, 200, { input_tokens });
      return;
    }
    const text = echo(body.messages);
    const output_tokens = Math.ceil(text.length / 4);
    const message = {
      id: `msg_fake_${++counter}`,
      type: "message",
      role: "assistant",
      model: body.model,
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: {
        input_tokens,
        output_tokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    };
    if (body.stream !== true) {
      json(response, 200, message);
      return;
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const event = (type, data) =>
      response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    event("message_start", {
      message: {
        ...message,
        content: [],
        stop_reason: null,
        usage: { ...message.usage, output_tokens: 1 },
      },
    });
    event("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
    const chunks = text.match(/(?:\S+\s*){1,4}/g) ?? [text];
    for (let index = 0; index < chunks.length; index++) {
      if (index > 0) await NodeTimersPromises.setTimeout(chunkDelayMs);
      if (response.destroyed) return;
      event("content_block_delta", {
        index: 0,
        delta: { type: "text_delta", text: chunks[index] },
      });
    }
    event("content_block_stop", { index: 0 });
    event("message_delta", {
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens },
    });
    event("message_stop", {});
    response.end();
  });
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  createFakeAnthropic().listen(Number(process.env.FAKE_ANTHROPIC_PORT || 8099), "127.0.0.1");
}
