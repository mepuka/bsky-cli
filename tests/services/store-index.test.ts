import { describe, expect, test } from "bun:test";
import { Chunk, Effect, Layer, Option, Schema, Stream } from "effect";
import { FileSystem } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import * as KeyValueStore from "@effect/platform/KeyValueStore";
import { StoreIndex } from "../../src/services/store-index.js";
import { StoreEventLog } from "../../src/services/store-event-log.js";
import { StoreWriter } from "../../src/services/store-writer.js";
import { storePrefix } from "../../src/services/store-keys.js";
import { EventMeta, PostEventRecord, PostDelete, PostUpsert, StoreQuery } from "../../src/domain/events.js";
import { PostIndexEntry } from "../../src/domain/indexes.js";
import { EventId, Timestamp } from "../../src/domain/primitives.js";
import { Post } from "../../src/domain/post.js";
import { StoreRef } from "../../src/domain/store.js";

const samplePost = Schema.decodeUnknownSync(Post)({
  uri: "at://did:plc:example/app.bsky.feed.post/1",
  author: "alice.bsky",
  text: "Hello #effect",
  createdAt: "2026-01-01T00:00:00.000Z",
  hashtags: ["#effect"],
  mentions: [],
  links: []
});
const samplePostLater = Schema.decodeUnknownSync(Post)({
  uri: "at://did:plc:example/app.bsky.feed.post/2",
  author: "bob.bsky",
  text: "Later post",
  createdAt: "2026-01-03T00:00:00.000Z",
  hashtags: ["#later"],
  mentions: [],
  links: []
});

const sampleMeta = Schema.decodeUnknownSync(EventMeta)({
  source: "timeline",
  command: "sync timeline",
  createdAt: "2026-01-01T00:00:00.000Z"
});

const sampleStore = Schema.decodeUnknownSync(StoreRef)({
  name: "arsenal",
  root: "/tmp/arsenal"
});

const eventId = Schema.decodeUnknownSync(EventId)("01ARZ3NDEKTSV4RRFFQ69G5FAV");
const rangeStart = Schema.decodeUnknownSync(Timestamp)("2026-01-01T00:00:00.000Z");
const rangeEnd = Schema.decodeUnknownSync(Timestamp)("2026-01-03T00:00:00.000Z");

const testLayer = Layer.mergeAll(StoreIndex.layer, StoreWriter.layer).pipe(
  Layer.provideMerge(StoreEventLog.layer),
  Layer.provideMerge(KeyValueStore.layerMemory)
);

