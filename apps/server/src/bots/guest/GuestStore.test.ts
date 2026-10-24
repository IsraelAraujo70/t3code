import { BotId, GuestId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as BotsDb from "../BotsDb.ts";
import { GuestStore, layerFromDb, type GuestRecord } from "./GuestStore.ts";

const at = "2026-01-01T00:00:00.000Z";
const later = "2026-02-01T00:00:00.000Z";
const guest = (id: string, createdAt = at): GuestRecord => ({
  id: GuestId.make(id),
  name: id,
  tokenHash: null,
  tokenCreatedAt: null,
  createdAt,
  updatedAt: createdAt,
});
const testLayer = Layer.provideMerge(layerFromDb, BotsDb.layerMemory);
const withStore = <A, E>(
  f: (store: typeof GuestStore.Service, sql: SqlClient.SqlClient) => Effect.Effect<A, E>,
) =>
  Effect.gen(function* () {
    return yield* f(yield* GuestStore, yield* SqlClient.SqlClient);
  }).pipe(Effect.provide(testLayer));

// BotsStore keeps its constructor private, so bot fixtures use the same migrated SqlClient.
const insertBot = (sql: SqlClient.SqlClient, id: string) => sql`
  INSERT INTO bots (id, name, role, model_json, home_generation, position, created_at, updated_at)
  VALUES (${id}, ${id}, 'Helps out.', '{}', 1, 0, ${at}, ${at})
`;

it.effect("inserts, gets and lists guests by creation time then id", () =>
  withStore((store) =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* store.getGuest(GuestId.make("missing")), Option.none());
      for (const row of [guest("late", later), guest("bia"), guest("ana")])
        yield* store.insertGuest(row);
      assert.deepStrictEqual(yield* store.listGuests, [
        guest("ana"),
        guest("bia"),
        guest("late", later),
      ]);
      assert.deepStrictEqual(yield* store.getGuest(GuestId.make("bia")), Option.some(guest("bia")));
      assert.strictEqual((yield* Effect.flip(store.insertGuest(guest("bia"))))._tag, "BotsError");
    }),
  ),
);

it.effect("looks up current tokens, enforces uniqueness and revokes tokens", () =>
  withStore((store) =>
    Effect.gen(function* () {
      yield* store.insertGuest(guest("bia"));
      yield* store.insertGuest(guest("ana"));
      assert.isTrue(Option.isNone(yield* store.getGuestByTokenHash("unknown")));
      yield* store.setTokenHash(GuestId.make("bia"), "hash", later);
      assert.deepStrictEqual(Option.getOrThrow(yield* store.getGuestByTokenHash("hash")), {
        ...guest("bia"),
        tokenHash: "hash",
        tokenCreatedAt: later,
        updatedAt: later,
      });
      assert.strictEqual(
        (yield* Effect.flip(store.setTokenHash(GuestId.make("ana"), "hash", later)))._tag,
        "BotsError",
      );
      assert.strictEqual(
        (yield* Effect.flip(store.insertGuest({ ...guest("other"), tokenHash: "hash" })))._tag,
        "BotsError",
      );
      yield* store.setTokenHash(GuestId.make("bia"), "replacement", later);
      assert.isTrue(Option.isNone(yield* store.getGuestByTokenHash("hash")));
      yield* store.setTokenHash(GuestId.make("bia"), null, at);
      assert.isTrue(Option.isNone(yield* store.getGuestByTokenHash("replacement")));
      assert.deepStrictEqual(yield* store.getGuest(GuestId.make("bia")), Option.some(guest("bia")));
      assert.strictEqual(
        (yield* Effect.flip(store.setTokenHash(GuestId.make("missing"), null, at)))._tag,
        "BotsError",
      );
    }),
  ),
);

