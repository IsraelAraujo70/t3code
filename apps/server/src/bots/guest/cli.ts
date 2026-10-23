// @effect-diagnostics nodeBuiltinImport:off -- random identifiers for offline administration.
import * as NodeCrypto from "node:crypto";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Bot, BotId, GuestId, ServerSettings, formatGuestPairing } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { QrCode } from "@t3tools/shared/qrCode";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { Argument, Command, Flag } from "effect/cli";
import * as CliError from "effect/cli/CliError";
import * as ServerConfig from "../../config.ts";
import * as BotsDb from "../BotsDb.ts";
import * as Bots from "../BotsStore.ts";
import * as Guests from "./GuestStore.ts";
import { generateGuestToken, hashGuestToken } from "./guestToken.ts";
import { GUEST_ID_ENV, SANDBOX_LAUNCHER_PATH, sandboxBinaryFor } from "./sandboxInstance.ts";

class GuestCliError extends Schema.TaggedError<GuestCliError>()("GuestCliError", {
  message: Schema.String,
}) {}

const root = Command.make("guest").pipe(
  Command.withSharedFlags({ baseDir: Flag.String("base-dir") }),
);
const guestId = Argument.String("guestId").pipe(Argument.withSchema(GuestId));
const botId = Argument.String("botId").pipe(Argument.withSchema(BotId));
const isShowHelp = Schema.is(CliError.ShowHelp);
const decodeBot = Schema.decodeUnknownEffect(Bot);
const decodeSettings = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ providerInstances: ServerSettings.fields.providerInstances }),
  ),
);
const json = Flag.Boolean("json").pipe(Flag.withDefault(false));
const optional = (name: string) => Flag.String(name).pipe(Flag.optional);
const output = (machine: boolean, value: unknown, human: string) =>
  Console.log(machine ? JSON.stringify(value) : human);

const withStores = Effect.fn("GuestCli.withStores")(function* <A, E, R>(
  operation: Effect.Effect<A, E, R>,
) {
  const { baseDir: raw } = yield* root;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const baseDir = path.resolve(
    raw === "~" ? home : raw.startsWith("~/") ? path.join(home, raw.slice(2)) : raw,
  );
  const config = ServerConfig.layerTest(process.cwd(), baseDir);
  // One connection for both stores, so bot-create's insert and assignment share a transaction.
  const stores = Layer.mergeAll(Guests.layerFromDb, Bots.layerFromDb).pipe(
    Layer.provideMerge(BotsDb.layer),
    Layer.provideMerge(config),
  );
  return yield* operation.pipe(Effect.provide(stores));
});

const create = Command.make(
  "create",
  { guestId, name: Flag.String("name"), json },
  Effect.fn("GuestCli.create")(function* (args) {
    yield* withStores(
      Effect.gen(function* () {
        const store = yield* Guests.GuestStore;
        const now = (yield* DateTime.now).pipe(DateTime.formatIso);
        yield* store.insertGuest({
          id: args.guestId,
          name: args.name,
          tokenHash: null,
          tokenCreatedAt: null,
          createdAt: now,
          updatedAt: now,
        });
        yield* output(args.json, { guestId: args.guestId }, `Created guest ${args.guestId}.`);
      }),
    );
  }),
);

function renderQr(pairing: string): string {
  const qr = QrCode.encodeText(pairing, QrCode.Ecc.LOW);
  const lines: string[] = [];
  for (let y = -4; y < qr.size + 4; y += 2) {
    let line = "";
    for (let x = -4; x < qr.size + 4; x++) {
      const top = !qr.getModule(x, y);
      const bottom = !qr.getModule(x, y + 1);
      line += top ? (bottom ? "█" : "▀") : bottom ? "▄" : " ";
    }
    lines.push(line);
  }
  return lines.join("\n");
}

const mint = Command.make(
  "mint",
  { guestId, server: Flag.String("server"), json },
  Effect.fn("GuestCli.mint")(function* (args) {
    const origin = yield* Effect.try({
      try: () => {
        const url = new URL(args.server);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.username ||
          url.password ||
          url.search ||
          url.hash ||
          url.pathname !== "/"
        )
          throw new GuestCliError({ message: "--server must be an http(s) origin" });
        return url.origin;
      },
      catch: () => new GuestCliError({ message: "--server must be an http(s) origin" }),
    });
    yield* withStores(
      Effect.gen(function* () {
        const store = yield* Guests.GuestStore;
        const token = generateGuestToken();
        const pairing = formatGuestPairing({ server: origin, token });
        yield* store.setTokenHash(
          args.guestId,
          hashGuestToken(token),
          (yield* DateTime.now).pipe(DateTime.formatIso),
        );
        yield* output(
          args.json,
          { guestId: args.guestId, token, pairing },
          `Guest ${args.guestId}\nToken: ${token}\nPairing: ${pairing}\n${renderQr(pairing)}`,
        );
      }),
    );
  }),
);

