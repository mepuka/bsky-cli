import * as SqlClient from "@effect/sql/SqlClient";
import { Effect } from "effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE posts ADD COLUMN image_count INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE posts ADD COLUMN alt_text TEXT NOT NULL DEFAULT ''`;
  yield* sql`ALTER TABLE posts ADD COLUMN has_alt_text INTEGER NOT NULL DEFAULT 0`;

  yield* sql`DROP TRIGGER IF EXISTS posts_ai`;
  yield* sql`DROP TRIGGER IF EXISTS posts_ad`;
  yield* sql`DROP TRIGGER IF EXISTS posts_au`;
  yield* sql`DROP TABLE IF EXISTS posts_fts`;

  yield* sql`CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(
    text,
    alt_text,
    content='posts',
    content_rowid='rowid'
  )`;

  yield* sql`CREATE TRIGGER IF NOT EXISTS posts_ai AFTER INSERT ON posts BEGIN
    INSERT INTO posts_fts(rowid, text, alt_text) VALUES (new.rowid, new.text, new.alt_text);
  END`;

  yield* sql`CREATE TRIGGER IF NOT EXISTS posts_ad AFTER DELETE ON posts BEGIN
    INSERT INTO posts_fts(posts_fts, rowid, text, alt_text)
    VALUES ('delete', old.rowid, old.text, old.alt_text);
  END`;

  yield* sql`CREATE TRIGGER IF NOT EXISTS posts_au AFTER UPDATE ON posts BEGIN
    INSERT INTO posts_fts(posts_fts, rowid, text, alt_text)
    VALUES ('delete', old.rowid, old.text, old.alt_text);
    INSERT INTO posts_fts(rowid, text, alt_text) VALUES (new.rowid, new.text, new.alt_text);
  END`;

  yield* sql`CREATE INDEX IF NOT EXISTS posts_image_count_idx ON posts(image_count)`;
  yield* sql`CREATE INDEX IF NOT EXISTS posts_has_alt_text_idx ON posts(has_alt_text)`;

  yield* sql`DELETE FROM post_hashtag`;
  yield* sql`DELETE FROM post_lang`;
  yield* sql`DELETE FROM posts`;
  yield* sql`DELETE FROM index_checkpoints WHERE index_name = 'primary'`;
});
