import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE served_sites (
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
});
