import { Chunk, Context, Effect, Layer, Option, Ref, Schema, Stream } from "effect";
import * as SqlClient from "@effect/sql/SqlClient";
import * as SqlSchema from "@effect/sql/SqlSchema";
import { StoreIndexError } from "../domain/errors.js";
import { PostEventRecord } from "../domain/events.js";
import type { PostEvent, StoreQuery } from "../domain/events.js";
import { IndexCheckpoint, PostIndexEntry } from "../domain/indexes.js";
import { EventId, Handle, PostUri, Timestamp } from "../domain/primitives.js";
import { Post } from "../domain/post.js";
import type { StoreRef } from "../domain/store.js";
import { StoreDb } from "./store-db.js";
import { StoreEventLog } from "./store-event-log.js";

const indexName = "primary";
const entryPageSize = 500;

const postUriRow = Schema.Struct({ uri: PostUri });
const postJsonRow = Schema.Struct({ post_json: Schema.String });
const postEntryRow = Schema.Struct({
  uri: PostUri,
  created_date: Schema.String,
  author: Schema.NullOr(Handle),
  hashtags: Schema.NullOr(Schema.String)
});
const checkpointRow = Schema.Struct({
  index_name: Schema.String,
  version: Schema.Number,
  last_event_id: EventId,
  event_count: Schema.Number,
  updated_at: Schema.String
});

const toStoreIndexError = (message: string) => (cause: unknown) =>
  cause instanceof StoreIndexError
    ? cause
    : StoreIndexError.make({ message, cause });

const encodePostJson = (post: Post) =>
  Schema.encode(Schema.parseJson(Post))(post);

const decodePostJson = (raw: string) =>
  Schema.decodeUnknown(Schema.parseJson(Post))(raw).pipe(
    Effect.mapError(toStoreIndexError("StoreIndex.post decode failed"))
  );

const decodeEntryRow = (row: typeof postEntryRow.Type) =>
  Schema.decodeUnknown(PostIndexEntry)({
    uri: row.uri,
    createdDate: row.created_date,
    hashtags: row.hashtags ? row.hashtags.split(",") : [],
    author: row.author ?? undefined
  }).pipe(Effect.mapError(toStoreIndexError("StoreIndex.entry decode failed")));

const decodeCheckpointRow = (row: typeof checkpointRow.Type) =>
  Schema.decodeUnknown(IndexCheckpoint)({
    index: row.index_name,
    version: row.version,
    lastEventId: row.last_event_id,
    eventCount: row.event_count,
    updatedAt: row.updated_at
  }).pipe(Effect.mapError(toStoreIndexError("StoreIndex.checkpoint decode failed")));

const toIso = (value: Date | string) =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const applyUpsert = (
  sql: SqlClient.SqlClient,
  event: Extract<PostEvent, { _tag: "PostUpsert" }>
) =>
  sql.withTransaction(
    Effect.gen(function* () {
      const createdAt = toIso(event.post.createdAt);
      const createdDate = createdAt.slice(0, 10);
      const postJson = yield* encodePostJson(event.post).pipe(
        Effect.mapError(toStoreIndexError("StoreIndex.post encode failed"))
      );

      yield* sql`INSERT INTO posts (uri, created_at, created_date, author, post_json)
        VALUES (${event.post.uri}, ${createdAt}, ${createdDate}, ${event.post.author}, ${postJson})
        ON CONFLICT(uri) DO UPDATE SET
          created_at = excluded.created_at,
          created_date = excluded.created_date,
          author = excluded.author,
          post_json = excluded.post_json`;

      yield* sql`DELETE FROM post_hashtag WHERE uri = ${event.post.uri}`;

      const tags = Array.from(new Set(event.post.hashtags));
      if (tags.length > 0) {
        const rows = tags.map((tag) => ({ uri: event.post.uri, tag }));
        yield* sql`INSERT INTO post_hashtag ${sql.insert(rows)}`;
      }
    })
  );

const applyDelete = (
  sql: SqlClient.SqlClient,
  event: Extract<PostEvent, { _tag: "PostDelete" }>
) =>
  sql.withTransaction(
    sql`DELETE FROM posts WHERE uri = ${event.uri}`.pipe(Effect.asVoid)
  );

