import * as SqlClient from "@effect/sql/SqlClient";
import { Effect } from "effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE posts ADD COLUMN has_embed INTEGER NOT NULL DEFAULT 0`;
  yield* sql`UPDATE posts SET has_embed = CASE WHEN has_media = 1 OR is_quote = 1 THEN 1 ELSE 0 END`;
  yield* sql`CREATE INDEX IF NOT EXISTS posts_has_embed_idx ON posts(has_embed)`;
});
