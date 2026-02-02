import { describe, expect, test } from "bun:test";
import { Chunk, Effect, Layer, Schema } from "effect";
import { FileSystem } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import { GraphBuilder } from "../../src/services/graph-builder.js";
import { StoreIndex } from "../../src/services/store-index.js";
import { StoreEventLog } from "../../src/services/store-event-log.js";
import { StoreDb } from "../../src/services/store-db.js";
import { AppConfigService, ConfigOverrides } from "../../src/services/app-config.js";
import { FilterRuntime } from "../../src/services/filter-runtime.js";
import { EventMeta, PostEventRecord, PostUpsert, StoreQuery } from "../../src/domain/events.js";
import { EventId } from "../../src/domain/primitives.js";
import { EmbedRecord, EmbedRecordView, FeedContext, FeedReasonRepost, ProfileBasic } from "../../src/domain/bsky.js";
import { Post } from "../../src/domain/post.js";
import { StoreRef } from "../../src/domain/store.js";

const sampleMeta = Schema.decodeUnknownSync(EventMeta)({
  source: "timeline",
  command: "sync timeline",
  createdAt: "2026-02-01T00:00:00.000Z"
});

const sampleStore = Schema.decodeUnknownSync(StoreRef)({
  name: "graph-test",
  root: "stores/graph-test"
});

const eventId = (value: string) => Schema.decodeUnknownSync(EventId)(value);

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

const filterRuntimeLayer = Layer.succeed(
  FilterRuntime,
  FilterRuntime.of({
    evaluate: () => Effect.die("unused"),
    evaluateWithMetadata: () => Effect.die("unused"),
    evaluateBatch: () =>
      Effect.succeed((posts: Chunk.Chunk<Post>) => Effect.succeed(Chunk.map(posts, () => true))),
    explain: () => Effect.die("unused")
  })
);

const buildLayer = (storeRoot: string) => {
  const overrides = Layer.succeed(ConfigOverrides, { storeRoot });
  const appConfigLayer = AppConfigService.layer.pipe(Layer.provide(overrides));
  const storeDbLayer = StoreDb.layer.pipe(Layer.provideMerge(appConfigLayer));
  const eventLogLayer = StoreEventLog.layer.pipe(Layer.provideMerge(storeDbLayer));
  const indexLayer = StoreIndex.layer.pipe(
    Layer.provideMerge(storeDbLayer),
    Layer.provideMerge(eventLogLayer)
  );
  const graphBuilderLayer = GraphBuilder.layer.pipe(
    Layer.provideMerge(indexLayer),
    Layer.provideMerge(filterRuntimeLayer)
  );

  return Layer.mergeAll(
    appConfigLayer,
    storeDbLayer,
    eventLogLayer,
    indexLayer,
    filterRuntimeLayer,
    graphBuilderLayer
  ).pipe(Layer.provideMerge(BunContext.layer));
};