export class StoreIndex extends Context.Tag("@skygent/StoreIndex")<
  StoreIndex,
  {
    readonly apply: (
      store: StoreRef,
      record: PostEventRecord
    ) => Effect.Effect<void, StoreIndexError>;
    readonly getByDate: (
      store: StoreRef,
      date: string
    ) => Effect.Effect<ReadonlyArray<PostUri>, StoreIndexError>;
    readonly getByHashtag: (
      store: StoreRef,
      tag: string
    ) => Effect.Effect<ReadonlyArray<PostUri>, StoreIndexError>;
    readonly getPost: (
      store: StoreRef,
      uri: PostUri
    ) => Effect.Effect<Option.Option<Post>, StoreIndexError>;
    readonly hasUri: (
      store: StoreRef,
      uri: PostUri
    ) => Effect.Effect<boolean, StoreIndexError>;
    readonly clear: (store: StoreRef) => Effect.Effect<void, StoreIndexError>;
    readonly loadCheckpoint: (
      store: StoreRef,
      index: string
    ) => Effect.Effect<Option.Option<IndexCheckpoint>, StoreIndexError>;
    readonly saveCheckpoint: (
      store: StoreRef,
      checkpoint: IndexCheckpoint
    ) => Effect.Effect<void, StoreIndexError>;
    readonly query: (
      store: StoreRef,
      query: StoreQuery
    ) => Stream.Stream<Post, StoreIndexError>;
    readonly entries: (store: StoreRef) => Stream.Stream<PostIndexEntry, StoreIndexError>;
    readonly count: (store: StoreRef) => Effect.Effect<number, StoreIndexError>;
    readonly rebuild: (
      store: StoreRef
    ) => Effect.Effect<void, StoreIndexError>;
  }
