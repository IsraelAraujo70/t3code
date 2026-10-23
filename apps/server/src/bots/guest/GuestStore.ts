/**
 * Guest rows in `bots.sqlite`: guests and the hash of their current token, which bots each guest
 * owns, and the phones that get a guest's pushes. The store keeps rows only; GuestService owns
 * every rule about them (who may read or send what).
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Option from "effect/Option";

import type { BotId, BotsError, GuestId } from "@t3tools/contracts";

import * as BotsDb from "../BotsDb.ts";

export interface GuestRecord {
  readonly id: GuestId;
  readonly name: string;
  /** sha256 hex of the current token; null when no token is valid (never minted, or revoked). */
  readonly tokenHash: string | null;
  readonly tokenCreatedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** A phone that gets a push when one of the guest's bots replies or waits on them. */
export interface GuestPushDevice {
  /** The device's FCM registration token. */
  readonly token: string;
  readonly guestId: GuestId;
  readonly label: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class GuestStore extends Context.Service<
  GuestStore,
  {
    /** Ordered by createdAt, then id. */
    readonly listGuests: Effect.Effect<ReadonlyArray<GuestRecord>, BotsError>;
    readonly getGuest: (id: GuestId) => Effect.Effect<Option.Option<GuestRecord>, BotsError>;
    /** The guest whose current token hashes to `tokenHash`; none for revoked or unknown hashes. */
    readonly getGuestByTokenHash: (
      tokenHash: string,
    ) => Effect.Effect<Option.Option<GuestRecord>, BotsError>;
    /** Fails with BotsError when the id exists. */
    readonly insertGuest: (guest: GuestRecord) => Effect.Effect<void, BotsError>;
    /**
     * Replaces the token hash (null revokes) and sets tokenCreatedAt and updatedAt to `at`
     * (tokenCreatedAt null when revoking). Fails when the guest does not exist.
     */
    readonly setTokenHash: (
      id: GuestId,
      tokenHash: string | null,
      at: string,
    ) => Effect.Effect<void, BotsError>;
    /** Deletes the guest, its bot assignments and its push devices. Missing ids succeed. */
    readonly deleteGuest: (id: GuestId) => Effect.Effect<void, BotsError>;
    /** The guest's bots, in assignment order (createdAt, then bot id). */
    readonly listGuestBotIds: (guestId: GuestId) => Effect.Effect<ReadonlyArray<BotId>, BotsError>;
    /** Every guest-owned bot with its guest. */
    readonly listAssignments: Effect.Effect<ReadonlyMap<BotId, GuestId>, BotsError>;
    readonly guestOfBot: (botId: BotId) => Effect.Effect<Option.Option<GuestId>, BotsError>;
    /**
     * Gives the bot to the guest. Idempotent for the same guest. Fails with BotsError when the bot
     * belongs to another guest, or when the bot or the guest does not exist. A deleted bot drops
     * its assignment by cascade.
     */
    readonly assignBot: (
      guestId: GuestId,
      botId: BotId,
      at: string,
    ) => Effect.Effect<void, BotsError>;
    /** Missing assignments succeed. */
    readonly unassignBot: (botId: BotId) => Effect.Effect<void, BotsError>;
    /**
     * Inserts the device, or moves an existing token to this guest and refreshes its label and
     * updatedAt, keeping its createdAt.
     */
    readonly upsertPushDevice: (device: GuestPushDevice) => Effect.Effect<void, BotsError>;
    /** Deletes the token only when it belongs to this guest; anything else succeeds silently. */
    readonly deletePushDevice: (guestId: GuestId, token: string) => Effect.Effect<void, BotsError>;
    /** Oldest first. */
    readonly listPushDevices: (
      guestId: GuestId,
    ) => Effect.Effect<ReadonlyArray<GuestPushDevice>, BotsError>;
  }
>()("t3/bots/guest/GuestStore") {}

const make: Effect.Effect<GuestStore["Service"], never, never> = Effect.die(
  "GuestStore is not implemented yet",
);

/** `bots.sqlite` in the server state directory. */
export const layer = Layer.effect(GuestStore, make).pipe(Layer.provide(BotsDb.layer));

/** Over an existing bots database (tests that also need BotsStore on the same file). */
export const layerFromDb = Layer.effect(GuestStore, make);
