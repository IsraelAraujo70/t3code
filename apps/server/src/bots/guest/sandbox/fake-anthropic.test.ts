// Plain-Node integration test: it drives real processes, sockets and Docker from outside Effect.
// @effect-diagnostics globalFetch:off
import { expect, it } from "vite-plus/test";
import { createFakeAnthropic } from "./fake-anthropic.mjs";

async function withServer(run: (url: string) => Promise<void>) {
  const server = createFakeAnthropic({ chunkDelayMs: 0 });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing TCP address");
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

function post(url: string, messages: unknown[], extra = {}) {
  return fetch(`${url}/v1/messages?beta=true`, {
    method: "POST",
    body: JSON.stringify({ model: "claude-sonnet-5-5", messages, ...extra }),
  });
}

it("counts text user turns while ignoring assistants and tool results", async () => {
  await withServer(async (url) => {
    const response = await post(url, [
      { role: "user", content: "first" },
      { role: "assistant", content: "response" },
      { role: "user", content: [{ type: "tool_result", content: "result", tool_use_id: "x" }] },
      { role: "user", content: "second" },
      { role: "user", content: [{ type: "text", text: "third" }] },
    ]);
    expect(await response.json()).toMatchObject({
      content: [{ type: "text", text: "Eco #3: third" }],
      stop_reason: "end_turn",
    });
  });
});

it("strips reminders, trims and limits text, and handles no user text", async () => {
  await withServer(async (url) => {
    const reminder = { type: "text", text: "<system-reminder>hidden</system-reminder>" };
    const response = await post(url, [
      { role: "user", content: [reminder] },
      { role: "user", content: [reminder, { type: "text", text: `  ${"a".repeat(510)}  ` }] },
    ]);
    expect(await response.json()).toMatchObject({
      content: [{ text: `Eco #1: ${"a".repeat(500)}` }],
    });
    expect(await (await post(url, [{ role: "user", content: [reminder] }])).json()).toMatchObject({
      content: [{ text: "Eco #0: " }],
    });
  });
});

it("appends the image count of the last text user message", async () => {
  await withServer(async (url) => {
    for (const count of [1, 2]) {
      const response = await post(url, [
        {
          role: "user",
          content: [
            { type: "text", text: "foto" },
            ...Array.from({ length: count }, () => ({ type: "image" })),
          ],
        },
      ]);
      expect(await response.json()).toMatchObject({
        content: [{ text: `Eco #1: foto (+${count} ${count === 1 ? "imagem" : "imagens"})` }],
      });
    }
  });
});

it("streams ordered Anthropic events whose deltas reconstruct the response", async () => {
  await withServer(async (url) => {
    const response = await post(
      url,
      [{ role: "user", content: "um dois três quatro cinco seis sete oito nove" }],
      { stream: true },
    );
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    const events = (await response.text())
      .trim()
      .split("\n\n")
      .map((frame) => {
        const [event, data] = frame.split("\n");
        if (!event || !data) throw new Error("Incomplete SSE frame");
        const parsed: { type: string; delta?: { text?: string } } = JSON.parse(data.slice(6));
        expect(event).toBe(`event: ${parsed.type}`);
        return parsed;
      });
    expect(events.map((event) => event.type)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(events.flatMap((event) => event.delta?.text ?? []).join("")).toBe(
      "Eco #1: um dois três quatro cinco seis sete oito nove",
    );
  });
});

it("counts tokens, lists models, and returns structured errors", async () => {
  await withServer(async (url) => {
    const response = await fetch(`${url}/v1/messages/count_tokens`, {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "hello" }] }),
    });
    expect(await response.json()).toEqual({
      input_tokens: Math.ceil(JSON.stringify([{ role: "user", content: "hello" }]).length / 4),
    });
    expect(await (await fetch(`${url}/v1/models`)).json()).toMatchObject({
      data: [{ id: "claude-sonnet-5-5" }],
      has_more: false,
    });
    const missing = await fetch(`${url}/missing`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toMatchObject({
      type: "error",
      error: { type: "not_found_error" },
    });
    const invalid = await fetch(`${url}/v1/messages`, { method: "POST", body: "{" });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({
      type: "error",
      error: { type: "invalid_request_error" },
    });
  });
});

it("calls the scripted tools, streamed or not, and quotes back only their results", async () => {
  await withServer(async (url) => {
    const script = `fake-tools: ${JSON.stringify([{ name: "Bash", input: { command: "id" } }])}`;
    const asked = [
      { role: "user", content: [{ type: "text", text: `Do it.\n${script}` }] },
      { role: "system", content: "environment" },
    ];
    const called = (await (await post(url, asked)).json()) as {
      content: Array<{ type: string; id: string }>;
    };
    expect(called).toMatchObject({
      content: [{ type: "tool_use", name: "Bash", input: { command: "id" } }],
      stop_reason: "tool_use",
    });

    const streamed = await (await post(url, asked, { stream: true })).text();
    const deltas = streamed
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)));
    expect(deltas.find((event) => event.type === "content_block_start")).toMatchObject({
      content_block: { type: "tool_use", name: "Bash" },
    });
    expect(deltas.find((event) => event.delta?.type === "input_json_delta")).toMatchObject({
      delta: { partial_json: '{"command":"id"}' },
    });
    expect(deltas.find((event) => event.type === "message_delta")).toMatchObject({
      delta: { stop_reason: "tool_use" },
    });

    const answered = await post(url, [
      ...asked,
      { role: "assistant", content: called.content },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: called.content[0]!.id, content: "uid=1000" },
          { type: "tool_result", tool_use_id: "toolu_real", content: "not ours" },
        ],
      },
    ]);
    expect(await answered.json()).toMatchObject({
      content: [{ type: "text", text: "Resultado: uid=1000" }],
      stop_reason: "end_turn",
    });
  });
});
