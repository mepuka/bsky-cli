import * as SqlClient from "@effect/sql/SqlClient";
import { Effect } from "effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE posts ADD COLUMN reply_parent_uri TEXT`;
  yield* sql`ALTER TABLE posts ADD COLUMN reply_root_uri TEXT`;
  yield* sql`CREATE INDEX IF NOT EXISTS posts_reply_parent_uri_idx ON posts(reply_parent_uri)`;
  yield* sql`CREATE INDEX IF NOT EXISTS posts_reply_root_uri_idx ON posts(reply_root_uri)`;
});