describe("GraphBuilder", () => {
  test("buildInteractionNetwork creates interaction edges", async () => {
    const aliceDid = "did:plc:alice";
    const bobDid = "did:plc:bob";
    const carolDid = "did:plc:carol";
    const daveDid = "did:plc:dave";
    const eveDid = "did:plc:eve";

    const rootPost = Schema.decodeUnknownSync(Post)({
      uri: "at://did:plc:alice/app.bsky.feed.post/1",
      author: "alice.bsky",
      authorDid: aliceDid,
      text: "Root post",
      createdAt: "2026-02-01T00:00:00.000Z",
      hashtags: [],
      mentions: [],
      links: []
    });
    const replyPost = Schema.decodeUnknownSync(Post)({
      uri: "at://did:plc:bob/app.bsky.feed.post/2",
      author: "bob.bsky",
      authorDid: bobDid,
      text: "Reply",
      createdAt: "2026-02-01T01:00:00.000Z",
      hashtags: [],
      mentions: [],
      links: [],
      reply: {
        root: { uri: rootPost.uri, cid: "cid-root" },
        parent: { uri: rootPost.uri, cid: "cid-parent" }
      }
    });

    const quotedAuthor = Schema.decodeUnknownSync(ProfileBasic)({
      did: aliceDid,
      handle: "alice.bsky"
    });
    const recordView = EmbedRecordView.make({
      uri: rootPost.uri,
      cid: "cid-quote",
      author: quotedAuthor,
      value: {},
      indexedAt: new Date("2026-02-01T00:00:00.000Z")
    });
    const quoteEmbed = EmbedRecord.make({ record: recordView });
    const quotePost = Schema.decodeUnknownSync(Post)({
      uri: "at://did:plc:carol/app.bsky.feed.post/3",
      author: "carol.bsky",
      authorDid: carolDid,
      text: "Quote",
      createdAt: "2026-02-01T02:00:00.000Z",
      hashtags: [],
      mentions: [],
      links: [],
      embed: quoteEmbed
    });

    const mentionPost = Schema.decodeUnknownSync(Post)({
      uri: "at://did:plc:dave/app.bsky.feed.post/4",
      author: "dave.bsky",
      authorDid: daveDid,
      text: "Hello @alice and @bob",
      createdAt: "2026-02-01T03:00:00.000Z",
      hashtags: [],
      mentions: ["alice.bsky", "bob.bsky"],
      mentionDids: [aliceDid, bobDid],
      links: []
    });

    const repostReason = FeedReasonRepost.make({
      by: Schema.decodeUnknownSync(ProfileBasic)({
        did: eveDid,
        handle: "eve.bsky"
      }),
      indexedAt: new Date("2026-02-01T04:00:00.000Z")
    });
    const repostPost = Schema.decodeUnknownSync(Post)({
      uri: "at://did:plc:alice/app.bsky.feed.post/5",
      author: "alice.bsky",
      authorDid: aliceDid,
      text: "Repost context",
      createdAt: "2026-02-01T04:00:00.000Z",
      hashtags: [],
      mentions: [],
      links: [],
      feed: FeedContext.make({ reason: repostReason })
    });

    const program = Effect.gen(function* () {
      const storeIndex = yield* StoreIndex;
      const builder = yield* GraphBuilder;

      const records = [
        PostEventRecord.make({
          id: eventId("01ARZ3NDEKTSV4RRFFQ69G5FGA"),
          version: 1,
          event: PostUpsert.make({ post: rootPost, meta: sampleMeta })
        }),
        PostEventRecord.make({
          id: eventId("01ARZ3NDEKTSV4RRFFQ69G5FGB"),
          version: 1,
          event: PostUpsert.make({ post: replyPost, meta: sampleMeta })
        }),
        PostEventRecord.make({
          id: eventId("01ARZ3NDEKTSV4RRFFQ69G5FGC"),
          version: 1,
          event: PostUpsert.make({ post: quotePost, meta: sampleMeta })
        }),
        PostEventRecord.make({
          id: eventId("01ARZ3NDEKTSV4RRFFQ69G5FGD"),
          version: 1,
          event: PostUpsert.make({ post: mentionPost, meta: sampleMeta })
        }),
        PostEventRecord.make({
          id: eventId("01ARZ3NDEKTSV4RRFFQ69G5FGE"),
          version: 1,
          event: PostUpsert.make({ post: repostPost, meta: sampleMeta })
        })
      ];

      for (const record of records) {
        yield* storeIndex.apply(sampleStore, record);
      }

      return yield* builder.buildInteractionNetwork(sampleStore, {
        query: StoreQuery.make({})
      });
    });

    const tempDir = await makeTempDir();
    const layer = buildLayer(tempDir);
    try {
      const snapshot = await Effect.runPromise(program.pipe(Effect.provide(layer)));
      const edgeMap = new Map(
        snapshot.edges.map((edge) => [
          `${edge.from}|${edge.to}|${edge.type}`,
          edge.weight ?? 0
        ])
      );
      expect(edgeMap.get(`${bobDid}|${aliceDid}|reply`)).toBe(1);
      expect(edgeMap.get(`${carolDid}|${aliceDid}|quote`)).toBe(1);
      expect(edgeMap.get(`${daveDid}|${aliceDid}|mention`)).toBe(1);
      expect(edgeMap.get(`${daveDid}|${bobDid}|mention`)).toBe(1);
      expect(edgeMap.get(`${eveDid}|${aliceDid}|repost`)).toBe(1);
    } finally {
      await removeTempDir(tempDir);
    }
  });
});
