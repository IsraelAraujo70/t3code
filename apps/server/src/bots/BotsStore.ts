/**
 * Rows of `bots.sqlite`: bots, their sidebar sections, their memories, the owner profile, and the
 * phones that get bot pushes. The store keeps rows only;
 * BotsService owns every rule about them (thread generations, limits, who may write what).
 *
 * The database is a separate file next to the upstream `statev2.sqlite`, with its own migration
 * ledger. Its SqlClient stays inside this layer so it never replaces the main one.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import {
  Bot,
  BotMemory,
  BotSection,
  BotsError,
  ModelSelection,
  type BotId,
  type BotMemoryId,
  type BotsArrangeInput,
  type BotSectionId,
} from "@t3tools/contracts";

import * as BotsDb from "./BotsDb.ts";

/** One atomic import: rows whose id already exists are skipped, never overwritten. */
export interface BotsImportBatch {
  readonly bots: ReadonlyArray<Bot>;
  readonly memories: ReadonlyArray<BotMemory>;
  /** Written only when the stored profile is empty at commit time. */
  readonly aboutMe: string | null;
}

/** A phone that gets a push when a bot replies or waits on the user. */
export interface BotPushDevice {
  /** The device's FCM registration token. */
  readonly token: string;
  readonly label: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export class BotsStore extends Context.Service<
  BotsStore,
  {
    /** Bots in sidebar order (position, then createdAt). */
    readonly listBots: Effect.Effect<ReadonlyArray<Bot>, BotsError>;
    readonly getBot: (id: BotId) => Effect.Effect<Option.Option<Bot>, BotsError>;
    /** Fails with BotsError when the id exists. */
    readonly insertBot: (bot: Bot) => Effect.Effect<void, BotsError>;
    /** Replaces every column of an existing bot; fails when it does not exist. */
    readonly updateBot: (bot: Bot) => Effect.Effect<void, BotsError>;
    /** Deletes the bot and, by cascade, its memories. Deleting a missing bot succeeds. */
    readonly deleteBot: (id: BotId) => Effect.Effect<void, BotsError>;
    /** Sections in sidebar order (position, then createdAt). */
    readonly listSections: Effect.Effect<ReadonlyArray<BotSection>, BotsError>;
    readonly getSection: (id: BotSectionId) => Effect.Effect<Option.Option<BotSection>, BotsError>;
    readonly insertSection: (section: BotSection) => Effect.Effect<void, BotsError>;
    /** Replaces every column of an existing section; fails when it does not exist. */
    readonly updateSection: (section: BotSection) => Effect.Effect<void, BotsError>;
    /** Deletes the section; its bots fall back to no section. Deleting a missing one succeeds. */
    readonly deleteSection: (id: BotSectionId) => Effect.Effect<void, BotsError>;
    /**
     * In one transaction, numbers sections and bots by their index in `arrangement` and moves
     * each bot into its section. The caller checks that the ids match the stored rows.
     */
    readonly arrange: (arrangement: BotsArrangeInput) => Effect.Effect<void, BotsError>;
    /** All memories, or one bot's, oldest first. */
    readonly listMemories: (botId?: BotId) => Effect.Effect<ReadonlyArray<BotMemory>, BotsError>;
    readonly getMemory: (id: BotMemoryId) => Effect.Effect<Option.Option<BotMemory>, BotsError>;
    /** Fails with BotsError when the id exists or the bot already has a memory with this text. */
    readonly insertMemory: (memory: BotMemory) => Effect.Effect<void, BotsError>;
    readonly updateMemory: (memory: BotMemory) => Effect.Effect<void, BotsError>;
    readonly deleteMemory: (id: BotMemoryId) => Effect.Effect<void, BotsError>;
    /** Empty string when never set. */
    readonly getAboutMe: Effect.Effect<string, BotsError>;
    readonly setAboutMe: (text: string) => Effect.Effect<void, BotsError>;
    readonly importBatch: (batch: BotsImportBatch) => Effect.Effect<void, BotsError>;
    /** Inserts the device, or refreshes its label and updatedAt, keeping its createdAt. */
    readonly upsertPushDevice: (device: BotPushDevice) => Effect.Effect<void, BotsError>;
    /** Deleting a missing token succeeds. */
    readonly deletePushDevice: (token: string) => Effect.Effect<void, BotsError>;
    /** Oldest first. */
    readonly listPushDevices: Effect.Effect<ReadonlyArray<BotPushDevice>, BotsError>;
  }
>()("t3/bots/BotsStore") {}

const BotRow = Schema.Struct({
  ...Bot.fields,
  model: Schema.fromJsonString(ModelSelection),
  canManageBots: Schema.BooleanFromBit,
});
const MemoryRow = Schema.Struct({ ...BotMemory.fields, enabled: Schema.BooleanFromBit });
const SectionRow = BotSection;
const AboutMeRow = Schema.Struct({ aboutMe: Schema.String });
const PushDeviceRow = Schema.Struct({
  token: Schema.String,
  label: Schema.NullOr(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.String,
});

const decodeBots = Schema.decodeUnknownEffect(Schema.Array(BotRow));
const decodeMemories = Schema.decodeUnknownEffect(Schema.Array(MemoryRow));
const decodeSections = Schema.decodeUnknownEffect(Schema.Array(SectionRow));
const decodeAboutMe = Schema.decodeUnknownEffect(Schema.Array(AboutMeRow));
const decodePushDevices = Schema.decodeUnknownEffect(Schema.Array(PushDeviceRow));
const encodeBot = Schema.encodeEffect(BotRow);
const encodeMemory = Schema.encodeEffect(MemoryRow);

const failWith = (message: string) => (cause: unknown) => new BotsError({ message, cause });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const selectBots = sql`
    SELECT
      id,
      name,
      role,
      model_json AS "model",
      home_generation AS "homeGeneration",
      section_id AS "sectionId",
      position,
      can_manage_bots AS "canManageBots",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM bots
  `;
  const selectSections = sql`
    SELECT id, name, position, created_at AS "createdAt", updated_at AS "updatedAt"
    FROM sections
  `;
  const selectMemories = sql`
    SELECT
      id,
      bot_id AS "botId",
      text,
      source,
      enabled,
      created_at AS "createdAt",
      updated_at AS "updatedAt"
    FROM memories
  `;

  const insertBotRow = (row: typeof BotRow.Encoded, onConflict: "fail" | "skip") => sql`
    INSERT INTO bots (
      id, name, role, model_json, home_generation, section_id, position, can_manage_bots,
      created_at, updated_at
    )
    VALUES (
      ${row.id}, ${row.name}, ${row.role}, ${row.model}, ${row.homeGeneration}, ${row.sectionId},
      ${row.position}, ${row.canManageBots}, ${row.createdAt}, ${row.updatedAt}
    )
    ${onConflict === "skip" ? sql`ON CONFLICT DO NOTHING` : sql``}
  `;
  const insertMemoryRow = (row: typeof MemoryRow.Encoded, onConflict: "fail" | "skip") => sql`
    INSERT INTO memories (id, bot_id, text, source, enabled, created_at, updated_at)
    VALUES (
      ${row.id}, ${row.botId}, ${row.text}, ${row.source}, ${row.enabled}, ${row.createdAt},
      ${row.updatedAt}
    )
    ${onConflict === "skip" ? sql`ON CONFLICT DO NOTHING` : sql``}
  `;

  const listMemories = (botId?: BotId) =>
    (botId === undefined
      ? sql`${selectMemories} ORDER BY created_at, id`
      : sql`${selectMemories} WHERE bot_id = ${botId} ORDER BY created_at, id`
    ).pipe(
      Effect.flatMap(decodeMemories),
      Effect.mapError(failWith("Could not read bot memories from bots.sqlite")),
    );

  return BotsStore.of({
    listBots: sql`${selectBots} ORDER BY position, created_at, id`.pipe(
      Effect.flatMap(decodeBots),
      Effect.mapError(failWith("Could not read bots from bots.sqlite")),
    ),
    getBot: (id) =>
      sql`${selectBots} WHERE id = ${id}`.pipe(
        Effect.flatMap(decodeBots),
        Effect.map((rows) => Option.fromNullishOr(rows[0])),
        Effect.mapError(failWith(`Could not read bot ${id} from bots.sqlite`)),
      ),
    insertBot: (bot) =>
      encodeBot(bot).pipe(
        Effect.flatMap((row) => insertBotRow(row, "fail")),
        Effect.asVoid,
        Effect.mapError(failWith(`Could not insert bot ${bot.id}`)),
      ),
    updateBot: (bot) =>
      encodeBot(bot).pipe(
        Effect.flatMap(
          (row) => sql`
            UPDATE bots
            SET
              name = ${row.name},
              role = ${row.role},
              model_json = ${row.model},
              home_generation = ${row.homeGeneration},
              section_id = ${row.sectionId},
              position = ${row.position},
              can_manage_bots = ${row.canManageBots},
              created_at = ${row.createdAt},
              updated_at = ${row.updatedAt}
            WHERE id = ${row.id}
            RETURNING id
          `,
        ),
        Effect.mapError(failWith(`Could not update bot ${bot.id}`)),
        Effect.flatMap((rows) =>
          rows.length === 0
            ? Effect.fail(new BotsError({ message: `Bot ${bot.id} does not exist` }))
            : Effect.void,
        ),
      ),
    deleteBot: (id) =>
      sql`DELETE FROM bots WHERE id = ${id}`.pipe(
        Effect.asVoid,
        Effect.mapError(failWith(`Could not delete bot ${id}`)),
      ),
    listSections: sql`${selectSections} ORDER BY position, created_at, id`.pipe(
      Effect.flatMap(decodeSections),
      Effect.mapError(failWith("Could not read bot sections from bots.sqlite")),
    ),
    getSection: (id) =>
      sql`${selectSections} WHERE id = ${id}`.pipe(
        Effect.flatMap(decodeSections),
        Effect.map((rows) => Option.fromNullishOr(rows[0])),
        Effect.mapError(failWith(`Could not read section ${id} from bots.sqlite`)),
      ),
    insertSection: (section) =>
      sql`
        INSERT INTO sections (id, name, position, created_at, updated_at)
        VALUES (
          ${section.id}, ${section.name}, ${section.position}, ${section.createdAt},
          ${section.updatedAt}
        )
      `.pipe(Effect.asVoid, Effect.mapError(failWith(`Could not insert section ${section.id}`))),
    updateSection: (section) =>
      sql`
        UPDATE sections
        SET
          name = ${section.name},
          position = ${section.position},
          created_at = ${section.createdAt},
          updated_at = ${section.updatedAt}
        WHERE id = ${section.id}
        RETURNING id
      `.pipe(
        Effect.mapError(failWith(`Could not update section ${section.id}`)),
        Effect.flatMap((rows) =>
          rows.length === 0
            ? Effect.fail(new BotsError({ message: `Section ${section.id} does not exist` }))
            : Effect.void,
        ),
      ),
    deleteSection: (id) =>
      sql`DELETE FROM sections WHERE id = ${id}`.pipe(
        Effect.asVoid,
        Effect.mapError(failWith(`Could not delete section ${id}`)),
      ),
    arrange: (arrangement) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            yield* Effect.forEach(
              arrangement.sectionIds,
              (id, index) => sql`UPDATE sections SET position = ${index} WHERE id = ${id}`,
              { discard: true },
            );
            yield* Effect.forEach(
              arrangement.bots,
              (bot, index) => sql`
                UPDATE bots SET position = ${index}, section_id = ${bot.sectionId}
                WHERE id = ${bot.botId}
              `,
              { discard: true },
            );
          }),
        )
        .pipe(Effect.mapError(failWith("Could not rearrange the bots; nothing changed"))),
    listMemories,
    getMemory: (id) =>
      sql`${selectMemories} WHERE id = ${id}`.pipe(
        Effect.flatMap(decodeMemories),
        Effect.map((rows) => Option.fromNullishOr(rows[0])),
        Effect.mapError(failWith(`Could not read memory ${id} from bots.sqlite`)),
      ),
    insertMemory: (memory) =>
      encodeMemory(memory).pipe(
        Effect.flatMap((row) => insertMemoryRow(row, "fail")),
        Effect.asVoid,
        Effect.mapError(failWith(`Could not insert memory ${memory.id} for bot ${memory.botId}`)),
      ),
    updateMemory: (memory) =>
      encodeMemory(memory).pipe(
        Effect.flatMap(
          (row) => sql`
            UPDATE memories
            SET
              bot_id = ${row.botId},
              text = ${row.text},
              source = ${row.source},
              enabled = ${row.enabled},
              created_at = ${row.createdAt},
              updated_at = ${row.updatedAt}
            WHERE id = ${row.id}
            RETURNING id
          `,
        ),
        Effect.mapError(failWith(`Could not update memory ${memory.id}`)),
        Effect.flatMap((rows) =>
          rows.length === 0
            ? Effect.fail(new BotsError({ message: `Memory ${memory.id} does not exist` }))
            : Effect.void,
        ),
      ),
    deleteMemory: (id) =>
      sql`DELETE FROM memories WHERE id = ${id}`.pipe(
        Effect.asVoid,
        Effect.mapError(failWith(`Could not delete memory ${id}`)),
      ),
    getAboutMe: sql`SELECT about_me AS "aboutMe" FROM owner_profile WHERE id = 1`.pipe(
      Effect.flatMap(decodeAboutMe),
      Effect.map((rows) => rows[0]?.aboutMe ?? ""),
      Effect.mapError(failWith("Could not read the owner profile from bots.sqlite")),
    ),
    setAboutMe: (text) =>
      sql`
        INSERT INTO owner_profile (id, about_me) VALUES (1, ${text})
        ON CONFLICT (id) DO UPDATE SET about_me = excluded.about_me
      `.pipe(Effect.asVoid, Effect.mapError(failWith("Could not save the owner profile"))),
    importBatch: (batch) =>
      Effect.gen(function* () {
        const botRows = yield* Effect.forEach(batch.bots, (bot) => encodeBot(bot));
        const memoryRows = yield* Effect.forEach(batch.memories, (memory) => encodeMemory(memory));
        // ON CONFLICT DO NOTHING skips ids (and same-bot texts) already stored, while CHECK and
        // foreign key violations still fail and roll the whole batch back.
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* Effect.forEach(botRows, (row) => insertBotRow(row, "skip"), { discard: true });
            yield* Effect.forEach(memoryRows, (row) => insertMemoryRow(row, "skip"), {
              discard: true,
            });
            if (batch.aboutMe !== null) {
              yield* sql`
                INSERT INTO owner_profile (id, about_me) VALUES (1, ${batch.aboutMe})
                ON CONFLICT (id) DO UPDATE SET about_me = excluded.about_me
                WHERE owner_profile.about_me = ''
              `;
            }
          }),
        );
      }).pipe(Effect.mapError(failWith("Could not import bots; nothing was written"))),
    upsertPushDevice: (device) =>
      sql`
        INSERT INTO bot_push_devices (token, label, created_at, updated_at)
        VALUES (${device.token}, ${device.label}, ${device.createdAt}, ${device.updatedAt})
        ON CONFLICT (token) DO UPDATE SET
          label = excluded.label,
          updated_at = excluded.updated_at
      `.pipe(Effect.asVoid, Effect.mapError(failWith("Could not register the push device"))),
    deletePushDevice: (token) =>
      sql`DELETE FROM bot_push_devices WHERE token = ${token}`.pipe(
        Effect.asVoid,
        Effect.mapError(failWith("Could not unregister the push device")),
      ),
    listPushDevices: sql`
      SELECT token, label, created_at AS "createdAt", updated_at AS "updatedAt"
      FROM bot_push_devices
      ORDER BY created_at, token
    `.pipe(
      Effect.flatMap(decodePushDevices),
      Effect.mapError(failWith("Could not read push devices from bots.sqlite")),
    ),
  });
});

/** `bots.sqlite` in the server state directory (`ServerConfig.stateDir`). */
export const layer = Layer.effect(BotsStore, make).pipe(Layer.provide(BotsDb.layer));

/** A migrated in-memory database, for tests. */
export const layerMemory = Layer.effect(BotsStore, make).pipe(Layer.provide(BotsDb.layerMemory));
