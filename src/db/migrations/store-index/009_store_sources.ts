import * as SqlClient from "@effect/sql/SqlClient";
import { Effect } from "effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`CREATE TABLE IF NOT EXISTS store_sources (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    source TEXT NOT NULL,
    source_json TEXT NOT NULL,
    added_at TEXT NOT NULL,
    last_synced_at TEXT,
    enabled INTEGER NOT NULL DEFAULT 1
  )`;

  yield* sql`CREATE INDEX IF NOT EXISTS store_sources_type_idx ON store_sources(type)`;
  yield* sql`CREATE INDEX IF NOT EXISTS store_sources_enabled_idx ON store_sources(enabled)`;
  yield* sql`CREATE INDEX IF NOT EXISTS store_sources_source_idx ON store_sources(source)`;
});
