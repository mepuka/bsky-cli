import * as SqlClient from "@effect/sql/SqlClient";
import { Effect } from "effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`DROP TABLE IF EXISTS event_log_new`;
  yield* sql`CREATE TABLE IF NOT EXISTS event_log_new (
    event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    post_uri TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    source TEXT NOT NULL
  )`;
  yield* sql`INSERT INTO event_log_new (event_seq, event_id, event_type, post_uri, payload_json, created_at, source)
    SELECT rowid, event_id, event_type, post_uri, payload_json, created_at, source
    FROM event_log
    ORDER BY rowid`;
  yield* sql`DROP TABLE event_log`;
  yield* sql`ALTER TABLE event_log_new RENAME TO event_log`;
  yield* sql`CREATE INDEX IF NOT EXISTS event_log_created_at_idx ON event_log(created_at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS event_log_post_uri_idx ON event_log(post_uri)`;
  yield* sql`CREATE INDEX IF NOT EXISTS event_log_source_idx ON event_log(source)`;

  yield* sql`ALTER TABLE index_checkpoints RENAME TO index_checkpoints_old`;
  yield* sql`CREATE TABLE IF NOT EXISTS index_checkpoints (
    index_name TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    last_event_seq INTEGER NOT NULL,
    event_count INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`INSERT INTO index_checkpoints (index_name, version, last_event_seq, event_count, updated_at)
    SELECT index_name,
      version,
      COALESCE((SELECT event_seq FROM event_log WHERE event_id = index_checkpoints_old.last_event_id), 0),
      event_count,
      updated_at
    FROM index_checkpoints_old`;
  yield* sql`DROP TABLE index_checkpoints_old`;

  yield* sql`CREATE TABLE IF NOT EXISTS sync_checkpoints (
    source_key TEXT PRIMARY KEY,
    source_json TEXT NOT NULL,
    cursor TEXT,
    last_event_seq INTEGER,
    filter_hash TEXT,
    updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS sync_checkpoints_updated_at_idx ON sync_checkpoints(updated_at)`;

  yield* sql`CREATE TABLE IF NOT EXISTS derivation_checkpoints (
    view_name TEXT NOT NULL,
    source_store TEXT NOT NULL,
    target_store TEXT NOT NULL,
    filter_hash TEXT NOT NULL,
    evaluation_mode TEXT NOT NULL,
    last_source_event_seq INTEGER,
    events_processed INTEGER NOT NULL,
    events_matched INTEGER NOT NULL,
    deletes_propagated INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (view_name, source_store)
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS derivation_checkpoints_updated_at_idx ON derivation_checkpoints(updated_at)`;
});
