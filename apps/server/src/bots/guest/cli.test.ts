// @effect-diagnostics nodeBuiltinImport:off -- exercises the offline CLI and its real database.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as NodeSqlite from "node:sqlite";
import { GuestId, parseGuestPairing } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { expect, it } from "@effect/vitest";
import * as ServerConfig from "../../config.ts";
import * as Guests from "./GuestStore.ts";
import { hashGuestToken } from "./guestToken.ts";

const execute = NodeUtil.promisify(NodeChildProcess.execFile);
const MintResult = Schema.Struct({
  guestId: Schema.String,
  token: Schema.String,
  pairing: Schema.String,
});
const BotResult = Schema.Struct({ botId: Schema.String });
const decodeMint = Schema.decodeUnknownSync(Schema.fromJsonString(MintResult));
const decodeBot = Schema.decodeUnknownSync(Schema.fromJsonString(BotResult));

it.effect(
  "administers guests and bots offline without leaking credentials",
  () =>
    Effect.gen(function* () {
      const cache = NodePath.join(NodeOS.homedir(), ".cache/friend-tmp");
      NodeFS.mkdirSync(cache, { recursive: true });
      const baseDir = NodeFS.mkdtempSync(NodePath.join(cache, "guest-cli-"));
      const cli = (...args: string[]) =>
        execute(
          process.execPath,
          [NodePath.join(import.meta.dirname, "cli.ts"), "--base-dir", baseDir, ...args],
          { env: { ...process.env, TMPDIR: cache } },
        );
      const lookup = (hash: string) =>
        Effect.gen(function* () {
          return yield* (yield* Guests.GuestStore).getGuestByTokenHash(hash);
        }).pipe(
          Effect.provide(
            Guests.layer.pipe(
              Layer.provide(ServerConfig.layerTest(baseDir, baseDir)),
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        );
      try {
        expect(
          JSON.parse(
            (yield* Effect.promise(() => cli("create", "bia", "--name", "Bia", "--json"))).stdout,
          ),
        ).toEqual({
          guestId: "bia",
        });
        yield* Effect.promise(() =>
          expect(cli("create", "bia", "--name", "Duplicate", "--json")).rejects.toMatchObject({
            code: 1,
          }),
        );
        yield* Effect.promise(() =>
          expect(
            cli("mint", "bia", "--server", "https://example.com/path", "--json"),
          ).rejects.toMatchObject({ code: 1 }),
        );
        const first = decodeMint(
          (yield* Effect.promise(() =>
            cli("mint", "bia", "--server", "https://example.com", "--json"),
          )).stdout,
        );
        expect(first.token).toMatch(/^t3g_/);
        expect(parseGuestPairing(first.pairing)).toEqual({
          server: "https://example.com",
          token: first.token,
        });
        const firstHash = hashGuestToken(first.token)!;
        expect(Option.getOrNull(yield* lookup(firstHash))).toMatchObject({
          id: GuestId.make("bia"),
          tokenHash: firstHash,
        });
        const second = decodeMint(
          (yield* Effect.promise(() =>
            cli("mint", "bia", "--server", "https://example.com", "--json"),
          )).stdout,
        );
        const secondHash = hashGuestToken(second.token)!;
        expect(yield* lookup(firstHash)).toEqual(Option.none());
        expect(Option.isSome(yield* lookup(secondHash))).toBe(true);

        const roleFile = NodePath.join(baseDir, "role.txt");
        NodeFS.writeFileSync(roleFile, "Help Bia plan her day.");
        const created = yield* Effect.promise(() =>
          cli(
            "bot-create",
            "bia",
            "--name",
            "Helper",
            "--instance",
            "bia-sandbox",
            "--model",
            "claude-sonnet-4-6",
            "--effort",
            "high",
            "--role-file",
            roleFile,
            "--json",
          ),
        );
        const { botId } = decodeBot(created.stdout);
        expect(botId).toMatch(/^b_[0-9a-f]{32}$/);
        expect(created.stderr).toContain("guest API will refuse this bot");
        expect(created.stderr).toContain("first message");
        const db = new NodeSqlite.DatabaseSync(NodePath.join(baseDir, "userdata/bots.sqlite"), {
          readOnly: true,
        });
        try {
          expect(
            db.prepare("SELECT guest_id FROM guest_bots WHERE bot_id = ?").get(botId),
          ).toMatchObject({ guest_id: "bia" });
          const row = db.prepare("SELECT * FROM bots WHERE id = ?").get(botId);
          expect(row).toMatchObject({
            role: "Help Bia plan her day.",
            home_generation: 1,
            section_id: null,
            can_manage_bots: 0,
          });
          expect(JSON.parse(String(row?.model_json))).toEqual({
            instanceId: "bia-sandbox",
            model: "claude-sonnet-4-6",
            options: [{ id: "effort", value: "high" }],
          });
        } finally {
          db.close();
        }
        yield* Effect.promise(() =>
          expect(cli("assign", "bia", "unknown", "--json")).rejects.toMatchObject({ code: 1 }),
        );
        const listed = (yield* Effect.promise(() => cli("list", "--json"))).stdout;
        for (const secret of [first.token, second.token, firstHash, secondHash, "tokenHash"])
          expect(listed).not.toContain(secret);
        expect(JSON.parse(listed)).toMatchObject({
          guests: [
            {
              id: "bia",
              name: "Bia",
              tokenActive: true,
              tokenCreatedAt: expect.any(String),
              bots: [{ id: botId, name: "Helper" }],
            },
          ],
        });
        yield* Effect.promise(() => cli("unassign", botId, "--json"));
        yield* Effect.promise(() => cli("assign", "bia", botId, "--json"));
        expect(
          JSON.parse((yield* Effect.promise(() => cli("revoke", "bia", "--json"))).stdout),
        ).toEqual({
          guestId: "bia",
          revoked: true,
        });
        expect(yield* lookup(secondHash)).toEqual(Option.none());
        expect(
          JSON.parse((yield* Effect.promise(() => cli("list", "--json"))).stdout),
        ).toMatchObject({
          guests: [{ tokenActive: false, tokenCreatedAt: null }],
        });
        const human = yield* Effect.promise(() =>
          cli("mint", "bia", "--server", "http://localhost:9000"),
        );
        expect(human.stdout).toContain("Pairing: t3guest://pair?");
        expect(human.stdout).toMatch(/[▀▄█]/);
      } finally {
        NodeFS.rmSync(baseDir, { recursive: true, force: true });
      }
    }),
  { timeout: 60_000 },
);
