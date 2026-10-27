import type { GuestBotStreamEvent } from "@t3tools/contracts";

import { authorizationHeader, eventsUrl, type BotId } from "./api";
import type { Pairing } from "./pairing";
import { parseStreamEvent, readSseEvents } from "./sse";

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 15_000;
/** A phone that changes networks can leave a socket open that never errors; keep-alives stop. */
const IDLE_TIMEOUT_MS = 75_000;
const RECYCLE_AFTER_CHARS = 2_000_000;

export interface BotStream {
  /** Drops the current connection and connects again now, e.g. when the app comes back. */
  readonly reconnectNow: () => void;
  readonly close: () => void;
}

/**
 * Follows one bot's live events. React Native's fetch cannot stream a body, so this reads the
 * growing `responseText` of an XMLHttpRequest. Every time a connection opens, `onOpen` runs so
 * the caller can reload history for anything missed while it was down.
 */
export function openBotStream(options: {
  readonly pairing: Pairing;
  readonly botId: BotId;
  readonly onEvent: (event: GuestBotStreamEvent) => void;
  readonly onOpen: () => void;
  readonly onUnauthorized: () => void;
}): BotStream {
  let xhr: XMLHttpRequest | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let backoff = MIN_BACKOFF_MS;
  let closed = false;

  const clearTimers = () => {
    if (retryTimer !== null) clearTimeout(retryTimer);
    if (idleTimer !== null) clearTimeout(idleTimer);
    retryTimer = null;
    idleTimer = null;
  };

  /** Handlers of a dropped request see `xhr !== request` and ignore its abort events. */
  const drop = () => {
    const current = xhr;
    xhr = null;
    current?.abort();
  };

  const scheduleReconnect = () => {
    drop();
    clearTimers();
    if (closed) return;
    retryTimer = setTimeout(connect, backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  };

  const touch = () => {
    if (idleTimer !== null) clearTimeout(idleTimer);
    idleTimer = setTimeout(scheduleReconnect, IDLE_TIMEOUT_MS);
  };

  function connect() {
    clearTimers();
    if (closed) return;
    const request = new XMLHttpRequest();
    xhr = request;
    let cursor = 0;
    let opened = false;

    request.open("GET", eventsUrl(options.pairing, options.botId));
    request.setRequestHeader("Accept", "text/event-stream");
    request.setRequestHeader("Authorization", authorizationHeader(options.pairing));
    request.setRequestHeader("Cache-Control", "no-cache");

    const live = () => xhr === request;

    request.addEventListener("readystatechange", () => {
      if (!live() || opened || request.readyState < XMLHttpRequest.HEADERS_RECEIVED) return;
      if (request.status === 401) {
        closed = true;
        drop();
        clearTimers();
        options.onUnauthorized();
        return;
      }
      if (request.status !== 200) return;
      opened = true;
      backoff = MIN_BACKOFF_MS;
      touch();
      options.onOpen();
    });
    // A progress listener added before send is what makes React Native deliver the body
    // incrementally instead of all at once when the response ends.
    request.addEventListener("progress", () => {
      if (!live() || !opened) return;
      touch();
      const read = readSseEvents(request.responseText, cursor);
      cursor = read.cursor;
      for (const data of read.data) {
        const event = parseStreamEvent(data);
        if (event !== null) options.onEvent(event);
      }
      // Every update resends a reply's whole text, so a long-lived responseText only grows.
      // A fresh connection (plus the history reload it triggers) caps that memory.
      if (cursor > RECYCLE_AFTER_CHARS) {
        drop();
        connect();
      }
    });
    request.addEventListener("loadend", () => {
      if (live()) scheduleReconnect();
    });
    touch();
    request.send();
  }

  connect();

  return {
    reconnectNow: () => {
      if (closed) return;
      drop();
      backoff = MIN_BACKOFF_MS;
      connect();
    },
    close: () => {
      closed = true;
      drop();
      clearTimers();
    },
  };
}
