import * as SqlClient from "@effect/sql/SqlClient";
import { Effect } from "effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE posts ADD COLUMN text TEXT NOT NULL DEFAULT ''`;
  yield* sql`ALTER TABLE posts ADD COLUMN lang TEXT`;
  yield* sql`ALTER TABLE posts ADD COLUMN is_reply INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE posts ADD COLUMN is_quote INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE posts ADD COLUMN is_repost INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE posts ADD COLUMN is_original INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE posts ADD COLUMN has_links INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE posts ADD COLUMN has_media INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE posts ADD COLUMN has_images INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE posts ADD COLUMN has_video INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE posts ADD COLUMN like_count INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE posts ADD COLUMN repost_count INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE posts ADD COLUMN reply_count INTEGER NOT NULL DEFAULT 0`;

  yield* sql`CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(
    text,
    content='posts',
    content_rowid='rowid'
  )`;

  yield* sql`CREATE TRIGGER IF NOT EXISTS posts_ai AFTER INSERT ON posts BEGIN
    INSERT INTO posts_fts(rowid, text) VALUES (new.rowid, new.text);
  END`;

  yield* sql`CREATE TRIGGER IF NOT EXISTS posts_ad AFTER DELETE ON posts BEGIN
    INSERT INTO posts_fts(posts_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
  END`;

  yield* sql`CREATE TRIGGER IF NOT EXISTS posts_au AFTER UPDATE ON posts BEGIN
    INSERT INTO posts_fts(posts_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
    INSERT INTO posts_fts(rowid, text) VALUES (new.rowid, new.text);
  END`;

  yield* sql`CREATE INDEX IF NOT EXISTS posts_lang_idx ON posts(lang)`;
  yield* sql`CREATE INDEX IF NOT EXISTS posts_is_reply_idx ON posts(is_reply)`;
  yield* sql`CREATE INDEX IF NOT EXISTS posts_is_quote_idx ON posts(is_quote)`;
  yield* sql`CREATE INDEX IF NOT EXISTS posts_is_repost_idx ON posts(is_repost)`;
  yield* sql`CREATE INDEX IF NOT EXISTS posts_is_original_idx ON posts(is_original)`;
  yield* sql`CREATE INDEX IF NOT EXISTS posts_has_links_idx ON posts(has_links)`;
  yield* sql`CREATE INDEX IF NOT EXISTS posts_has_media_idx ON posts(has_media)`;
  yield* sql`CREATE INDEX IF NOT EXISTS posts_has_images_idx ON posts(has_images)`;
  yield* sql`CREATE INDEX IF NOT EXISTS posts_has_video_idx ON posts(has_video)`;
  yield* sql`CREATE INDEX IF NOT EXISTS posts_like_count_idx ON posts(like_count)`;
  yield* sql`CREATE INDEX IF NOT EXISTS posts_repost_count_idx ON posts(repost_count)`;
  yield* sql`CREATE INDEX IF NOT EXISTS posts_reply_count_idx ON posts(reply_count)`;
});
