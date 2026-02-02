import { describe, expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";
import { FileSystem } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import { AppConfigService, ConfigOverrides } from "../../src/services/app-config.js";
import { StoreDb } from "../../src/services/store-db.js";
import { StoreEventLog } from "../../src/services/store-event-log.js";
import { StoreWriter } from "../../src/services/store-writer.js";
import { StoreIndex } from "../../src/services/store-index.js";
import { StoreAnalytics } from "../../src/services/store-analytics.js";
import { Timestamp } from "../../src/domain/primitives.js";
import { EventMeta, PostUpsert } from "../../src/domain/events.js";
import { StoreRef } from "../../src/domain/store.js";
import { Post } from "../../src/domain/post.js";
import { PostMetrics } from "../../src/domain/bsky.js";

const sampleStore = Schema.decodeUnknownSync(StoreRef)({
  name: "analytics",
  root: "stores/analytics"
});

const sampleMeta = Schema.decodeUnknownSync(EventMeta)({
  source: "timeline",
  command: "sync timeline",
  createdAt: "2026-02-01T00:00:00.000Z"
});


const makePost = (
  uri: string,
  author: string,
  createdAt: string,
  metrics: { likeCount: number; repostCount: number; replyCount: number; quoteCount: number }
) =>
  Schema.decodeUnknownSync(Post)({
    uri,
    author,
    text: "Analytics post",
    createdAt,
    hashtags: [],
    mentions: [],
    links: [],
    metrics: PostMetrics.make(metrics)
  });

const post1 = makePost(
  "at://did:plc:example/app.bsky.feed.post/1",
  "alice.bsky",
  "2026-02-01T10:15:00.000Z",
  { likeCount: 2, repostCount: 1, replyCount: 0, quoteCount: 0 }
);
const post2 = makePost(
  "at://did:plc:example/app.bsky.feed.post/2",
  "bob.bsky",
  "2026-02-01T10:55:00.000Z",
  { likeCount: 1, repostCount: 0, replyCount: 1, quoteCount: 1 }
);
const post3 = makePost(
  "at://did:plc:example/app.bsky.feed.post/3",
  "alice.bsky",
  "2026-02-01T11:05:00.000Z",
  { likeCount: 5, repostCount: 1, replyCount: 2, quoteCount: 0 }
);

const makeUpsert = (post: Post) => PostUpsert.make({ post, meta: sampleMeta });

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
  const analyticsLayer = StoreAnalytics.layer.pipe(
    Layer.provideMerge(storeDbLayer)
  );

  return Layer.mergeAll(
    appConfigLayer,
    storeDbLayer,
    eventLogLayer,
    writerLayer,
    indexLayer,
    analyticsLayer
  ).pipe(Layer.provideMerge(BunContext.layer));
};

describe("StoreAnalytics", () => {
  test("timeBuckets groups posts by hour with metrics", async () => {
    const program = Effect.gen(function* () {
      const writer = yield* StoreWriter;
      const index = yield* StoreIndex;
      const analytics = yield* StoreAnalytics;

      yield* writer.append(sampleStore, makeUpsert(post1));
      yield* writer.append(sampleStore, makeUpsert(post2));
      yield* writer.append(sampleStore, makeUpsert(post3));
      yield* index.rebuild(sampleStore);

      const start = Schema.decodeUnknownSync(Timestamp)("2026-02-01T10:00:00.000Z");
      const end = Schema.decodeUnknownSync(Timestamp)("2026-02-01T12:00:00.000Z");

      return yield* analytics.timeBuckets(sampleStore, {
        unit: "hour",
        metrics: ["posts", "authors", "likes", "reposts", "replies", "quotes", "engagement"],
        range: { start, end }
      });
    });

    const tempDir = await makeTempDir();
    try {
      const layer = buildLayer(tempDir);
      const result = await Effect.runPromise(program.pipe(Effect.provide(layer)));
      expect(result.unit).toBe("hour");
      expect(result.buckets).toEqual([
        {
          bucket: "2026-02-01T10:00:00Z",
          posts: 2,
          authors: 2,
          likes: 3,
          reposts: 1,
          replies: 1,
          quotes: 1,
          engagement: 10
        },
        {
          bucket: "2026-02-01T11:00:00Z",
          posts: 1,
          authors: 1,
          likes: 5,
          reposts: 1,
          replies: 2,
          quotes: 0,
          engagement: 13
        }
      ]);
    } finally {
      await removeTempDir(tempDir);
    }
  });

  test("timeBuckets groups posts by day", async () => {
    const program = Effect.gen(function* () {
      const writer = yield* StoreWriter;
      const index = yield* StoreIndex;
      const analytics = yield* StoreAnalytics;

      yield* writer.append(sampleStore, makeUpsert(post1));
      yield* writer.append(sampleStore, makeUpsert(post2));
      yield* index.rebuild(sampleStore);

      return yield* analytics.timeBuckets(sampleStore, {
        unit: "day",
        metrics: ["posts", "authors"],
        range: { start: post1.createdAt, end: post2.createdAt }
      });
    });

    const tempDir = await makeTempDir();
    try {
      const layer = buildLayer(tempDir);
      const result = await Effect.runPromise(program.pipe(Effect.provide(layer)));
      expect(result.buckets).toEqual([
        { bucket: "2026-02-01", posts: 2, authors: 2 }
      ]);
    } finally {
      await removeTempDir(tempDir);
    }
  });
});