describe("StoreIndex", () => {
  test("apply upsert updates date + hashtag indexes", async () => {
    const upsert = PostUpsert.make({ post: samplePost, meta: sampleMeta });
    const record = PostEventRecord.make({ id: eventId, version: 1, event: upsert });

    const program = Effect.gen(function* () {
      const storeIndex = yield* StoreIndex;
      const kv = yield* KeyValueStore.KeyValueStore;
      const uriIndex = KeyValueStore.prefix(
        kv.forSchema(PostIndexEntry),
        storePrefix(sampleStore)
      );

      yield* storeIndex.apply(sampleStore, record);

      const date = "2026-01-01";
      const byDate = yield* storeIndex.getByDate(sampleStore, date);
      const byTag = yield* storeIndex.getByHashtag(sampleStore, "#effect");
      const uriEntry = yield* uriIndex.get(`indexes/by-uri/${samplePost.uri}`);
      const post = yield* storeIndex.getPost(sampleStore, samplePost.uri);

      return { byDate, byTag, uriEntry, post };
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(testLayer)));

    expect(result.byDate).toEqual([samplePost.uri]);
    expect(result.byTag).toEqual([samplePost.uri]);
    expect(Option.isSome(result.uriEntry)).toBe(true);
    expect(Option.isSome(result.post)).toBe(true);
  });

  test("apply delete removes index entries when metadata exists", async () => {
    const upsert = PostUpsert.make({ post: samplePost, meta: sampleMeta });
    const upsertRecord = PostEventRecord.make({
      id: eventId,
      version: 1,
      event: upsert
    });
    const deleteEvent = PostDelete.make({ uri: samplePost.uri, meta: sampleMeta });
    const deleteRecord = PostEventRecord.make({
      id: Schema.decodeUnknownSync(EventId)("01ARZ3NDEKTSV4RRFFQ69G5FAW"),
      version: 1,
      event: deleteEvent
    });

    const program = Effect.gen(function* () {
      const storeIndex = yield* StoreIndex;
      const kv = yield* KeyValueStore.KeyValueStore;
      const uriIndex = KeyValueStore.prefix(
        kv.forSchema(PostIndexEntry),
        storePrefix(sampleStore)
      );

      yield* storeIndex.apply(sampleStore, upsertRecord);
      yield* storeIndex.apply(sampleStore, deleteRecord);

      const byDate = yield* storeIndex.getByDate(sampleStore, "2026-01-01");
      const byTag = yield* storeIndex.getByHashtag(sampleStore, "#effect");
      const uriEntry = yield* uriIndex.get(`indexes/by-uri/${samplePost.uri}`);
      const post = yield* storeIndex.getPost(sampleStore, samplePost.uri);

      return { byDate, byTag, uriEntry, post };
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(testLayer)));

    expect(result.byDate).toEqual([]);
    expect(result.byTag).toEqual([]);
    expect(Option.isNone(result.uriEntry)).toBe(true);
    expect(Option.isNone(result.post)).toBe(true);
  });

  test("rebuild replays events from manifest into indexes", async () => {
    const upsert = PostUpsert.make({ post: samplePost, meta: sampleMeta });

    const program = Effect.gen(function* () {
      const writer = yield* StoreWriter;
      const storeIndex = yield* StoreIndex;

      yield* writer.append(sampleStore, upsert);
      yield* storeIndex.rebuild(sampleStore);

      const byDate = yield* storeIndex.getByDate(sampleStore, "2026-01-01");
      const byTag = yield* storeIndex.getByHashtag(sampleStore, "#effect");

      return { byDate, byTag };
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(testLayer)));

    expect(result.byDate).toEqual([samplePost.uri]);
    expect(result.byTag).toEqual([samplePost.uri]);
  });

  test("query returns posts in range and respects limit", async () => {
    const upsert1 = PostUpsert.make({ post: samplePost, meta: sampleMeta });
    const upsert2 = PostUpsert.make({ post: samplePostLater, meta: sampleMeta });
    const program = Effect.gen(function* () {
      const writer = yield* StoreWriter;
      const storeIndex = yield* StoreIndex;

      yield* writer.append(sampleStore, upsert1);
      yield* writer.append(sampleStore, upsert2);
      yield* storeIndex.rebuild(sampleStore);

      const query = StoreQuery.make({
        range: {
          start: rangeStart,
          end: rangeEnd
        },
        limit: 1
      });

      const collected = yield* storeIndex
        .query(sampleStore, query)
        .pipe(Stream.runCollect);

      return collected;
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(testLayer)));
    expect(Chunk.toReadonlyArray(result)).toEqual([samplePost]);
  });

  test("clear ignores missing checkpoint files in filesystem stores", async () => {
    const tempDir = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.makeTempDirectory();
      }).pipe(Effect.provide(BunContext.layer))
    );

    const fsLayer = StoreIndex.layer.pipe(
      Layer.provideMerge(StoreEventLog.layer),
      Layer.provideMerge(KeyValueStore.layerFileSystem(tempDir)),
      Layer.provideMerge(BunContext.layer)
    );

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const storeIndex = yield* StoreIndex;
          yield* storeIndex.clear(sampleStore);
        }).pipe(Effect.provide(fsLayer))
      );
    } finally {
      await Effect.runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.remove(tempDir, { recursive: true });
        }).pipe(Effect.provide(BunContext.layer))
      );
    }
  });
});