>() {
  static readonly layer = Layer.scoped(
    StoreIndex,
    Effect.gen(function* () {
      const eventLog = yield* StoreEventLog;
      const storeDb = yield* StoreDb;
      const bootstrapped = yield* Ref.make(new Set<string>());
      const withClient = <A, E>(
        store: StoreRef,
        message: string,
        run: (client: SqlClient.SqlClient) => Effect.Effect<A, E>
      ) =>
        storeDb
          .withClient(store, (client) =>
            Ref.modify(bootstrapped, (state) => {
              if (state.has(store.name)) {
                return [Effect.void, state] as const;
              }
              const next = new Set(state);
              next.add(store.name);
              return [bootstrapStore(store, client), next] as const;
            }).pipe(Effect.flatten, Effect.andThen(run(client)))
          )
          .pipe(Effect.mapError(toStoreIndexError(message)));

      const loadCheckpointWithClient = (client: SqlClient.SqlClient, index: string) => {
        const load = SqlSchema.findOne({
          Request: Schema.String,
          Result: checkpointRow,
          execute: (name) =>
            client`SELECT index_name, version, last_event_id, event_count, updated_at
              FROM index_checkpoints
              WHERE index_name = ${name}`
        });

        return load(index).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(Option.none()),
              onSome: (row) => decodeCheckpointRow(row).pipe(Effect.map(Option.some))
            })
          )
        );
      };

      const saveCheckpointWithClient = (client: SqlClient.SqlClient, checkpoint: IndexCheckpoint) => {
        const updatedAt = toIso(checkpoint.updatedAt);
        return client`INSERT INTO index_checkpoints (index_name, version, last_event_id, event_count, updated_at)
          VALUES (${checkpoint.index}, ${checkpoint.version}, ${checkpoint.lastEventId}, ${checkpoint.eventCount}, ${updatedAt})
          ON CONFLICT(index_name) DO UPDATE SET
            version = excluded.version,
            last_event_id = excluded.last_event_id,
            event_count = excluded.event_count,
            updated_at = excluded.updated_at`.pipe(Effect.asVoid);
      };

      const applyWithClient = (client: SqlClient.SqlClient, record: PostEventRecord) =>
        Effect.gen(function* () {
          if (record.event._tag === "PostUpsert") {
            yield* applyUpsert(client, record.event);
            return;
          }
          if (record.event._tag === "PostDelete") {
            yield* applyDelete(client, record.event);
          }
        });

      const rebuildWithClient = (store: StoreRef, client: SqlClient.SqlClient) =>
        Effect.gen(function* () {
          const checkpoint = yield* loadCheckpointWithClient(client, indexName);
          const lastEventId = Option.map(checkpoint, (value) => value.lastEventId);

          const stream = eventLog.stream(store).pipe(
            Stream.filter((record) =>
              Option.match(lastEventId, {
                onNone: () => true,
                onSome: (id) => record.id.localeCompare(id) > 0
              })
            )
          );

          const state = yield* stream.pipe(
            Stream.runFoldEffect(
              {
                count: 0,
                lastId: Option.none<PostEventRecord["id"]>()
              },
              (state, record) =>
                applyWithClient(client, record).pipe(
                  Effect.as({
                    count: state.count + 1,
                    lastId: Option.some(record.id)
                  })
                )
            )
          );

          if (state.count === 0 || Option.isNone(state.lastId)) {
            return;
          }

          const updatedAt = yield* Schema.decodeUnknown(Timestamp)(
            new Date().toISOString()
          );
          const nextCheckpoint = IndexCheckpoint.make({
            index: indexName,
            version: 1,
            lastEventId: state.lastId.value,
            eventCount: Option.match(checkpoint, {
              onNone: () => state.count,
              onSome: (value) => value.eventCount + state.count
            }),
            updatedAt
          });

          yield* saveCheckpointWithClient(client, nextCheckpoint);
        });

      const bootstrapStore = (store: StoreRef, client: SqlClient.SqlClient) =>
        Effect.gen(function* () {
          const countRows = yield* client`SELECT COUNT(*) as count FROM posts`;
          const count = Number(countRows[0]?.count ?? 0);
          if (count > 0) {
            return;
          }

          const lastEventId = yield* eventLog.getLastEventId(store);
          if (Option.isNone(lastEventId)) {
            return;
          }

          yield* rebuildWithClient(store, client);
        });

      const apply = Effect.fn("StoreIndex.apply")(
        (store: StoreRef, record: PostEventRecord) =>
          withClient(store, "StoreIndex.apply failed", (client) =>
            applyWithClient(client, record)
          )
      );

      const getByDate = Effect.fn("StoreIndex.getByDate")(
        (store: StoreRef, date: string) =>
          withClient(store, "StoreIndex.getByDate failed", (client) => {
            const find = SqlSchema.findAll({
              Request: Schema.String,
              Result: postUriRow,
              execute: (value) =>
                client`SELECT uri FROM posts WHERE created_date = ${value} ORDER BY created_at ASC`
            });

            return find(date).pipe(
              Effect.map((rows) => rows.map((row) => row.uri))
            );
          })
      );

      const getByHashtag = Effect.fn("StoreIndex.getByHashtag")(
        (store: StoreRef, tag: string) =>
          withClient(store, "StoreIndex.getByHashtag failed", (client) => {
            const find = SqlSchema.findAll({
              Request: Schema.String,
              Result: postUriRow,
              execute: (value) =>
                client`SELECT uri FROM post_hashtag WHERE tag = ${value} ORDER BY uri ASC`
            });

            return find(tag).pipe(
              Effect.map((rows) => rows.map((row) => row.uri))
            );
          })
      );

      const getPost = Effect.fn("StoreIndex.getPost")(
        (store: StoreRef, uri: PostUri) =>
          withClient(store, "StoreIndex.getPost failed", (client) => {
            const find = SqlSchema.findOne({
              Request: PostUri,
              Result: postJsonRow,
              execute: (value) =>
                client`SELECT post_json FROM posts WHERE uri = ${value}`
            });

            return find(uri).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.succeed(Option.none()),
                  onSome: (row) =>
                    decodePostJson(row.post_json).pipe(Effect.map(Option.some))
                })
              )
            );
          })
      );

      const hasUri = Effect.fn("StoreIndex.hasUri")((store: StoreRef, uri: PostUri) =>
        withClient(store, "StoreIndex.hasUri failed", (client) =>
          client`SELECT 1 FROM posts WHERE uri = ${uri} LIMIT 1`.pipe(
            Effect.map((rows) => rows.length > 0)
          )
        )
      );

      const clear = Effect.fn("StoreIndex.clear")((store: StoreRef) =>
        withClient(store, "StoreIndex.clear failed", (client) =>
          client.withTransaction(
            Effect.gen(function* () {
              yield* client`DELETE FROM post_hashtag`;
              yield* client`DELETE FROM posts`;
              yield* client`DELETE FROM index_checkpoints`;
            })
          )
        )
      );

      const loadCheckpoint = Effect.fn("StoreIndex.loadCheckpoint")(
        (store: StoreRef, index: string) =>
          withClient(store, "StoreIndex.loadCheckpoint failed", (client) =>
            loadCheckpointWithClient(client, index)
          )
      );

      const saveCheckpoint = Effect.fn("StoreIndex.saveCheckpoint")(
        (store: StoreRef, checkpoint: IndexCheckpoint) =>
          withClient(store, "StoreIndex.saveCheckpoint failed", (client) =>
            saveCheckpointWithClient(client, checkpoint)
          )
      );

      const query = (store: StoreRef, query: StoreQuery) =>
        Stream.unwrap(
          withClient(store, "StoreIndex.query failed", (client) => {
            const start = query.range ? toIso(query.range.start) : undefined;
            const end = query.range ? toIso(query.range.end) : undefined;

            const fetchRows = () => {
              if (query.range && query.limit) {
                return client`SELECT post_json FROM posts
                  WHERE created_at >= ${start} AND created_at <= ${end}
                  ORDER BY created_at ASC
                  LIMIT ${query.limit}`;
              }
              if (query.range) {
                return client`SELECT post_json FROM posts
                  WHERE created_at >= ${start} AND created_at <= ${end}
                  ORDER BY created_at ASC`;
              }
              if (query.limit) {
                return client`SELECT post_json FROM posts
                  ORDER BY created_at ASC
                  LIMIT ${query.limit}`;
              }
              return client`SELECT post_json FROM posts ORDER BY created_at ASC`;
            };

            return Effect.gen(function* () {
              const rows = yield* fetchRows();
              const decoded = yield* Schema.decodeUnknown(
                Schema.Array(postJsonRow)
              )(rows).pipe(
                Effect.mapError(toStoreIndexError("StoreIndex.query decode failed"))
              );
              const posts = yield* Effect.forEach(
                decoded,
                (row) => decodePostJson(row.post_json),
                { discard: false }
              );
              return Stream.fromIterable(posts);
            });
          })
        );

      const entries = (store: StoreRef) =>
        Stream.paginateChunkEffect(0, (offset) =>
          withClient(store, "StoreIndex.entries failed", (client) =>
            Effect.gen(function* () {
              const rows = yield* client`SELECT
                  p.uri as uri,
                  p.created_date as created_date,
                  p.author as author,
                  group_concat(h.tag) as hashtags
                FROM posts p
                LEFT JOIN post_hashtag h ON p.uri = h.uri
                GROUP BY p.uri
                ORDER BY p.created_at ASC
                LIMIT ${entryPageSize} OFFSET ${offset}`;

              const decoded = yield* Schema.decodeUnknown(
                Schema.Array(postEntryRow)
              )(rows).pipe(
                Effect.mapError(toStoreIndexError("StoreIndex.entries decode failed"))
              );

              const entries = yield* Effect.forEach(
                decoded,
                (row) => decodeEntryRow(row),
                { discard: false }
              );

              const next =
                entries.length < entryPageSize
                  ? Option.none<number>()
                  : Option.some(offset + entryPageSize);

              return [Chunk.fromIterable(entries), next] as const;
            })
          )
        );

      const count = Effect.fn("StoreIndex.count")((store: StoreRef) =>
        withClient(store, "StoreIndex.count failed", (client) =>
          client`SELECT COUNT(*) as count FROM posts`.pipe(
            Effect.map((rows) => Number(rows[0]?.count ?? 0))
          )
        )
      );

      const rebuild = Effect.fn("StoreIndex.rebuild")((store: StoreRef) =>
        withClient(store, "StoreIndex.rebuild failed", (client) =>
          rebuildWithClient(store, client)
        )
      );

      return StoreIndex.of({
        apply,
        getByDate,
        getByHashtag,
        getPost,
        hasUri,
        clear,
        loadCheckpoint,
        saveCheckpoint,
        query,
        entries,
        count,
        rebuild
      });
    })
  );
}
