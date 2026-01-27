import * as KeyValueStore from "@effect/platform/KeyValueStore";
import type { PlatformError } from "@effect/platform/Error";
import { Context, Effect, Layer, Option, Schema, Stream } from "effect";
import { StoreIndexError } from "../domain/errors.js";
import { PostEventRecord } from "../domain/events.js";
import type { PostEvent, StoreQuery } from "../domain/events.js";
import { PostIndexEntry, IndexCheckpoint } from "../domain/indexes.js";
import { PostUri, Timestamp } from "../domain/primitives.js";
import { Post } from "../domain/post.js";
import type { StoreRef } from "../domain/store.js";
import { StoreEventLog } from "./store-event-log.js";
import { storePrefix } from "./store-keys.js";

const indexListSchema = Schema.Array(PostUri);

const dateIndexKey = (date: string) => `indexes/by-date/${date}`;
const hashtagIndexKey = (tag: string) => `indexes/by-hashtag/${tag}`;
const uriIndexKey = (uri: PostUri) => `indexes/by-uri/${uri}`;
const postsByUriKey = (uri: PostUri) => `posts/by-uri/${uri}`;
const urisKey = "indexes/uris";
const checkpointKey = (name: string) => `checkpoints/indexes/${name}`;

const toStoreIndexError = (message: string) => (cause: unknown) =>
  StoreIndexError.make({ message, cause });

const upsertList = (
  store: KeyValueStore.SchemaStore<ReadonlyArray<PostUri>, never>,
  key: string,
  uri: PostUri
) =>
  store.get(key).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => store.set(key, [uri]),
        onSome: (current) =>
          current.includes(uri)
            ? Effect.void
            : store.set(key, [...current, uri])
      })
    )
  );

const removeFromList = (
  store: KeyValueStore.SchemaStore<ReadonlyArray<PostUri>, never>,
  key: string,
  uri: PostUri
) =>
  store.get(key).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.void,
        onSome: (current) => {
          const next = current.filter((value) => value !== uri);
          return next.length === 0 ? store.remove(key) : store.set(key, next);
        }
      })
    )
  );

const applyUpsert = (
  dateIndex: KeyValueStore.SchemaStore<ReadonlyArray<PostUri>, never>,
  hashtagIndex: KeyValueStore.SchemaStore<ReadonlyArray<PostUri>, never>,
  uriIndex: KeyValueStore.SchemaStore<PostIndexEntry, never>,
  postStore: KeyValueStore.SchemaStore<Post, never>,
  urisIndex: KeyValueStore.SchemaStore<ReadonlyArray<PostUri>, never>,
  event: Extract<PostEvent, { _tag: "PostUpsert" }>
) =>
  Effect.gen(function* () {
    const createdDate = event.post.createdAt.toISOString().slice(0, 10);
    const entry = PostIndexEntry.make({
      uri: event.post.uri,
      createdDate,
      hashtags: event.post.hashtags
    });

    yield* uriIndex.set(uriIndexKey(entry.uri), entry);
    yield* postStore.set(postsByUriKey(entry.uri), event.post);
    yield* upsertList(urisIndex, urisKey, entry.uri);
    yield* upsertList(dateIndex, dateIndexKey(entry.createdDate), entry.uri);
    yield* Effect.forEach(
      entry.hashtags,
      (tag) => upsertList(hashtagIndex, hashtagIndexKey(tag), entry.uri),
      { discard: true }
    );
  });

const applyDelete = (
  dateIndex: KeyValueStore.SchemaStore<ReadonlyArray<PostUri>, never>,
  hashtagIndex: KeyValueStore.SchemaStore<ReadonlyArray<PostUri>, never>,
  uriIndex: KeyValueStore.SchemaStore<PostIndexEntry, never>,
  postStore: KeyValueStore.SchemaStore<Post, never>,
  urisIndex: KeyValueStore.SchemaStore<ReadonlyArray<PostUri>, never>,
  event: Extract<PostEvent, { _tag: "PostDelete" }>
) =>
  Effect.gen(function* () {
    const existing = yield* uriIndex.get(uriIndexKey(event.uri));
    if (Option.isNone(existing)) {
      return;
    }
    const entry = existing.value;

    yield* removeFromList(dateIndex, dateIndexKey(entry.createdDate), entry.uri);
    yield* Effect.forEach(
      entry.hashtags,
      (tag) => removeFromList(hashtagIndex, hashtagIndexKey(tag), entry.uri),
      { discard: true }
    );
    yield* removeFromList(urisIndex, urisKey, entry.uri);
    yield* uriIndex.remove(uriIndexKey(entry.uri));
    yield* postStore.remove(postsByUriKey(entry.uri));
  });

