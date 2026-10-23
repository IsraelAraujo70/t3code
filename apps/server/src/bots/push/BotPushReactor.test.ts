import { GuestId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as BotsStore from "../BotsStore.ts";
import * as GuestStore from "../guest/GuestStore.ts";
import { audienceFor } from "./BotPushReactor.ts";

it.effect("routes guests exclusively to their phones and leaves owner pushes data-only", () =>
  Effect.gen(function* () {
    const store = yield* BotsStore.BotsStore;
    const guests = yield* GuestStore.GuestStore;
    const id = GuestId.make("bia");
    const otherId = GuestId.make("other");
    const at = "2026-10-21T10:00:00.000Z";
    for (const guestId of [id, otherId]) {
      yield* guests.insertGuest({
        id: guestId,
        name: guestId,
        tokenHash: null,
        tokenCreatedAt: null,
        createdAt: at,
        updatedAt: at,
      });
      yield* guests.upsertPushDevice({
        guestId,
        token: guestId,
        label: null,
        createdAt: at,
        updatedAt: at,
      });
    }
    yield* store.upsertPushDevice({
      token: "owner",
      label: null,
      createdAt: at,
      updatedAt: at,
    });
    const guest = audienceFor({ name: "Bot" }, Option.some(id), "Done.", store, guests);
    const owner = audienceFor({ name: "Bot" }, Option.none(), "Done.", store, guests);
    assert.deepStrictEqual(
      (yield* guest.devices).map((device) => device.token),
      ["bia"],
    );
    assert.deepStrictEqual(guest.notification, { title: "Bot", body: "Done." });
    assert.deepStrictEqual(
      (yield* owner.devices).map((device) => device.token),
      ["owner"],
    );
    assert.isUndefined(owner.notification);
    yield* guest.drop("bia");
    assert.deepStrictEqual(yield* guest.devices, []);
    assert.strictEqual((yield* guests.listPushDevices(otherId)).length, 1);
    assert.strictEqual((yield* owner.devices).length, 1);
    yield* owner.drop("owner");
    assert.deepStrictEqual(yield* owner.devices, []);
  }).pipe(Effect.provide(Layer.merge(BotsStore.layerMemory, GuestStore.layerMemory))),
);
