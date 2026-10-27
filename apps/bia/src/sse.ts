import type { GuestMessage, GuestBotStreamEvent } from "@t3tools/contracts";

/**
 * Reads the complete SSE events in `text` from `cursor` on. The XHR's `responseText` only grows,
 * so the caller keeps the returned cursor and passes the whole text again on the next progress.
 * A trailing event without its blank line stays unread until the rest arrives.
 */
export function readSseEvents(
  text: string,
  cursor: number,
): { readonly data: readonly string[]; readonly cursor: number } {
  const data: string[] = [];
  let position = cursor;
  for (;;) {
    const boundary = /\r?\n\r?\n/g;
    boundary.lastIndex = position;
    const match = boundary.exec(text);
    if (match === null) break;
    const block = text.slice(position, match.index);
    position = match.index + match[0].length;

    const lines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("data:")) lines.push(line.slice(line.startsWith("data: ") ? 6 : 5));
    }
    if (lines.length > 0) data.push(lines.join("\n"));
  }
  return { data, cursor: position };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAttachment(value: unknown): boolean {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.mimeType === "string"
  );
}

function isGuestMessage(value: unknown): value is GuestMessage {
  return (
    isObject(value) &&
    typeof value.id === "string" &&
    (value.role === "user" || value.role === "assistant") &&
    typeof value.text === "string" &&
    Array.isArray(value.attachments) &&
    value.attachments.every(isAttachment) &&
    typeof value.streaming === "boolean" &&
    typeof value.createdAt === "string"
  );
}

/** One `data:` payload as a stream event, or null when it is not one the app understands. */
export function parseStreamEvent(data: string): GuestBotStreamEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isObject(value)) return null;
  if (value.type === "working" && typeof value.working === "boolean") {
    return { type: "working", working: value.working };
  }
  if (value.type === "message" && isGuestMessage(value.message)) {
    return { type: "message", message: value.message };
  }
  return null;
}
