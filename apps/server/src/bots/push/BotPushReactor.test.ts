import { GuestId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as BotsStore from "../BotsStore.ts";
import * as GuestStore from "../guest/GuestStore.ts";
import { BotId, ThreadId } from "@t3tools/contracts";
import { pushesFor } from "./BotPushReactor.ts";

it.effect("pushes a shared bot to the owner and its guest, each on their own phones", () =>
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
    const notice = {
      kind: "replied" as const,
      key: "bot-push:run:run-1",
      threadId: ThreadId.make("bot:b_fin:1"),
      botId: BotId.make("b_fin"),
      body: "Done.",
    };
    const ownerData = { t3_kind: "bot_message", alert_id: notice.key };
    const [ownerPush, guestPush, ...rest] = pushesFor(
      { name: "Bot" },
      Option.some(id),
      notice,
      ownerData,
      store,
      guests,
    );
    assert.deepStrictEqual(rest, []);
    const [ownerOnly, ...none] = pushesFor(
      { name: "Bot" },
      Option.none(),
      notice,
      ownerData,
      store,
      guests,
    );
    assert.deepStrictEqual(none, []);
    // The owner's push is T3's own, data-only, on the owner's phones, shared bot or not.
    for (const push of [ownerPush!, ownerOnly!]) {
      assert.strictEqual(push.data, ownerData);
      assert.isUndefined(push.audience.notification);
      assert.deepStrictEqual(
        (yield* push.audience.devices).map((device) => device.token),
        ["owner"],
      );
    }
    // The guest's is minimal and visible, on that guest's phones only.
    assert.deepStrictEqual(guestPush!.data, {
      t3_kind: "guest_bot_message",
      botId: "b_fin",
      alert_id: notice.key,
    });
    assert.deepStrictEqual(guestPush!.audience.notification, { title: "Bot", body: "Done." });
    assert.deepStrictEqual(
      (yield* guestPush!.audience.devices).map((device) => device.token),
      ["bia"],
    );
    yield* guestPush!.audience.drop("bia");
    assert.deepStrictEqual(yield* guestPush!.audience.devices, []);
    assert.strictEqual((yield* guests.listPushDevices(otherId)).length, 1);
    assert.strictEqual((yield* ownerPush!.audience.devices).length, 1);
    yield* ownerPush!.audience.drop("owner");
    assert.deepStrictEqual(yield* ownerPush!.audience.devices, []);
  }).pipe(Effect.provide(Layer.merge(BotsStore.layerMemory, GuestStore.layerMemory))),
);