it.effect(
  "assigns idempotently, rejects other owners and missing rows, and lists assignments",
  () =>
    withStore((store, sql) =>
      Effect.gen(function* () {
        const bia = GuestId.make("bia");
        const ana = GuestId.make("ana");
        for (const row of [guest("bia"), guest("ana")]) yield* store.insertGuest(row);
        for (const id of ["a", "b", "c", "d"]) yield* insertBot(sql, id);
        yield* store.assignBot(bia, BotId.make("c"), later);
        yield* store.assignBot(bia, BotId.make("b"), at);
        yield* store.assignBot(bia, BotId.make("a"), at);
        yield* store.assignBot(bia, BotId.make("b"), later);
        assert.deepStrictEqual(yield* store.listGuestBotIds(bia), [
          BotId.make("a"),
          BotId.make("b"),
          BotId.make("c"),
        ]);
        assert.deepStrictEqual(yield* store.guestOfBot(BotId.make("a")), Option.some(bia));
        assert.strictEqual(
          (yield* Effect.flip(store.assignBot(ana, BotId.make("a"), at)))._tag,
          "BotsError",
        );
        assert.strictEqual(
          (yield* Effect.flip(store.assignBot(bia, BotId.make("missing"), at)))._tag,
          "BotsError",
        );
        assert.strictEqual(
          (yield* Effect.flip(store.assignBot(GuestId.make("missing"), BotId.make("d"), at)))._tag,
          "BotsError",
        );
        assert.deepStrictEqual(
          yield* store.listAssignments,
          new Map([
            [BotId.make("a"), bia],
            [BotId.make("b"), bia],
            [BotId.make("c"), bia],
          ]),
        );
        yield* store.unassignBot(BotId.make("a"));
        yield* store.unassignBot(BotId.make("a"));
        assert.isTrue(Option.isNone(yield* store.guestOfBot(BotId.make("a"))));
        yield* sql`DELETE FROM bots WHERE id = 'b'`;
        assert.isTrue(Option.isNone(yield* store.guestOfBot(BotId.make("b"))));
        assert.deepStrictEqual(yield* store.listGuestBotIds(bia), [BotId.make("c")]);
      }),
    ),
);

it.effect(
  "refreshes a guest's own push token, never takes another's, and deletes only owned ones",
  () =>
    withStore((store) =>
      Effect.gen(function* () {
        const bia = GuestId.make("bia");
        const ana = GuestId.make("ana");
        yield* store.insertGuest(guest("bia"));
        yield* store.insertGuest(guest("ana"));
        const device = { token: "phone", guestId: bia, label: null, createdAt: at, updatedAt: at };
        yield* store.upsertPushDevice(device);
        // Another guest registering the same token leaves it with its owner.
        yield* store.upsertPushDevice({
          ...device,
          guestId: ana,
          label: "Taken",
          updatedAt: later,
        });
        assert.deepStrictEqual(yield* store.listPushDevices(ana), []);
        assert.deepStrictEqual(yield* store.listPushDevices(bia), [device]);
        // The owner re-registering refreshes the label and updatedAt, keeping createdAt.
        yield* store.upsertPushDevice({
          ...device,
          label: "New",
          createdAt: later,
          updatedAt: later,
        });
        assert.deepStrictEqual(yield* store.listPushDevices(bia), [
          { ...device, label: "New", updatedAt: later },
        ]);
        yield* store.deletePushDevice(ana, "phone");
        assert.strictEqual((yield* store.listPushDevices(bia)).length, 1);
        yield* store.upsertPushDevice({ ...device, token: "z", createdAt: later });
        yield* store.upsertPushDevice({ ...device, token: "a" });
        assert.deepStrictEqual(
          (yield* store.listPushDevices(bia)).map((row) => row.token),
          ["a", "phone", "z"],
        );
        yield* store.deletePushDevice(bia, "phone");
        yield* store.deletePushDevice(bia, "phone");
        assert.deepStrictEqual(
          (yield* store.listPushDevices(bia)).map((row) => row.token),
          ["a", "z"],
        );
      }),
    ),
);

it.effect(
  "deletes a guest with its assignments and devices, preserving bots and other guests",
  () =>
    withStore((store, sql) =>
      Effect.gen(function* () {
        const bia = GuestId.make("bia");
        const ana = GuestId.make("ana");
        yield* store.insertGuest(guest("bia"));
        yield* store.insertGuest(guest("ana"));
        yield* insertBot(sql, "bot");
        yield* store.assignBot(bia, BotId.make("bot"), at);
        for (const guestId of [bia, ana])
          yield* store.upsertPushDevice({
            token: guestId,
            guestId,
            label: null,
            createdAt: at,
            updatedAt: at,
          });
        yield* store.deleteGuest(bia);
        yield* store.deleteGuest(bia);
        assert.isTrue(Option.isNone(yield* store.getGuest(bia)));
        assert.deepStrictEqual(yield* store.listAssignments, new Map());
        assert.deepStrictEqual(yield* store.listPushDevices(bia), []);
        assert.strictEqual((yield* store.listPushDevices(ana)).length, 1);
        assert.strictEqual((yield* sql`SELECT id FROM bots WHERE id = 'bot'`).length, 1);
      }),
    ),
);