const dateKeysInRange = (start: Date, end: Date): ReadonlyArray<string> => {
  const startUtc = Date.UTC(
    start.getUTCFullYear(),
    start.getUTCMonth(),
    start.getUTCDate()
  );
  const endUtc = Date.UTC(
    end.getUTCFullYear(),
    end.getUTCMonth(),
    end.getUTCDate()
  );
  if (Number.isNaN(startUtc) || Number.isNaN(endUtc) || startUtc > endUtc) {
    return [];
  }
  const dates: Array<string> = [];
  for (let ts = startUtc; ts <= endUtc; ts += 24 * 60 * 60 * 1000) {
    dates.push(new Date(ts).toISOString().slice(0, 10));
  }
  return dates;
};

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
    readonly rebuild: (
      store: StoreRef
    ) => Effect.Effect<void, StoreIndexError>;
  }
>() {
  static readonly layer = Layer.effect(
    StoreIndex,
    Effect.gen(function* () {
      const kv = yield* KeyValueStore.KeyValueStore;
      const dateIndex = kv.forSchema(indexListSchema);
      const hashtagIndex = kv.forSchema(indexListSchema);
      const uriIndex = kv.forSchema(PostIndexEntry);
      const postStore = kv.forSchema(Post);
      const urisIndex = kv.forSchema(indexListSchema);
      const checkpoints = kv.forSchema(IndexCheckpoint);
      const indexName = "primary";
      const eventLog = yield* StoreEventLog;
      const storeIndexes = (store: StoreRef) => {
        const prefix = storePrefix(store);
        return {
          dateIndex: KeyValueStore.prefix(dateIndex, prefix),
          hashtagIndex: KeyValueStore.prefix(hashtagIndex, prefix),
          uriIndex: KeyValueStore.prefix(uriIndex, prefix),
          postStore: KeyValueStore.prefix(postStore, prefix),
          urisIndex: KeyValueStore.prefix(urisIndex, prefix),
          checkpoints: KeyValueStore.prefix(checkpoints, prefix)
        };
      };

      const apply = Effect.fn("StoreIndex.apply")(
        (store: StoreRef, record: PostEventRecord) =>
          Effect.gen(function* () {
            const indexes = storeIndexes(store);
            if (record.event._tag === "PostUpsert") {
              yield* applyUpsert(
                indexes.dateIndex,
                indexes.hashtagIndex,
                indexes.uriIndex,
                indexes.postStore,
                indexes.urisIndex,
                record.event
              );
              return;
            }
            if (record.event._tag === "PostDelete") {
              yield* applyDelete(
                indexes.dateIndex,
                indexes.hashtagIndex,
                indexes.uriIndex,
                indexes.postStore,
                indexes.urisIndex,
                record.event
              );
            }
          }).pipe(Effect.mapError(toStoreIndexError("StoreIndex.apply failed")))
      );

      const getByDate = Effect.fn("StoreIndex.getByDate")(
        (store: StoreRef, date: string) =>
          storeIndexes(store).dateIndex
            .get(dateIndexKey(date))
            .pipe(
              Effect.map(Option.getOrElse(() => [] as ReadonlyArray<PostUri>)),
              Effect.mapError(toStoreIndexError("StoreIndex.getByDate failed"))
            )
      );

      const getByHashtag = Effect.fn("StoreIndex.getByHashtag")(
        (store: StoreRef, tag: string) =>
          storeIndexes(store).hashtagIndex
            .get(hashtagIndexKey(tag))
            .pipe(
              Effect.map(Option.getOrElse(() => [] as ReadonlyArray<PostUri>)),
              Effect.mapError(toStoreIndexError("StoreIndex.getByHashtag failed"))
            )
      );

      const getPost = Effect.fn("StoreIndex.getPost")((store: StoreRef, uri: PostUri) =>
        storeIndexes(store).postStore
          .get(postsByUriKey(uri))
          .pipe(Effect.mapError(toStoreIndexError("StoreIndex.getPost failed")))
      );

      const hasUri = Effect.fn("StoreIndex.hasUri")((store: StoreRef, uri: PostUri) =>
        getPost(store, uri).pipe(
          Effect.map(Option.isSome)
        )
      );

      const clear = Effect.fn("StoreIndex.clear")((store: StoreRef) =>
        Effect.gen(function* () {
          const indexes = storeIndexes(store);
          const removeIfExists = (effect: Effect.Effect<void, PlatformError>) =>
            effect.pipe(
              Effect.catchAll((error) =>
                error._tag === "SystemError" && error.reason === "NotFound"
                  ? Effect.void
                  : Effect.fail(error)
              )
            );
          const urisOption = yield* indexes.urisIndex
            .get(urisKey)
            .pipe(Effect.mapError(toStoreIndexError("StoreIndex.clear failed")));
          if (Option.isSome(urisOption)) {
            yield* Effect.forEach(
              urisOption.value,
              (uri) =>
                Effect.gen(function* () {
                  const entry = yield* indexes.uriIndex.get(uriIndexKey(uri));
                  if (Option.isSome(entry)) {
                    yield* removeFromList(
                      indexes.dateIndex,
                      dateIndexKey(entry.value.createdDate),
                      entry.value.uri
                    );
                    yield* Effect.forEach(
                      entry.value.hashtags,
                      (tag) =>
                        removeFromList(
                          indexes.hashtagIndex,
                          hashtagIndexKey(tag),
                          entry.value.uri
                        ),
                      { discard: true }
                    );
                  }
                  yield* removeIfExists(indexes.uriIndex.remove(uriIndexKey(uri)));
                  yield* removeIfExists(indexes.postStore.remove(postsByUriKey(uri)));
                }),
              { discard: true }
            );
            yield* removeIfExists(indexes.urisIndex.remove(urisKey));
          }
          yield* removeIfExists(indexes.checkpoints.remove(checkpointKey(indexName)));
        }).pipe(Effect.mapError(toStoreIndexError("StoreIndex.clear failed")))
      );

      const loadCheckpoint = Effect.fn("StoreIndex.loadCheckpoint")(
        (store: StoreRef, index: string) =>
          storeIndexes(store).checkpoints
            .get(checkpointKey(index))
            .pipe(
              Effect.mapError(toStoreIndexError("StoreIndex.loadCheckpoint failed"))
            )
      );

      const saveCheckpoint = Effect.fn("StoreIndex.saveCheckpoint")(
        (store: StoreRef, checkpoint: IndexCheckpoint) =>
          storeIndexes(store).checkpoints
            .set(checkpointKey(checkpoint.index), checkpoint)
            .pipe(
              Effect.mapError(toStoreIndexError("StoreIndex.saveCheckpoint failed"))
            )
      );

      const query = (store: StoreRef, query: StoreQuery) => {
        const indexes = storeIndexes(store);
        const baseStream = query.range
          ? Stream.fromIterable(dateKeysInRange(query.range.start, query.range.end)).pipe(
              Stream.mapEffect((date) =>
                indexes.dateIndex
                  .get(dateIndexKey(date))
                  .pipe(
                    Effect.map(Option.getOrElse(() => [] as ReadonlyArray<PostUri>)),
                    Effect.mapError(toStoreIndexError("StoreIndex.query failed"))
                  )
              ),
              Stream.mapConcat((uris) => uris)
            )
          : Stream.fromIterableEffect(
              indexes.urisIndex
                .get(urisKey)
                .pipe(
                  Effect.map(Option.getOrElse(() => [] as ReadonlyArray<PostUri>)),
                  Effect.mapError(toStoreIndexError("StoreIndex.query failed"))
                )
            );

        const postStream = baseStream.pipe(
          Stream.mapEffect((uri) =>
            indexes.postStore
              .get(postsByUriKey(uri))
              .pipe(Effect.mapError(toStoreIndexError("StoreIndex.query failed")))
          ),
          Stream.filterMap((post) => post)
        );

        return query.limit ? postStream.pipe(Stream.take(query.limit)) : postStream;
      };

      const rebuild = Effect.fn("StoreIndex.rebuild")((store: StoreRef) =>
        Effect.gen(function* () {
          const checkpoint = yield* loadCheckpoint(store, indexName);
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
                apply(store, record).pipe(
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

          yield* saveCheckpoint(store, nextCheckpoint);
        }).pipe(Effect.mapError(toStoreIndexError("StoreIndex.rebuild failed")))
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
        rebuild
      });
    })
  );
}
