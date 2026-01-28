import { Effect, Schema } from "effect";
import type * as SqlClient from "@effect/sql/SqlClient";
import { StoreIndexError } from "../domain/errors.js";
import { Post } from "../domain/post.js";
import type { PostUri } from "../domain/primitives.js";

const toStoreIndexError = (message: string) => (cause: unknown) =>
  StoreIndexError.make({ message, cause });

const toIso = (value: Date | string) =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const encodePostJson = (post: Post) =>
  Schema.encode(Schema.parseJson(Post))(post).pipe(
    Effect.mapError(toStoreIndexError("StoreIndex.post encode failed"))
  );

export const upsertPost = (
  sql: SqlClient.SqlClient,
  post: Post
) =>
  Effect.gen(function* () {
    const createdAt = toIso(post.createdAt);
    const createdDate = createdAt.slice(0, 10);
    const postJson = yield* encodePostJson(post);

    yield* sql`INSERT INTO posts (uri, created_at, created_date, author, post_json)
      VALUES (${post.uri}, ${createdAt}, ${createdDate}, ${post.author}, ${postJson})
      ON CONFLICT(uri) DO UPDATE SET
        created_at = excluded.created_at,
        created_date = excluded.created_date,
        author = excluded.author,
        post_json = excluded.post_json`;

    yield* sql`DELETE FROM post_hashtag WHERE uri = ${post.uri}`;

    const tags = Array.from(new Set(post.hashtags));
    if (tags.length > 0) {
      const rows = tags.map((tag) => ({ uri: post.uri, tag }));
      yield* sql`INSERT INTO post_hashtag ${sql.insert(rows)}`;
    }
  });

export const insertPostIfMissing = (
  sql: SqlClient.SqlClient,
  post: Post
) =>
  Effect.gen(function* () {
    const createdAt = toIso(post.createdAt);
    const createdDate = createdAt.slice(0, 10);
    const postJson = yield* encodePostJson(post);

    const rows = yield* sql`INSERT INTO posts (uri, created_at, created_date, author, post_json)
      VALUES (${post.uri}, ${createdAt}, ${createdDate}, ${post.author}, ${postJson})
      ON CONFLICT(uri) DO NOTHING
      RETURNING uri`;

    if (rows.length === 0) {
      return false;
    }

    const tags = Array.from(new Set(post.hashtags));
    if (tags.length > 0) {
      const tagRows = tags.map((tag) => ({ uri: post.uri, tag }));
      yield* sql`INSERT INTO post_hashtag ${sql.insert(tagRows)}`;
    }

    return true;
  });

export const deletePost = (sql: SqlClient.SqlClient, uri: PostUri) =>
  sql`DELETE FROM posts WHERE uri = ${uri}`.pipe(Effect.asVoid);
