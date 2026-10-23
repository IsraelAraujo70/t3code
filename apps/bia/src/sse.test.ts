import { describe, expect, it } from "vite-plus/test";

import { parseStreamEvent, readSseEvents } from "./sse";

/** Feeds `chunks` the way XHR progress does: the text only grows, the cursor carries over. */
function feed(chunks: readonly string[]): string[][] {
  let text = "";
  let cursor = 0;
  return chunks.map((chunk) => {
    text += chunk;
    const read = readSseEvents(text, cursor);
    cursor = read.cursor;
    return [...read.data];
  });
}

describe("readSseEvents", () => {
  it("waits for the blank line of an event split across chunks", () => {
    expect(feed(['data: {"type":"wor', 'king","working":true}', "\n", "\n"])).toEqual([
      [],
      [],
      [],
      ['{"type":"working","working":true}'],
    ]);
  });

  it("reads several events from one chunk and keeps a partial trailing one", () => {
    expect(feed(["data: 1\n\ndata: 2\n\ndata: 3", "\n\n"])).toEqual([["1", "2"], ["3"]]);
  });

  it("skips keep-alive comments", () => {
    expect(feed([": ping\n\n", ": ping\n\ndata: x\n\n"])).toEqual([[], ["x"]]);
  });

  it("joins multi-line data and accepts CRLF and no space after the colon", () => {
    expect(feed(["data:a\r\ndata: b\r\n\r\n"])).toEqual([["a\nb"]]);
  });
});

describe("parseStreamEvent", () => {
  it("parses message and working events", () => {
    const message = {
      id: "m1",
      role: "assistant",
      text: "Oi",
      attachments: [{ id: "a1", name: "f.png", mimeType: "image/png" }],
      streaming: true,
      createdAt: "2026-10-23T10:00:00.000Z",
    };
    expect(parseStreamEvent(JSON.stringify({ type: "message", message }))).toEqual({
      type: "message",
      message,
    });
    expect(parseStreamEvent('{"type":"working","working":false}')).toEqual({
      type: "working",
      working: false,
    });
  });

  it("drops anything else", () => {
    expect(parseStreamEvent("not json")).toBeNull();
    expect(parseStreamEvent('{"type":"working"}')).toBeNull();
    expect(parseStreamEvent('{"type":"message","message":{"id":"m1"}}')).toBeNull();
    expect(parseStreamEvent('{"type":"other"}')).toBeNull();
  });
});
