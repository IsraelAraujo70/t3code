/**
 * What a guest bot's own tools produced (GuestTools: an image it generated, a page it published),
 * in `bots.sqlite`. This is the trusted record the guest API reads: tool results also travel
 * through the sandboxed Claude Code's output, which the bot can forge, so the guest API serves an
 * artifact only when a row here names it for that bot's thread.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import { BotId, BotsError, type GuestId } from "@t3tools/contracts";

import * as BotsDb from "../BotsDb.ts";

export const GuestArtifactKind = Schema.Literals(["image", "html"]);
export type GuestArtifactKind = typeof GuestArtifactKind.Type;

export const GuestArtifact = Schema.Struct({
  /** The attachment id; the file is `<attachmentsDir>/<id><extension>`. */
  id: Schema.String,
  botId: BotId,
  threadId: Schema.String,
  kind: GuestArtifactKind,
  /** The image's file name, or the page's title. */
  name: Schema.String,
  mimeType: Schema.String,
  /** Pages only: the frame height the bot asked for. */
  height: Schema.NullOr(Schema.Number),
  sizeBytes: Schema.Number,
  createdAt: Schema.String,
});
export type GuestArtifact = typeof GuestArtifact.Type;

const decodeArtifacts = Schema.decodeUnknownEffect(Schema.Array(GuestArtifact));
const failWith = (message: string) => (cause: unknown) => new BotsError({ message, cause });

export class GuestArtifacts extends Context.Service<
  GuestArtifacts,
  {
    /** Records the artifact and tells every open guest stream of its thread. */
    readonly record: (artifact: GuestArtifact) => Effect.Effect<void, BotsError>;
    /** Oldest first. */
    readonly listForThread: (
      threadId: string,
    ) => Effect.Effect<ReadonlyArray<GuestArtifact>, BotsError>;
    /** The artifact only when it belongs to this thread. */
    readonly get: (
      threadId: string,
      id: string,
    ) => Effect.Effect<Option.Option<GuestArtifact>, BotsError>;
    /** Images the guest's bots generated since `sinceIso`, for the daily cap. */
    readonly countImagesSince: (
      guestId: GuestId,
      sinceIso: string,
    ) => Effect.Effect<number, BotsError>;
    /** Every artifact recorded from now on. */
    readonly recorded: Stream.Stream<GuestArtifact>;
  }
>()("t3/bots/guest/GuestArtifacts") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const changes = yield* PubSub.unbounded<GuestArtifact>();
  const select = sql`
    SELECT id, bot_id AS "botId", thread_id AS "threadId", kind, name, mime_type AS "mimeType",
      height, size_bytes AS "sizeBytes", created_at AS "createdAt"
    FROM guest_artifacts
  `;

  return GuestArtifacts.of({
    record: (artifact) =>
      sql`
        INSERT INTO guest_artifacts
          (id, bot_id, thread_id, kind, name, mime_type, height, size_bytes, created_at)
        VALUES (${artifact.id}, ${artifact.botId}, ${artifact.threadId}, ${artifact.kind},
          ${artifact.name}, ${artifact.mimeType}, ${artifact.height}, ${artifact.sizeBytes},
          ${artifact.createdAt})
      `.pipe(
        Effect.mapError(failWith(`Could not record guest artifact ${artifact.id}`)),
        Effect.andThen(PubSub.publish(changes, artifact)),
        Effect.asVoid,
      ),
    listForThread: (threadId) =>
      sql`${select} WHERE thread_id = ${threadId} ORDER BY created_at, id`.pipe(
        Effect.flatMap(decodeArtifacts),
        Effect.mapError(failWith(`Could not read the guest artifacts of ${threadId}`)),
      ),
    get: (threadId, id) =>
      sql`${select} WHERE thread_id = ${threadId} AND id = ${id}`.pipe(
        Effect.flatMap(decodeArtifacts),
        Effect.map((rows) => Option.fromNullishOr(rows[0])),
        Effect.mapError(failWith(`Could not read guest artifact ${id}`)),
      ),
    countImagesSince: (guestId, sinceIso) =>
      sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM guest_artifacts a
        JOIN guest_bots g ON g.bot_id = a.bot_id
        WHERE g.guest_id = ${guestId} AND a.kind = 'image' AND a.created_at >= ${sinceIso}
      `.pipe(
        Effect.map((rows) => Number(rows[0]?.count ?? 0)),
        Effect.mapError(failWith(`Could not count the images of guest ${guestId}`)),
      ),
    recorded: Stream.fromPubSub(changes),
  });
});

/** `bots.sqlite` in the server state directory. */
export const layer = Layer.effect(GuestArtifacts, make).pipe(Layer.provide(BotsDb.layer));

/** Over a migrated in-memory database shared with the other stores, for tests. */
export const layerFromDb = Layer.effect(GuestArtifacts, make);
