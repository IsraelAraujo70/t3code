import { AuthSessionId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as AuthSessions from "../../persistence/AuthSessions.ts";
import { migrationManifest, runMigrations } from "../../persistence/Migrations.ts";
import { ensureThreadGrantColumns } from "./threadGrantSchema.ts";

const sqlite = NodeSqliteClient.layer({ filename: ":memory:" });
const layer = it.layer(Layer.provideMerge(AuthSessions.layer, sqlite));

const lastUpstreamMigration = Math.max(...migrationManifest.map(([id]) => id));

layer("thread_grant columns", (it) => {
  it.effect("adds nullable thread_grant to an existing database without touching its rows", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const repository = yield* AuthSessions.AuthSessionRepository;
      const columns = (table: string) =>
        sql<{ readonly name: string }>`SELECT name FROM pragma_table_info(${table})`.pipe(
          Effect.map((rows) => rows.map((row) => row.name)),
        );

      yield* runMigrations({ toMigrationInclusive: lastUpstreamMigration });
      assert.notInclude(yield* columns("auth_sessions"), "thread_grant");
      yield* sql`
        INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
        VALUES ('session-before', 'relay', '["orchestration:read"]', 'bearer-access-token',
          '2026-11-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z')
      `;

      yield* runMigrations();
      yield* ensureThreadGrantColumns();

      assert.include(yield* columns("auth_sessions"), "thread_grant");
      assert.include(yield* columns("auth_pairing_links"), "thread_grant");
      const existing = yield* repository.getById({
        sessionId: AuthSessionId.make("session-before"),
      });
      assert.isTrue(Option.isSome(existing));
      assert.strictEqual(Option.getOrThrow(existing).threadGrant, null);
      assert.deepStrictEqual(
        (yield* sql`SELECT migration_id FROM effect_sql_migrations WHERE migration_id > ${lastUpstreamMigration}`)
          .length,
        0,
      );
    }),
  );
});
