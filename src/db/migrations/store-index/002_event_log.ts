import * as SqlClient from "@effect/sql/SqlClient";
import { Effect } from "effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`CREATE TABLE IF NOT EXISTS event_log (
    event_id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL,
    post_uri TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    source TEXT NOT NULL
  )`;

  yield* sql`CREATE TABLE IF NOT EXISTS event_log_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`;

  yield* sql`CREATE INDEX IF NOT EXISTS event_log_created_at_idx ON event_log(created_at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS event_log_post_uri_idx ON event_log(post_uri)`;
  yield* sql`CREATE INDEX IF NOT EXISTS event_log_source_idx ON event_log(source)`;
});
