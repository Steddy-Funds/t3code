import { ServedSite, ServedSiteId, ServedSiteProcess } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { PersistenceDecodeError, PersistenceSqlError } from "./Errors.ts";

export type ServedSitesRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export class ServedSitesRepository extends Context.Service<
  ServedSitesRepository,
  {
    readonly list: Effect.Effect<ReadonlyArray<ServedSite>, ServedSitesRepositoryError>;
    readonly upsert: (site: ServedSite) => Effect.Effect<void, ServedSitesRepositoryError>;
    readonly remove: (id: ServedSiteId) => Effect.Effect<void, ServedSitesRepositoryError>;
  }
>()("t3/persistence/ServedSites/ServedSitesRepository") {}

const ServedSiteRow = Schema.Struct({
  ...ServedSite.fields,
  pids: Schema.fromJsonString(Schema.Array(ServedSiteProcess)),
});

const toSqlOrDecodeError = (operation: string) => (cause: unknown) =>
  Schema.isSchemaError(cause)
    ? PersistenceDecodeError.fromSchemaError(operation, cause)
    : new PersistenceSqlError({ operation, cause });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Fork-only table: a numbered migration would collide with main's next migration id.
  yield* sql`
    CREATE TABLE IF NOT EXISTS served_sites (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      project_cwd TEXT NOT NULL,
      local_port INTEGER NOT NULL,
      pids_json TEXT NOT NULL,
      visibility TEXT NOT NULL,
      tailnet_url TEXT,
      public_url TEXT,
      serve_port INTEGER,
      stop_command TEXT,
      status TEXT NOT NULL,
      removed_reason TEXT,
      last_error TEXT,
      created_at TEXT NOT NULL,
      removed_at TEXT
    )
  `;

  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ServedSiteRow,
    execute: () => sql`
      SELECT
        id AS "id",
        name AS "name",
        thread_id AS "threadId",
        project_cwd AS "projectCwd",
        local_port AS "localPort",
        pids_json AS "pids",
        visibility AS "visibility",
        tailnet_url AS "tailnetUrl",
        public_url AS "publicUrl",
        serve_port AS "servePort",
        stop_command AS "stopCommand",
        status AS "status",
        removed_reason AS "removedReason",
        last_error AS "lastError",
        created_at AS "createdAt",
        removed_at AS "removedAt"
      FROM served_sites
      ORDER BY created_at
    `,
  });

  const encodeRow = Schema.encodeEffect(ServedSiteRow);

  return ServedSitesRepository.of({
    list: listRows(undefined).pipe(
      Effect.mapError(toSqlOrDecodeError("ServedSitesRepository.list")),
      Effect.withSpan("ServedSitesRepository.list"),
    ),
    upsert: Effect.fn("ServedSitesRepository.upsert")(
      function* (site) {
        const row = yield* encodeRow(site);
        yield* sql`
          INSERT INTO served_sites (
            id, name, thread_id, project_cwd, local_port, pids_json, visibility, tailnet_url,
            public_url, serve_port, stop_command, status, removed_reason, last_error, created_at,
            removed_at
          )
          VALUES (
            ${row.id}, ${row.name}, ${row.threadId}, ${row.projectCwd}, ${row.localPort},
            ${row.pids}, ${row.visibility}, ${row.tailnetUrl}, ${row.publicUrl}, ${row.servePort},
            ${row.stopCommand}, ${row.status}, ${row.removedReason}, ${row.lastError},
            ${row.createdAt}, ${row.removedAt}
          )
          ON CONFLICT (id) DO UPDATE SET
            name = excluded.name,
            pids_json = excluded.pids_json,
            tailnet_url = excluded.tailnet_url,
            public_url = excluded.public_url,
            serve_port = excluded.serve_port,
            status = excluded.status,
            removed_reason = excluded.removed_reason,
            last_error = excluded.last_error,
            removed_at = excluded.removed_at
        `;
      },
      Effect.mapError(toSqlOrDecodeError("ServedSitesRepository.upsert")),
    ),
    remove: Effect.fn("ServedSitesRepository.remove")(function* (id) {
      yield* sql`DELETE FROM served_sites WHERE id = ${id}`.pipe(
        Effect.mapError(toSqlOrDecodeError("ServedSitesRepository.remove")),
      );
    }),
  });
});

export const layer = Layer.effect(ServedSitesRepository, make);
