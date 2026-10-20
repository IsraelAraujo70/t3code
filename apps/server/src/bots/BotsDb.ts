/**
 * The SqlClient of `bots.sqlite`, migrated with the fork's own ledger. Only BotsStore may
 * provide it (with `Layer.provide`); exposing it would replace the server's main SqlClient.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import * as ServerConfig from "../config.ts";
import Migration0001 from "./migrations/001_Bots.ts";
import Migration0002 from "./migrations/002_ThreadWatches.ts";
import Migration0003 from "./migrations/003_Sections.ts";

const runMigrations = Migrator.make({})({
  loader: Migrator.fromRecord({
    "1_Bots": Migration0001,
    "2_ThreadWatches": Migration0002,
    "3_Sections": Migration0003,
  }),
});

const layerSetup = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Same policy as the main database (persistence/Sqlite.ts): wait on locks, enforce the
    // cascade from bots to memories, and fsync only at WAL checkpoints.
    yield* sql`PRAGMA busy_timeout = 5000;`;
    yield* sql`PRAGMA foreign_keys = ON;`;
    yield* sql`PRAGMA journal_mode = WAL;`;
    yield* sql`PRAGMA synchronous = NORMAL;`;
    yield* sql`PRAGMA checkpoint_fullfsync = ON;`;
    yield* runMigrations;
  }),
);

/** `bots.sqlite` in `ServerConfig.stateDir`, created and migrated on first use. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const { stateDir } = yield* ServerConfig.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(stateDir, { recursive: true });
    const filename = path.join(stateDir, "bots.sqlite");
    return Layer.provideMerge(
      layerSetup,
      NodeSqliteClient.layer({
        filename,
        spanAttributes: { "db.name": path.basename(filename), "service.name": "t3code-server" },
      }),
    );
  }),
);

/** A migrated in-memory database, for tests. */
export const layerMemory = Layer.provideMerge(
  layerSetup,
  NodeSqliteClient.layer({ filename: ":memory:" }),
);
