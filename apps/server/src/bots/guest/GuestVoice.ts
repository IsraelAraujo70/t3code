/**
 * Voice for guests: the bots host's VoiceSessions on a guest's own bot, through the guest listener.
 * Realtime runs here, on the host's ChatGPT login; the guest app only gets the SDP answer and the
 * bot's activity, and no credential leaves the host.
 *
 * Invariants:
 * - The thread is the owned bot's conversation, resolved by GuestService. A guest names no thread.
 * - What the guest says goes through GuestService's send rules: as the guest, defused, on the bot's
 *   model, refused outside the sandbox.
 * - `ready` and `report` act only on the guest's own sessions; any other id answers 404.
 * - A guest has one session at a time: a new one ends the previous, so a phone cannot pile up
 *   app-servers.
 * - A session ends within seconds of a revoked token or of the bot being given to someone else.
 */
import {
  BotsError,
  type GuestId,
  type GuestVoiceEvent,
  type GuestVoiceInput,
  type VoiceReportInput,
  type VoiceSessionEvent,
  type VoiceSessionId,
  type VoiceSessionRef,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as VoiceSession from "../voice/VoiceSession.ts";
import { GuestApiError, GuestService } from "./GuestService.ts";
import type { GuestRecord } from "./GuestStore.ts";

export class GuestVoice extends Context.Service<
  GuestVoice,
  {
    /** Checks the bot before the stream starts, so a refused bot never opens a session. */
    readonly session: (
      guest: GuestRecord,
      botId: string,
      input: GuestVoiceInput,
    ) => Effect.Effect<Stream.Stream<GuestVoiceEvent>, GuestApiError>;
    readonly ready: (
      guest: GuestRecord,
      input: VoiceSessionRef,
    ) => Effect.Effect<VoiceSessionRef, GuestApiError>;
    readonly report: (
      guest: GuestRecord,
      input: VoiceReportInput,
    ) => Effect.Effect<void, GuestApiError>;
  }
>()("t3/bots/guest/GuestVoice") {}

/** Shown when the voice fails for a reason the guest cannot act on. */
export const VOICE_FAILED_MESSAGE = "A voz parou de funcionar. Tente de novo.";

/**
 * How long an ended session still takes reports: the client sends its last diagnostics (on Android
 * the only stats sample) after its stream ends.
 */
export const REPORT_GRACE_MS = 60_000;

const sessionNotFound = () =>
  new GuestApiError({ status: 404, message: "Esta conversa por voz não existe mais." });

type GuestVoiceSessionEvent = Exclude<VoiceSessionEvent, { readonly type: "voice-changed" }>;

const make = Effect.gen(function* () {
  const guests = yield* GuestService;
  const voice = yield* VoiceSession.VoiceSessions;
  /** Sessions that answered, with their guest and, once ended, when. */
  const owners = new Map<VoiceSessionId, { guestId: GuestId; endedAt: number | null }>();
  /** Ends each guest's current session. */
  const current = new Map<GuestId, Deferred.Deferred<void>>();

  /** The session's owner entry when it belongs to `guest`; ended ones expire after the grace. */
  const ownedSession = (guest: GuestRecord, sessionId: VoiceSessionId) =>
    Effect.map(Clock.currentTimeMillis, (now) => {
      for (const [id, owner] of owners)
        if (owner.endedAt !== null && now - owner.endedAt > REPORT_GRACE_MS) owners.delete(id);
      const owner = owners.get(sessionId);
      return owner?.guestId === guest.id ? owner : null;
    });

  const session = Effect.fn("GuestVoice.session")(function* (
    guest: GuestRecord,
    botId: string,
    input: GuestVoiceInput,
  ) {
    const conversation = yield* guests.voiceConversation(guest, botId);
    return Stream.unwrap(
      Effect.gen(function* () {
        const replaced = yield* Deferred.make<void>();
        const previous = current.get(guest.id);
        current.set(guest.id, replaced);
        if (previous !== undefined) yield* Deferred.succeed(previous, undefined);
        let sessionId: VoiceSessionId | null = null;
        // A send the guest is refused ends the session with the reason, already in Portuguese.
        let refused: GuestApiError | null = null;
        const post = (text: string) =>
          conversation.post(text).pipe(
            Effect.tapError((error) =>
              Effect.sync(() => {
                refused = error;
              }),
            ),
            Effect.mapError((error) => new BotsError({ message: error.message })),
          );
        const events = voice.session(
          { threadId: conversation.threadId, mode: input.mode, sdp: input.sdp },
          { post },
        );
        return events.pipe(
          // Never sent: a guest session does not ask for live voice changes.
          Stream.filter((event): event is GuestVoiceSessionEvent => event.type !== "voice-changed"),
          Stream.tap((event) =>
            Effect.sync(() => {
              if (event.type !== "answer") return;
              sessionId = event.sessionId;
              owners.set(event.sessionId, { guestId: guest.id, endedAt: null });
            }),
          ),
          Stream.map((event): GuestVoiceEvent => event),
          Stream.catch((error) =>
            Stream.fromEffect(
              Effect.logWarning("A guest's voice session failed", {
                guestId: guest.id,
                error: error.message,
              }),
            ).pipe(
              Stream.as<GuestVoiceEvent>({
                type: "error",
                message: refused?.message ?? VOICE_FAILED_MESSAGE,
              }),
            ),
          ),
          Stream.interruptWhen(Deferred.await(replaced)),
          Stream.interruptWhen(conversation.revoked),
          Stream.ensuring(
            Effect.gen(function* () {
              const endedAt = yield* Clock.currentTimeMillis;
              const owner = sessionId === null ? undefined : owners.get(sessionId);
              if (owner !== undefined) owner.endedAt = endedAt;
              if (current.get(guest.id) === replaced) current.delete(guest.id);
            }),
          ),
        );
      }),
    );
  });

  const ready = Effect.fn("GuestVoice.ready")(function* (
    guest: GuestRecord,
    input: VoiceSessionRef,
  ) {
    const owner = yield* ownedSession(guest, input.sessionId);
    if (owner === null || owner.endedAt !== null) return yield* sessionNotFound();
    return yield* voice
      .ready(input)
      .pipe(
        Effect.mapError(
          (cause) => new GuestApiError({ status: 409, message: VOICE_FAILED_MESSAGE, cause }),
        ),
      );
  });

  const report = Effect.fn("GuestVoice.report")(function* (
    guest: GuestRecord,
    input: VoiceReportInput,
  ) {
    if ((yield* ownedSession(guest, input.sessionId)) === null) return yield* sessionNotFound();
    yield* voice.report(input);
  });

  return GuestVoice.of({ session, ready, report });
});

/** Needs GuestService and VoiceSessions. */
export const layer = Layer.effect(GuestVoice, make);
