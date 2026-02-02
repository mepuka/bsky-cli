import { describe, expect, test } from "bun:test";
import { Chunk, Effect, Layer, Option, Schema, Stream } from "effect";
import { FileSystem } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import { StoreIndex } from "../../src/services/store-index.js";
import { StoreEventLog } from "../../src/services/store-event-log.js";
import { StoreWriter } from "../../src/services/store-writer.js";
import { StoreDb } from "../../src/services/store-db.js";
import { AppConfigService, ConfigOverrides } from "../../src/services/app-config.js";
import { EventMeta, PostEventRecord, PostDelete, PostUpsert, StoreQuery } from "../../src/domain/events.js";
import { EventId, Timestamp } from "../../src/domain/primitives.js";
import { EmbedImage, EmbedImages } from "../../src/domain/bsky.js";
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
const emoji = "\u{1F642}";
const samplePostEmoji = Schema.decodeUnknownSync(Post)({
  uri: "at://did:plc:example/app.bsky.feed.post/3",
  author: "bob.bsky",
  text: `Emoji ${emoji} post`,
  createdAt: "2026-01-02T00:00:00.000Z",
  hashtags: ["#emoji"],
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
const imagePostWithAlt = Schema.decodeUnknownSync(Post)({
  uri: "at://did:plc:example/app.bsky.feed.post/4",
  author: "alice.bsky",
  text: "Image post with alt text",
  createdAt: "2026-01-04T00:00:00.000Z",
  hashtags: [],
  mentions: [],
  links: [],
  embed: EmbedImages.make({
    images: [
      EmbedImage.make({
        thumb: "https://example.com/thumb/1",
        fullsize: "https://example.com/full/1",
        alt: "Cat"
      }),
      EmbedImage.make({
        thumb: "https://example.com/thumb/2",
        fullsize: "https://example.com/full/2",
        alt: "Dog"
      })
    ]
  })
});
const imagePostMissingAlt = Schema.decodeUnknownSync(Post)({
  uri: "at://did:plc:example/app.bsky.feed.post/5",
  author: "bob.bsky",
  text: "Image post missing alt text",
  createdAt: "2026-01-05T00:00:00.000Z",
  hashtags: [],
  mentions: [],
  links: [],
  embed: EmbedImages.make({
    images: [
      EmbedImage.make({
        thumb: "https://example.com/thumb/3",
        fullsize: "https://example.com/full/3",
        alt: ""
      })
    ]
  })
});
const makeReplyPost = (
  uri: string,
  author: string,
  createdAt: string,
  rootUri: string,
  parentUri: string
) =>
  Schema.decodeUnknownSync(Post)({
    uri,
    author,
    text: `Reply ${uri}`,
    createdAt,
    hashtags: [],
    mentions: [],
    links: [],
    reply: {
      root: { uri: rootUri, cid: "cid-root" },
      parent: { uri: parentUri, cid: "cid-parent" }
    }
  });

const sampleMeta = Schema.decodeUnknownSync(EventMeta)({
  source: "timeline",
  command: "sync timeline",
  createdAt: "2026-01-01T00:00:00.000Z"
});

const sampleStore = Schema.decodeUnknownSync(StoreRef)({
  name: "arsenal",
  root: "stores/arsenal"
});

const eventId = Schema.decodeUnknownSync(EventId)("01ARZ3NDEKTSV4RRFFQ69G5FAV");
const rangeStart = Schema.decodeUnknownSync(Timestamp)("2026-01-01T00:00:00.000Z");
const rangeEnd = Schema.decodeUnknownSync(Timestamp)("2026-01-03T00:00:00.000Z");

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

describe("StoreIndex", () => {
  test("apply upsert updates date + hashtag indexes", async () => {
    const upsert = PostUpsert.make({ post: samplePost, meta: sampleMeta });
    const record = PostEventRecord.make({ id: eventId, version: 1, event: upsert });

    const program = Effect.gen(function* () {
      const storeIndex = yield* StoreIndex;

      yield* storeIndex.apply(sampleStore, record);

      const date = "2026-01-01";
      const byDate = yield* storeIndex.getByDate(sampleStore, date);
      const byTag = yield* storeIndex.getByHashtag(sampleStore, "#effect");
      const post = yield* storeIndex.getPost(sampleStore, samplePost.uri);

      return { byDate, byTag, post };
    });

    const tempDir = await makeTempDir();
    const layer = buildLayer(tempDir);
    try {
      const result = await Effect.runPromise(program.pipe(Effect.provide(layer)));

      expect(result.byDate).toEqual([samplePost.uri]);
      expect(result.byTag).toEqual([samplePost.uri]);
      expect(Option.isSome(result.post)).toBe(true);
    } finally {
      await removeTempDir(tempDir);
    }
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

      yield* storeIndex.apply(sampleStore, upsertRecord);
      yield* storeIndex.apply(sampleStore, deleteRecord);

      const byDate = yield* storeIndex.getByDate(sampleStore, "2026-01-01");
      const byTag = yield* storeIndex.getByHashtag(sampleStore, "#effect");
      const post = yield* storeIndex.getPost(sampleStore, samplePost.uri);

      return { byDate, byTag, post };
    });

    const tempDir = await makeTempDir();
    const layer = buildLayer(tempDir);
    try {
      const result = await Effect.runPromise(program.pipe(Effect.provide(layer)));

      expect(result.byDate).toEqual([]);
      expect(result.byTag).toEqual([]);
      expect(Option.isNone(result.post)).toBe(true);
    } finally {
      await removeTempDir(tempDir);
    }
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

    const tempDir = await makeTempDir();
    const layer = buildLayer(tempDir);
    try {
      const result = await Effect.runPromise(program.pipe(Effect.provide(layer)));

      expect(result.byDate).toEqual([samplePost.uri]);
      expect(result.byTag).toEqual([samplePost.uri]);
    } finally {
      await removeTempDir(tempDir);
    }
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
        scanLimit: 1
      });

      const collected = yield* storeIndex
        .query(sampleStore, query)
        .pipe(Stream.runCollect);

      return collected;
    });

    const tempDir = await makeTempDir();
    const layer = buildLayer(tempDir);
    try {
      const result = await Effect.runPromise(program.pipe(Effect.provide(layer)));
      expect(Chunk.toReadonlyArray(result)).toEqual([samplePost]);
    } finally {
      await removeTempDir(tempDir);
    }
  });

  test("query orders posts descending when requested", async () => {
    const upsert1 = PostUpsert.make({ post: samplePost, meta: sampleMeta });
    const upsert2 = PostUpsert.make({ post: samplePostLater, meta: sampleMeta });
    const program = Effect.gen(function* () {
      const writer = yield* StoreWriter;
      const storeIndex = yield* StoreIndex;

      yield* writer.append(sampleStore, upsert1);
      yield* writer.append(sampleStore, upsert2);
      yield* storeIndex.rebuild(sampleStore);

      const query = StoreQuery.make({ order: "desc" });
      const collected = yield* storeIndex
        .query(sampleStore, query)
        .pipe(Stream.runCollect);

      return collected;
    });

    const tempDir = await makeTempDir();
    const layer = buildLayer(tempDir);
    try {
      const result = await Effect.runPromise(program.pipe(Effect.provide(layer)));
      expect(Chunk.toReadonlyArray(result)).toEqual([samplePostLater, samplePost]);
    } finally {
      await removeTempDir(tempDir);
    }
  });

  test("query orders posts by engagement when requested", async () => {
    const postLow = Schema.decodeUnknownSync(Post)({
      uri: "at://did:plc:example/app.bsky.feed.post/10",
      author: "alice.bsky",
      text: "Low engagement",
      createdAt: "2026-01-01T00:00:00.000Z",
      hashtags: [],
      mentions: [],
      links: [],
      metrics: { likeCount: 2 }
    });
    const postMid = Schema.decodeUnknownSync(Post)({
      uri: "at://did:plc:example/app.bsky.feed.post/11",
      author: "bob.bsky",
      text: "Mid engagement",
      createdAt: "2026-01-02T00:00:00.000Z",
      hashtags: [],
      mentions: [],
      links: [],
      metrics: { repostCount: 2 }
    });
    const postHigh = Schema.decodeUnknownSync(Post)({
      uri: "at://did:plc:example/app.bsky.feed.post/12",
      author: "claire.bsky",
      text: "High engagement",
      createdAt: "2026-01-03T00:00:00.000Z",
      hashtags: [],
      mentions: [],
      links: [],
      metrics: { replyCount: 3, quoteCount: 1 }
    });

    const upserts = [
      PostUpsert.make({ post: postLow, meta: sampleMeta }),
      PostUpsert.make({ post: postMid, meta: sampleMeta }),
      PostUpsert.make({ post: postHigh, meta: sampleMeta })
    ];

    const program = Effect.gen(function* () {
      const writer = yield* StoreWriter;
      const storeIndex = yield* StoreIndex;

      for (const upsert of upserts) {
        yield* writer.append(sampleStore, upsert);
      }
      yield* storeIndex.rebuild(sampleStore);

      const query = StoreQuery.make({ sortBy: "engagement", order: "desc" });
      return yield* storeIndex.query(sampleStore, query).pipe(Stream.runCollect);
    });

    const tempDir = await makeTempDir();
    const layer = buildLayer(tempDir);
    try {
      const result = await Effect.runPromise(program.pipe(Effect.provide(layer)));
      const uris = Chunk.toReadonlyArray(result).map((post) => post.uri);
      expect(uris).toEqual([postHigh.uri, postMid.uri, postLow.uri]);
    } finally {
      await removeTempDir(tempDir);
    }
  });

  test("query applies SQL pushdown for author and hashtag filters", async () => {
    const upsert1 = PostUpsert.make({ post: samplePost, meta: sampleMeta });
    const upsert2 = PostUpsert.make({ post: samplePostLater, meta: sampleMeta });
    const program = Effect.gen(function* () {
      const writer = yield* StoreWriter;
      const storeIndex = yield* StoreIndex;

      yield* writer.append(sampleStore, upsert1);
      yield* writer.append(sampleStore, upsert2);
      yield* storeIndex.rebuild(sampleStore);

      const authorQuery = StoreQuery.make({
        filter: { _tag: "Author", handle: samplePost.author }
      });
      const hashtagQuery = StoreQuery.make({
        filter: { _tag: "Hashtag", tag: samplePostLater.hashtags[0]! }
      });

      const authorCollected = yield* storeIndex
        .query(sampleStore, authorQuery)
        .pipe(Stream.runCollect);
      const hashtagCollected = yield* storeIndex
        .query(sampleStore, hashtagQuery)
        .pipe(Stream.runCollect);

      return { authorCollected, hashtagCollected };
    });

    const tempDir = await makeTempDir();
    const layer = buildLayer(tempDir);
    try {
      const result = await Effect.runPromise(program.pipe(Effect.provide(layer)));
      expect(Chunk.toReadonlyArray(result.authorCollected)).toEqual([samplePost]);
      expect(Chunk.toReadonlyArray(result.hashtagCollected)).toEqual([samplePostLater]);
    } finally {
      await removeTempDir(tempDir);
    }
  });

  test("query applies SQL pushdown for image and alt text filters", async () => {
    const upserts = [
      PostUpsert.make({ post: imagePostWithAlt, meta: sampleMeta }),
      PostUpsert.make({ post: imagePostMissingAlt, meta: sampleMeta }),
      PostUpsert.make({ post: samplePost, meta: sampleMeta })
    ];

    const program = Effect.gen(function* () {
      const writer = yield* StoreWriter;
      const storeIndex = yield* StoreIndex;

      for (const upsert of upserts) {
        yield* writer.append(sampleStore, upsert);
      }
      yield* storeIndex.rebuild(sampleStore);

      const minImagesQuery = StoreQuery.make({
        filter: { _tag: "MinImages", min: 2 }
      });
      const hasAltQuery = StoreQuery.make({
        filter: { _tag: "HasAltText" }
      });
      const noAltQuery = StoreQuery.make({
        filter: { _tag: "NoAltText" }
      });
      const altTextQuery = StoreQuery.make({
        filter: { _tag: "AltText", text: "Cat" }
      });

      const minImages = yield* storeIndex
        .query(sampleStore, minImagesQuery)
        .pipe(Stream.runCollect);
      const hasAlt = yield* storeIndex
        .query(sampleStore, hasAltQuery)
        .pipe(Stream.runCollect);
      const noAlt = yield* storeIndex
        .query(sampleStore, noAltQuery)
        .pipe(Stream.runCollect);
      const altText = yield* storeIndex
        .query(sampleStore, altTextQuery)
        .pipe(Stream.runCollect);

      return { minImages, hasAlt, noAlt, altText };
    });

    const tempDir = await makeTempDir();
    const layer = buildLayer(tempDir);
    try {
      const result = await Effect.runPromise(program.pipe(Effect.provide(layer)));

      expect(Chunk.toReadonlyArray(result.minImages)).toEqual([imagePostWithAlt]);
      expect(Chunk.toReadonlyArray(result.hasAlt)).toEqual([imagePostWithAlt]);
      expect(Chunk.toReadonlyArray(result.noAlt)).toEqual([imagePostMissingAlt]);
      expect(Chunk.toReadonlyArray(result.altText)).toEqual([imagePostWithAlt]);
    } finally {
      await removeTempDir(tempDir);
    }
  });

  test("getByAuthor returns post URIs for a handle", async () => {
    const upsert1 = PostUpsert.make({ post: samplePost, meta: sampleMeta });
    const upsert2 = PostUpsert.make({ post: samplePostLater, meta: sampleMeta });
    const program = Effect.gen(function* () {
      const writer = yield* StoreWriter;
      const storeIndex = yield* StoreIndex;

      yield* writer.append(sampleStore, upsert1);
      yield* writer.append(sampleStore, upsert2);
      yield* storeIndex.rebuild(sampleStore);

      return yield* storeIndex.getByAuthor(sampleStore, samplePost.author);
    });

    const tempDir = await makeTempDir();
    const layer = buildLayer(tempDir);
    try {
      const result = await Effect.runPromise(program.pipe(Effect.provide(layer)));
      expect(result).toEqual([samplePost.uri]);
    } finally {
      await removeTempDir(tempDir);
    }
  });

  test("query skips OR pushdown when a clause is not SQL-pushdownable", async () => {
    const upsert1 = PostUpsert.make({ post: samplePost, meta: sampleMeta });
    const upsert2 = PostUpsert.make({ post: samplePostEmoji, meta: sampleMeta });
    const program = Effect.gen(function* () {
      const writer = yield* StoreWriter;
      const storeIndex = yield* StoreIndex;

      yield* writer.append(sampleStore, upsert1);
      yield* writer.append(sampleStore, upsert2);
      yield* storeIndex.rebuild(sampleStore);

      const query = StoreQuery.make({
        filter: {
          _tag: "Or",
          left: { _tag: "Author", handle: samplePost.author },
          right: { _tag: "Contains", text: emoji, caseSensitive: false }
        }
      });

      return yield* storeIndex.query(sampleStore, query).pipe(Stream.runCollect);
    });

    const tempDir = await makeTempDir();
    const layer = buildLayer(tempDir);
    try {
      const result = await Effect.runPromise(program.pipe(Effect.provide(layer)));
      expect(Chunk.toReadonlyArray(result)).toEqual([samplePost, samplePostEmoji]);
    } finally {
      await removeTempDir(tempDir);
    }
  });

  test("threadGroups groups posts by reply root", async () => {
    const rootA = Schema.decodeUnknownSync(Post)({
      uri: "at://did:plc:example/app.bsky.feed.post/201",
      author: "alice.bsky",
      text: "Root A",
      createdAt: "2026-01-01T00:00:00.000Z",
      hashtags: [],
      mentions: [],
      links: []
    });
    const replyA = makeReplyPost(
      "at://did:plc:example/app.bsky.feed.post/202",
      "bob.bsky",
      "2026-01-01T01:00:00.000Z",
      rootA.uri,
      rootA.uri
    );
    const rootB = Schema.decodeUnknownSync(Post)({
      uri: "at://did:plc:example/app.bsky.feed.post/203",
      author: "claire.bsky",
      text: "Root B",
      createdAt: "2026-01-02T00:00:00.000Z",
      hashtags: [],
      mentions: [],
      links: []
    });

    const program = Effect.gen(function* () {
      const storeIndex = yield* StoreIndex;

      const recordA = PostEventRecord.make({
        id: Schema.decodeUnknownSync(EventId)("01ARZ3NDEKTSV4RRFFQ69G5FBA"),
        version: 1,
        event: PostUpsert.make({ post: rootA, meta: sampleMeta })
      });
      const recordReply = PostEventRecord.make({
        id: Schema.decodeUnknownSync(EventId)("01ARZ3NDEKTSV4RRFFQ69G5FBB"),
        version: 1,
        event: PostUpsert.make({ post: replyA, meta: sampleMeta })
      });
      const recordB = PostEventRecord.make({
        id: Schema.decodeUnknownSync(EventId)("01ARZ3NDEKTSV4RRFFQ69G5FBC"),
        version: 1,
        event: PostUpsert.make({ post: rootB, meta: sampleMeta })
      });

      yield* storeIndex.apply(sampleStore, recordA);
      yield* storeIndex.apply(sampleStore, recordReply);
      yield* storeIndex.apply(sampleStore, recordB);

      return yield* storeIndex.threadGroups(sampleStore, StoreQuery.make({}));
    });

    const tempDir = await makeTempDir();
    const layer = buildLayer(tempDir);
    try {
      const result = await Effect.runPromise(program.pipe(Effect.provide(layer)));
      const byRoot = new Map(result.map((group) => [String(group.rootUri), group.count]));
      expect(byRoot.get(String(rootA.uri))).toBe(2);
      expect(byRoot.get(String(rootB.uri))).toBe(1);
    } finally {
      await removeTempDir(tempDir);
    }
  });

  test("clear ignores missing checkpoint files in filesystem stores", async () => {
    const tempDir = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.makeTempDirectory();
      }).pipe(Effect.provide(BunContext.layer))
    );

    const overrides = Layer.succeed(ConfigOverrides, { storeRoot: tempDir });
    const appConfigLayer = AppConfigService.layer.pipe(Layer.provide(overrides));
    const storeDbLayer = StoreDb.layer.pipe(Layer.provideMerge(appConfigLayer));
    const eventLogLayer = StoreEventLog.layer.pipe(Layer.provideMerge(storeDbLayer));
    const fsLayer = Layer.mergeAll(
      appConfigLayer,
      storeDbLayer,
      eventLogLayer,
      StoreIndex.layer.pipe(
        Layer.provideMerge(storeDbLayer),
        Layer.provideMerge(eventLogLayer)
      )
    ).pipe(Layer.provideMerge(BunContext.layer));

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
