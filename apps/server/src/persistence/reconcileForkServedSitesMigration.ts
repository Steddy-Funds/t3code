import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import ScheduledTaskThreadMode from "./Migrations/080_ScheduledTaskThreadMode.ts";

// Fork builds once recorded served_sites as migration 80, which main now uses. The table is
// created by its repository, so hand id 80 back to main's migration and run it.
export const reconcileForkServedSitesMigration = Effect.fn("reconcileForkServedSitesMigration")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const tables = yield* sql`
          SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
        `;
        if (tables.length === 0) return [];
        const forkRows = yield* sql`
          SELECT 1 FROM effect_sql_migrations WHERE migration_id = 80 AND name = 'ServedSites'
        `;
        if (forkRows.length === 0) return [];
        yield* ScheduledTaskThreadMode;
        yield* sql`UPDATE effect_sql_migrations SET name = 'ScheduledTaskThreadMode' WHERE migration_id = 80`;
        return [[80, "ScheduledTaskThreadMode"] as const];
      }),
    );
  },
);
