import * as SqlClient from "@effect/sql/SqlClient";
import { Effect } from "effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`CREATE INDEX IF NOT EXISTS posts_author_created_at_idx ON posts(author, created_at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS posts_created_at_uri_idx ON posts(created_at, uri)`;
});
