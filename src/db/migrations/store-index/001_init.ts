import * as SqlClient from "@effect/sql/SqlClient";
import { Effect } from "effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`CREATE TABLE IF NOT EXISTS posts (
    uri TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    created_date TEXT NOT NULL,
    author TEXT,
    post_json TEXT NOT NULL
  )`;

  yield* sql`CREATE TABLE IF NOT EXISTS post_hashtag (
    uri TEXT NOT NULL,
    tag TEXT NOT NULL,
    PRIMARY KEY (uri, tag),
    FOREIGN KEY (uri) REFERENCES posts(uri) ON DELETE CASCADE
  )`;

  yield* sql`CREATE TABLE IF NOT EXISTS index_checkpoints (
    index_name TEXT PRIMARY KEY,
    version INTEGER NOT NULL,
    last_event_id TEXT NOT NULL,
    event_count INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  )`;

  yield* sql`CREATE INDEX IF NOT EXISTS posts_created_date_idx ON posts(created_date)`;
  yield* sql`CREATE INDEX IF NOT EXISTS posts_created_at_idx ON posts(created_at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS posts_author_idx ON posts(author)`;
  yield* sql`CREATE INDEX IF NOT EXISTS post_hashtag_tag_idx ON post_hashtag(tag)`;
});
