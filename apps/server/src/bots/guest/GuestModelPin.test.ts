import { assert, it } from "@effect/vitest";
import {
  BotId,
  botThreadId,
  CommandId,
  GuestId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  type Bot,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as BotsDb from "../BotsDb.ts";
import { BotsStore, layerFromDb as botsLayerFromDb } from "../BotsStore.ts";
import { GuestModelPin, layer as pinLayer } from "./GuestModelPin.ts";
import { GuestStore, layerFromDb as guestsLayerFromDb } from "./GuestStore.ts";

const at = "2026-10-24T00:00:00.000Z";
const sandboxModel = {
  instanceId: ProviderInstanceId.make("claude_bia"),
  model: "claude-sonnet-5-5",
  options: [{ id: "effort", value: "high" }],
};
const hostModel = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };
const bot = (id: string): Bot => ({
  id: BotId.make(id),
  name: id,
  role: "",
  model: sandboxModel,
  homeGeneration: 1,
  sectionId: null,
  position: 0,
  canManageBots: false,
  rotation: "daily",
  createdAt: at,
  updatedAt: at,
});

const send = (threadId: ThreadId): OrchestrationV2ServerCommand => ({
  type: "message.dispatch",
  commandId: CommandId.make("cmd-1"),
  threadId,
  messageId: MessageId.make("msg-1"),
  text: "oi",
  attachments: [],
  modelSelection: hostModel,
  dispatchMode: { type: "queue_after_active" },
  createdBy: "user",
  creationSource: "web",
});

const layer = pinLayer.pipe(
  Layer.provideMerge(Layer.merge(botsLayerFromDb, guestsLayerFromDb)),
  Layer.provide(BotsDb.layerMemory),
);

it.effect("runs a guest's bot on its own model whoever sends, and leaves the rest alone", () =>
  Effect.gen(function* () {
    const bots = yield* BotsStore;
    const guests = yield* GuestStore;
    const pin = yield* GuestModelPin;
    yield* bots.insertBot(bot("b_shared"));
    yield* bots.insertBot({ ...bot("b_owner"), position: 1 });
    yield* guests.insertGuest({
      id: GuestId.make("bia"),
      name: "Bia",
      tokenHash: null,
      tokenCreatedAt: null,
      createdAt: at,
      updatedAt: at,
    });
    yield* guests.assignBot(GuestId.make("bia"), BotId.make("b_shared"), at);

    // The owner's T3 composer sends the thread's old host model; the bot's sandbox model wins,
    // on any generation of its conversation.
    for (const generation of [1, 2]) {
      const pinned = yield* pin.pin(send(botThreadId(BotId.make("b_shared"), generation)));
      assert.deepStrictEqual("modelSelection" in pinned && pinned.modelSelection, sandboxModel);
    }
    const switched = yield* pin.pin({
      type: "thread.model-selection.set",
      commandId: CommandId.make("cmd-2"),
      threadId: botThreadId(BotId.make("b_shared"), 1),
      modelSelection: hostModel,
    });
    assert.deepStrictEqual("modelSelection" in switched && switched.modelSelection, sandboxModel);

    // The owner's own bots and ordinary threads keep what was sent.
    for (const threadId of [botThreadId(BotId.make("b_owner"), 1), ThreadId.make("thread-1")]) {
      const command = send(threadId);
      assert.strictEqual(yield* pin.pin(command), command);
    }
  }).pipe(Effect.provide(layer)),
);
