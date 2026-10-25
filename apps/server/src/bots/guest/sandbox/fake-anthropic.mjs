import * as NodeHttp from "node:http";
import * as NodeTimersPromises from "node:timers/promises";
import * as NodeURL from "node:url";

function echo(messages) {
  let count = 0;
  let text = "";
  let images = 0;
  // The CLI may send a turn's images and its text as separate user messages.
  let turnImages = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    if (message?.role === "assistant") turnImages = 0;
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
    turnImages += blocks.filter((block) => block?.type === "image").length;
    if (texts.length === 0) continue;
    count++;
    text = texts
      .map((block) => block.text)
      .join("\n")
      .trim()
      .slice(0, 500);
    images = turnImages;
  }
  return `Eco #${count}: ${text}${images ? ` (+${images} ${images === 1 ? "imagem" : "imagens"})` : ""}`;
}

const SCRIPT_PREFIX = "fake-tools:";
const FAKE_TOOL_ID = "toolu_fake_";

/**
 * Scripted tool calls, so a test can drive the real CLI through tools (a subagent, a command).
 * Looking back from the last message to the assistant's latest reply: results of the tools it
 * called are quoted back; otherwise a user line `fake-tools: [{"name","input"}…]` makes the reply call those
 * tools.
 */
function scripted(messages) {
  const pending = [];
  for (const message of Array.isArray(messages) ? messages.toReversed() : []) {
    // The CLI may end the list with a system message after the user's.
    if (message?.role === "system") continue;
    if (message?.role !== "user") break;
    const content = message.content;
    pending.unshift(...(typeof content === "string" ? [{ type: "text", text: content }] : content));
  }
  const results = pending.filter(
    (block) => block?.type === "tool_result" && String(block.tool_use_id).startsWith(FAKE_TOOL_ID),
  );
  if (results.length > 0) {
    const quoted = results.map((block) =>
      typeof block.content === "string"
        ? block.content
        : (Array.isArray(block.content) ? block.content : [])
            .map((part) => (typeof part?.text === "string" ? part.text : ""))
            .join("\n"),
    );
    return [{ type: "text", text: `Resultado: ${quoted.join("\n---\n").slice(0, 4000)}` }];
  }
  for (const block of pending.toReversed()) {
    if (block?.type !== "text" || typeof block.text !== "string") continue;
    const line = block.text.split("\n").find((each) => each.trim().startsWith(SCRIPT_PREFIX));
    if (line === undefined) continue;
    const calls = JSON.parse(line.trim().slice(SCRIPT_PREFIX.length));
    return calls.map((call, index) => ({
      type: "tool_use",
      id: `${FAKE_TOOL_ID}${Date.now()}_${index}`,
      name: call.name,
      input: call.input,
    }));
  }
  return null;
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function error(response, status, type, message) {
  json(response, status, { type: "error", error: { type, message } });
}

/** Creates a standalone echo API; conversation history is supplied by the caller. */
export function createFakeAnthropic({ chunkDelayMs = 25, expectKey, expectBearer } = {}) {
  let counter = 0;
  return NodeHttp.createServer(async (request, response) => {
    const path = new URL(request.url, "http://localhost").pathname;
    if (process.env.FAKE_ANTHROPIC_DEBUG) console.error(request.method, path);
    // Behind the guest's API forwarder, only the key the forwarder injects is accepted.
    if (expectKey !== undefined && request.headers["x-api-key"] !== expectKey) {
      error(response, 401, "authentication_error", "invalid x-api-key");
      return;
    }
    // Like the real API for a subscription token: the bearer and the OAuth beta, and no API key.
    if (
      expectBearer !== undefined &&
      (request.headers.authorization !== `Bearer ${expectBearer}` ||
        request.headers["x-api-key"] !== undefined ||
        !String(request.headers["anthropic-beta"] ?? "")
          .split(",")
          .includes("oauth-2025-04-20"))
    ) {
      error(response, 401, "authentication_error", "invalid bearer token");
      return;
    }
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
    let content;
    try {
      content = scripted(body.messages) ?? [{ type: "text", text: echo(body.messages) }];
    } catch {
      error(response, 400, "invalid_request_error", `Unreadable ${SCRIPT_PREFIX} line`);
      return;
    }
    const stopReason = content.some((block) => block.type === "tool_use") ? "tool_use" : "end_turn";
    const output_tokens = Math.ceil(JSON.stringify(content).length / 4);
    const message = {
      id: `msg_fake_${++counter}`,
      type: "message",
      role: "assistant",
      model: body.model,
      content,
      stop_reason: stopReason,
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
    for (const [index, block] of content.entries()) {
      if (block.type === "tool_use") {
        event("content_block_start", { index, content_block: { ...block, input: {} } });
        event("content_block_delta", {
          index,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input) },
        });
        event("content_block_stop", { index });
        continue;
      }
      event("content_block_start", { index, content_block: { type: "text", text: "" } });
      const chunks = block.text.match(/(?:\S+\s*){1,4}/g) ?? [block.text];
      for (let chunk = 0; chunk < chunks.length; chunk++) {
        if (chunk > 0) await NodeTimersPromises.setTimeout(chunkDelayMs);
        if (response.destroyed) return;
        event("content_block_delta", {
          index,
          delta: { type: "text_delta", text: chunks[chunk] },
        });
      }
      event("content_block_stop", { index });
    }
    event("message_delta", {
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens },
    });
    event("message_stop", {});
    response.end();
  });
}

if (process.argv[1] && import.meta.url === NodeURL.pathToFileURL(process.argv[1]).href) {
  // Slow enough in the sandbox that a client visibly receives the reply in pieces.
  createFakeAnthropic({
    chunkDelayMs: Number(process.env.FAKE_ANTHROPIC_CHUNK_DELAY_MS || 120),
  }).listen(Number(process.env.FAKE_ANTHROPIC_PORT || 8099), "127.0.0.1");
}
