import * as SqlClient from "@effect/sql/SqlClient";
import { Effect } from "effect";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`CREATE TABLE IF NOT EXISTS post_lang (
    uri TEXT NOT NULL,
    lang TEXT NOT NULL,
    PRIMARY KEY (uri, lang),
    FOREIGN KEY (uri) REFERENCES posts(uri) ON DELETE CASCADE
  )`;

  yield* sql`CREATE INDEX IF NOT EXISTS post_lang_lang_uri_idx ON post_lang(lang, uri)`;
});