const revoke = Command.make(
  "revoke",
  { guestId, json },
  Effect.fn("GuestCli.revoke")(function* (args) {
    yield* withStores(
      Effect.gen(function* () {
        yield* (yield* Guests.GuestStore).setTokenHash(
          args.guestId,
          null,
          (yield* DateTime.now).pipe(DateTime.formatIso),
        );
        yield* output(
          args.json,
          { guestId: args.guestId, revoked: true },
          `Revoked guest ${args.guestId}.`,
        );
      }),
    );
  }),
);
const assign = Command.make(
  "assign",
  { guestId, botId, json },
  Effect.fn("GuestCli.assign")(function* (args) {
    yield* withStores(
      Effect.gen(function* () {
        yield* (yield* Guests.GuestStore).assignBot(
          args.guestId,
          args.botId,
          (yield* DateTime.now).pipe(DateTime.formatIso),
        );
        yield* output(
          args.json,
          { guestId: args.guestId, botId: args.botId },
          `Assigned ${args.botId} to ${args.guestId}.`,
        );
      }),
    );
  }),
);
const unassign = Command.make(
  "unassign",
  { botId, json },
  Effect.fn("GuestCli.unassign")(function* (args) {
    yield* withStores(
      Effect.gen(function* () {
        yield* (yield* Guests.GuestStore).unassignBot(args.botId);
        yield* output(
          args.json,
          { botId: args.botId, unassigned: true },
          `Unassigned ${args.botId}.`,
        );
      }),
    );
  }),
);
const botCreate = Command.make(
  "bot-create",
  {
    guestId,
    name: Flag.String("name"),
    instance: Flag.String("instance"),
    model: Flag.String("model"),
    effort: optional("effort"),
    role: optional("role"),
    roleFile: optional("role-file"),
    json,
  },
  Effect.fn("GuestCli.botCreate")(function* (args) {
    if (Option.isSome(args.role) && Option.isSome(args.roleFile))
      return yield* new GuestCliError({ message: "Use --role or --role-file, not both" });
    const fs = yield* FileSystem.FileSystem;
    const role = Option.isSome(args.roleFile)
      ? yield* fs.readFileString(args.roleFile.value)
      : Option.getOrElse(args.role, () => "");
    yield* withStores(
      Effect.gen(function* () {
        const store = yield* Bots.BotsStore;
        const guests = yield* Guests.GuestStore;
        const now = (yield* DateTime.now).pipe(DateTime.formatIso);
        const bots = yield* store.listBots;
        const bot = yield* decodeBot({
          id: `b_${NodeCrypto.randomBytes(16).toString("hex")}`,
          name: args.name,
          role,
          model: {
            instanceId: args.instance,
            model: args.model,
            ...(Option.isSome(args.effort)
              ? { options: [{ id: "effort", value: args.effort.value }] }
              : {}),
          },
          homeGeneration: 1,
          sectionId: null,
          position: Math.max(-1, ...bots.map((b) => b.position)) + 1,
          canManageBots: false,
          createdAt: now,
          updatedAt: now,
        });
        const sql = yield* SqlClient.SqlClient;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* store.insertBot(bot);
            yield* guests.assignBot(args.guestId, bot.id, now);
          }),
        );
        const { settingsPath } = yield* ServerConfig.ServerConfig;
        const settings = yield* fs.readFileString(settingsPath).pipe(
          Effect.flatMap(decodeSettings),
          Effect.catch(() => Effect.succeed({ providerInstances: {} })),
        );
        if (
          sandboxBinaryFor(settings.providerInstances, bot.model.instanceId, args.guestId) === null
        ) {
          yield* Console.error(
            `Warning: the guest API will refuse this bot until instance ${args.instance} is the guest's sandbox: driver claudeAgent, binaryPath=${SANDBOX_LAUNCHER_PATH}, env ${GUEST_ID_ENV}=${args.guestId}.`,
          );
        }
        if (args.json)
          yield* Console.error(
            "A running server starts the bot's conversation on its first message.",
          );
        yield* output(
          args.json,
          { botId: bot.id },
          `Created bot ${bot.id}. A running server starts the bot's conversation on its first message.`,
        );
      }),
    );
  }),
);
const list = Command.make(
  "list",
  { json },
  Effect.fn("GuestCli.list")(function* (args) {
    yield* withStores(
      Effect.gen(function* () {
        const store = yield* Guests.GuestStore;
        const bots = yield* (yield* Bots.BotsStore).listBots;
        const assignments = yield* store.listAssignments;
        const guests = (yield* store.listGuests).map((guest) => ({
          id: guest.id,
          name: guest.name,
          tokenActive: guest.tokenHash !== null,
          tokenCreatedAt: guest.tokenCreatedAt,
          bots: bots
            .filter((bot) => assignments.get(bot.id) === guest.id)
            .map(({ id, name, model }) => ({ id, name, model })),
        }));
        yield* output(
          args.json,
          { guests },
          guests.length === 0
            ? "No guests."
            : guests
                .map(
                  (g) =>
                    `${g.id} (${g.name}): token ${g.tokenActive ? `active since ${g.tokenCreatedAt}` : "inactive"}; bots: ${g.bots.map((b) => `${b.id} (${b.name})`).join(", ") || "none"}`,
                )
                .join("\n"),
        );
      }),
    );
  }),
);
const command = root.pipe(
  Command.withSubcommands([create, mint, revoke, assign, unassign, botCreate, list]),
);

/** Runs guest administration with argv excluding the executable and script paths. */
export const runGuestCli = (argv: ReadonlyArray<string>) =>
  Command.runWith(command, { version: "0.0.0", renderErrors: false })(argv);

if (import.meta.main) {
  runGuestCli(process.argv.slice(2)).pipe(
    Effect.catchCause((cause) =>
      Effect.gen(function* () {
        const error = cause.reasons[0];
        const failure = error && "error" in error ? error.error : undefined;
        const message = isShowHelp(failure)
          ? failure.errors.map((entry) => entry.message).join("; ") || failure.message
          : failure instanceof Error
            ? failure.message
            : "Guest command failed";
        yield* Console.error(message.replace(/[\r\n]+/g, " "));
        process.exitCode = 1;
      }),
    ),
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
