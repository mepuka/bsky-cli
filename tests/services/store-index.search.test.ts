import { describe, expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";
import { FileSystem } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import { StoreIndex } from "../../src/services/store-index.js";
import { StoreEventLog } from "../../src/services/store-event-log.js";
import { StoreWriter } from "../../src/services/store-writer.js";
import { StoreDb } from "../../src/services/store-db.js";
import { AppConfigService, ConfigOverrides } from "../../src/services/app-config.js";
import { EventMeta, PostUpsert } from "../../src/domain/events.js";
import { Post } from "../../src/domain/post.js";
import { StoreRef } from "../../src/domain/store.js";

const sampleStore = Schema.decodeUnknownSync(StoreRef)({
  name: "search-store",
  root: "stores/search-store"
});

const makeMeta = (createdAt: string) =>
  Schema.decodeUnknownSync(EventMeta)({
    source: "timeline",
    command: "search",
    createdAt
  });

const postOne = Schema.decodeUnknownSync(Post)({
  uri: "at://did:plc:example/app.bsky.feed.post/10",
  author: "alice.bsky",
  text: "Hello search one",
  createdAt: "2026-01-01T00:00:00.000Z",
  hashtags: [],
  mentions: [],
  links: []
});

const postTwo = Schema.decodeUnknownSync(Post)({
  uri: "at://did:plc:example/app.bsky.feed.post/11",
  author: "bob.bsky",
  text: "Hello search two",
  createdAt: "2026-01-02T00:00:00.000Z",
  hashtags: [],
  mentions: [],
  links: []
});

const makeTempDir = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      return yield* fs.makeTempDirectory();
    }).pipe(Effect.provide(BunContext.layer))
  );

const removeTempDir = (path: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.remove(path, { recursive: true });
    }).pipe(Effect.provide(BunContext.layer))
  );

const buildLayer = (storeRoot: string) => {
  const overrides = Layer.succeed(ConfigOverrides, { storeRoot });
  const appConfigLayer = AppConfigService.layer.pipe(Layer.provide(overrides));
  const storeDbLayer = StoreDb.layer.pipe(Layer.provideMerge(appConfigLayer));
  const eventLogLayer = StoreEventLog.layer.pipe(Layer.provideMerge(storeDbLayer));
  const writerLayer = StoreWriter.layer.pipe(Layer.provideMerge(storeDbLayer));
  const indexLayer = StoreIndex.layer.pipe(
    Layer.provideMerge(storeDbLayer),
    Layer.provideMerge(eventLogLayer)
  );

  return Layer.mergeAll(
    appConfigLayer,
    storeDbLayer,
    eventLogLayer,
    writerLayer,
    indexLayer
  ).pipe(Layer.provideMerge(BunContext.layer));
};

describe("StoreIndex searchPosts", () => {
  test("search orders by newest and oldest", async () => {
    const program = Effect.gen(function* () {
      const writer = yield* StoreWriter;
      const index = yield* StoreIndex;

      yield* writer.append(sampleStore, PostUpsert.make({ post: postOne, meta: makeMeta("2026-01-01T00:00:00.000Z") }));
      yield* writer.append(sampleStore, PostUpsert.make({ post: postTwo, meta: makeMeta("2026-01-02T00:00:00.000Z") }));
      yield* index.rebuild(sampleStore);

      const newest = yield* index.searchPosts(sampleStore, {
        query: "hello",
        sort: "newest"
      });
      const oldest = yield* index.searchPosts(sampleStore, {
        query: "hello",
        sort: "oldest"
      });

      return { newest, oldest };
    });

    const tempDir = await makeTempDir();
    const layer = buildLayer(tempDir);
    try {
      const result = await Effect.runPromise(program.pipe(Effect.provide(layer)));
      expect(result.newest.posts.map((post) => post.uri)).toEqual([
        postTwo.uri,
        postOne.uri
      ]);
      expect(result.oldest.posts.map((post) => post.uri)).toEqual([
        postOne.uri,
        postTwo.uri
      ]);
    } finally {
      await removeTempDir(tempDir);
    }
  });

  test("search paginates with cursor offset", async () => {
    const program = Effect.gen(function* () {
      const writer = yield* StoreWriter;
      const index = yield* StoreIndex;

      yield* writer.append(sampleStore, PostUpsert.make({ post: postOne, meta: makeMeta("2026-01-01T00:00:00.000Z") }));
      yield* writer.append(sampleStore, PostUpsert.make({ post: postTwo, meta: makeMeta("2026-01-02T00:00:00.000Z") }));
      yield* index.rebuild(sampleStore);

      const first = yield* index.searchPosts(sampleStore, {
        query: "hello",
        limit: 1,
        sort: "oldest"
      });
      const second = yield* index.searchPosts(sampleStore, {
        query: "hello",
        limit: 1,
        sort: "oldest",
        cursor: first.cursor
      });

      return { first, second };
    });

    const tempDir = await makeTempDir();
    const layer = buildLayer(tempDir);
    try {
      const result = await Effect.runPromise(program.pipe(Effect.provide(layer)));
      expect(result.first.posts.map((post) => post.uri)).toEqual([postOne.uri]);
      expect(result.first.cursor).toBe(1);
      expect(result.second.posts.map((post) => post.uri)).toEqual([postTwo.uri]);
    } finally {
      await removeTempDir(tempDir);
    }
  });
});
