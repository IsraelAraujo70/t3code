/**
 * Guest rows in `bots.sqlite`: guests and the hash of their current token, which bots each guest
 * owns, and the phones that get a guest's pushes. The store keeps rows only; GuestService owns
 * every rule about them (who may read or send what).
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { BotId, BotsError, GuestId } from "@t3tools/contracts";

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
     * Inserts the device, or refreshes the label and updatedAt of this guest's own token, keeping
     * its createdAt. A token another guest registered stays theirs, so knowing a phone's token
     * never redirects its pushes.
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

const GuestRow = Schema.Struct({
  id: GuestId,
  name: Schema.String,
  tokenHash: Schema.NullOr(Schema.String),
  tokenCreatedAt: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
const AssignmentRow = Schema.Struct({ botId: BotId, guestId: GuestId });
const PushDeviceRow = Schema.Struct({
  token: Schema.String,
  guestId: GuestId,
  label: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});
const decodeGuests = Schema.decodeUnknownEffect(Schema.Array(GuestRow));
const decodeAssignments = Schema.decodeUnknownEffect(Schema.Array(AssignmentRow));
const decodePushDevices = Schema.decodeUnknownEffect(Schema.Array(PushDeviceRow));
const failWith = (message: string) => (cause: unknown) => new BotsError({ message, cause });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const selectGuests = sql`
    SELECT id, name, token_hash AS "tokenHash", token_created_at AS "tokenCreatedAt",
      created_at AS "createdAt", updated_at AS "updatedAt" FROM guests
  `;
  const selectAssignments = sql`SELECT bot_id AS "botId", guest_id AS "guestId" FROM guest_bots`;

  return GuestStore.of({
    listGuests: sql`${selectGuests} ORDER BY created_at, id`.pipe(
      Effect.flatMap(decodeGuests),
      Effect.mapError(failWith("Could not read guests from bots.sqlite")),
    ),
    getGuest: (id) =>
      sql`${selectGuests} WHERE id = ${id}`.pipe(
        Effect.flatMap(decodeGuests),
        Effect.map((rows) => Option.fromNullishOr(rows[0])),
        Effect.mapError(failWith(`Could not read guest ${id} from bots.sqlite`)),
      ),
    getGuestByTokenHash: (tokenHash) =>
      sql`${selectGuests} WHERE token_hash IS NOT NULL AND token_hash = ${tokenHash}`.pipe(
        Effect.flatMap(decodeGuests),
        Effect.map((rows) => Option.fromNullishOr(rows[0])),
        Effect.mapError(failWith("Could not look up the guest token")),
      ),
    insertGuest: (guest) =>
      sql`
        INSERT INTO guests (id, name, token_hash, token_created_at, created_at, updated_at)
        VALUES (${guest.id}, ${guest.name}, ${guest.tokenHash}, ${guest.tokenCreatedAt},
          ${guest.createdAt}, ${guest.updatedAt})
      `.pipe(Effect.asVoid, Effect.mapError(failWith(`Could not insert guest ${guest.id}`))),
    setTokenHash: (id, tokenHash, at) =>
      sql`
        UPDATE guests SET token_hash = ${tokenHash},
          token_created_at = ${tokenHash === null ? null : at}, updated_at = ${at}
        WHERE id = ${id} RETURNING id
      `.pipe(
        Effect.mapError(failWith(`Could not update the token for guest ${id}`)),
        Effect.flatMap((rows) =>
          rows.length === 0
            ? Effect.fail(new BotsError({ message: `Guest ${id} does not exist` }))
            : Effect.void,
        ),
      ),
    deleteGuest: (id) =>
      sql`DELETE FROM guests WHERE id = ${id}`.pipe(
        Effect.asVoid,
        Effect.mapError(failWith(`Could not delete guest ${id}`)),
      ),
    listGuestBotIds: (guestId) =>
      sql`${selectAssignments} WHERE guest_id = ${guestId} ORDER BY created_at, bot_id`.pipe(
        Effect.flatMap(decodeAssignments),
        Effect.map((rows) => rows.map((row) => row.botId)),
        Effect.mapError(failWith(`Could not read bots for guest ${guestId}`)),
      ),
    listAssignments: sql`${selectAssignments} ORDER BY bot_id`.pipe(
      Effect.flatMap(decodeAssignments),
      Effect.map((rows) => new Map(rows.map((row) => [row.botId, row.guestId]))),
      Effect.mapError(failWith("Could not read guest bot assignments")),
    ),
    guestOfBot: (botId) =>
      sql`${selectAssignments} WHERE bot_id = ${botId}`.pipe(
        Effect.flatMap(decodeAssignments),
        Effect.map((rows) => Option.fromNullishOr(rows[0]?.guestId)),
        Effect.mapError(failWith(`Could not read the guest for bot ${botId}`)),
      ),
    assignBot: (guestId, botId, at) =>
      sql`
        INSERT INTO guest_bots (bot_id, guest_id, created_at) VALUES (${botId}, ${guestId}, ${at})
        ON CONFLICT (bot_id) DO UPDATE SET guest_id = excluded.guest_id
        WHERE guest_bots.guest_id = excluded.guest_id
        RETURNING bot_id
      `.pipe(
        Effect.mapError(failWith(`Could not assign bot ${botId} to guest ${guestId}`)),
        Effect.flatMap((rows) =>
          rows.length === 0
            ? Effect.fail(
                new BotsError({ message: `Bot ${botId} already belongs to another guest` }),
              )
            : Effect.void,
        ),
      ),
    unassignBot: (botId) =>
      sql`DELETE FROM guest_bots WHERE bot_id = ${botId}`.pipe(
        Effect.asVoid,
        Effect.mapError(failWith(`Could not unassign bot ${botId}`)),
      ),
    upsertPushDevice: (device) =>
      sql`
        INSERT INTO guest_push_devices (token, guest_id, label, created_at, updated_at)
        VALUES (${device.token}, ${device.guestId}, ${device.label}, ${device.createdAt}, ${device.updatedAt})
        ON CONFLICT (token) DO UPDATE SET label = excluded.label, updated_at = excluded.updated_at
        WHERE guest_push_devices.guest_id = excluded.guest_id
      `.pipe(Effect.asVoid, Effect.mapError(failWith("Could not register the guest push device"))),
    deletePushDevice: (guestId, token) =>
      sql`
        DELETE FROM guest_push_devices WHERE guest_id = ${guestId} AND token = ${token}
      `.pipe(
        Effect.asVoid,
        Effect.mapError(failWith("Could not unregister the guest push device")),
      ),
    listPushDevices: (guestId) =>
      sql`
        SELECT token, guest_id AS "guestId", label, created_at AS "createdAt", updated_at AS "updatedAt"
        FROM guest_push_devices WHERE guest_id = ${guestId} ORDER BY created_at, token
      `.pipe(
        Effect.flatMap(decodePushDevices),
        Effect.mapError(failWith("Could not read guest push devices from bots.sqlite")),
      ),
  });
});

/** `bots.sqlite` in the server state directory. */
export const layer = Layer.effect(GuestStore, make).pipe(Layer.provide(BotsDb.layer));

/** Over an existing bots database (tests that also need BotsStore on the same file). */
export const layerFromDb = Layer.effect(GuestStore, make);

/** Over a migrated in-memory database, for tests. */
export const layerMemory = layerFromDb.pipe(Layer.provide(BotsDb.layerMemory));
