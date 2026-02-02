import * as SqlClient from "@effect/sql/SqlClient";
import { Effect } from "effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`ALTER TABLE posts ADD COLUMN quote_count INTEGER NOT NULL DEFAULT 0`;
  yield* sql`CREATE INDEX IF NOT EXISTS posts_quote_count_idx ON posts(quote_count)`;
});
