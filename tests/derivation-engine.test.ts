import { test, expect, describe } from "bun:test";
import { Effect, Layer, Option } from "effect";
import * as KeyValueStore from "@effect/platform/KeyValueStore";
import { DerivationEngine } from "../src/services/derivation-engine.js";
import { StoreEventLog } from "../src/services/store-event-log.js";
import { StoreWriter } from "../src/services/store-writer.js";
import { StoreIndex } from "../src/services/store-index.js";
import { FilterRuntime } from "../src/services/filter-runtime.js";
import { FilterCompiler } from "../src/services/filter-compiler.js";
import { ViewCheckpointStore } from "../src/services/view-checkpoint-store.js";
import { LineageStore } from "../src/services/lineage-store.js";
import { StoreRef } from "../src/domain/store.js";
import { all } from "../src/domain/filter.js";
import type { FilterExpr } from "../src/domain/filter.js";
import { EventMeta, PostDelete, PostUpsert } from "../src/domain/events.js";
import { Post } from "../src/domain/post.js";
import { Hashtag, PostCid, PostUri, Timestamp } from "../src/domain/primitives.js";
import { LlmDecision } from "../src/services/llm.js";
import { LinkValidator } from "../src/services/link-validator.js";
import { TrendingTopics } from "../src/services/trending-topics.js";

// Mock services
const MockLlmDecision = Layer.succeed(LlmDecision, {
  decide: () => Effect.succeed(true),
  decideDetailed: () =>
    Effect.succeed({
      keep: true,
      confidence: 0.9,
      modelId: "test-model",
      promptHash: "test-hash"
    })
});

const MockLinkValidator = Layer.succeed(LinkValidator, {
  hasValidLink: () => Effect.succeed(true)
});

const MockTrendingTopics = Layer.succeed(TrendingTopics, {
  isTrending: () => Effect.succeed(true)
});

// Build all layers with proper dependencies
const AllLayers = Layer.mergeAll(
  KeyValueStore.layerMemory,
  StoreEventLog.layer,
  StoreWriter.layer,
  StoreIndex.layer,
  FilterCompiler.layer,
  ViewCheckpointStore.layer,
  LineageStore.layer,
  MockLlmDecision,
  MockLinkValidator,
  MockTrendingTopics
).pipe(
  Layer.provideMerge(FilterRuntime.layer),
  Layer.provideMerge(DerivationEngine.layer)
);

const TestLayer = AllLayers;

const createTestPost = (uri: string, text: string, hashtags: ReadonlyArray<string> = []): Post =>
  Post.make({
    uri: PostUri.make(uri),
    cid: PostCid.make("test-cid"),
    text,
    author: "test.bsky.social",
    authorDid: "did:plc:test",
    createdAt: Timestamp.make(new Date("2024-01-01T00:00:00Z")),
    hashtags: hashtags.map((tag) => Hashtag.make(tag)),
    mentions: [],
    links: []
  });

const createTestMeta = (): EventMeta =>
  EventMeta.make({
    source: "timeline",
    command: "test",
    createdAt: Timestamp.make(new Date("2024-01-01T00:00:00Z"))
  });

describe("DerivationEngine", () => {
  const sourceRef = StoreRef.make({ name: "source", root: "/tmp/source" });
  const targetRef = StoreRef.make({ name: "target", root: "/tmp/target" });

  test("EventTime mode rejects Llm filters", () =>
    Effect.gen(function* () {
      const engine = yield* DerivationEngine;
      const filter: FilterExpr = { _tag: "Llm", prompt: "test", minConfidence: 0.8, onError: { _tag: "Exclude" } };

      const result = yield* engine.derive(sourceRef, targetRef, filter, {
        mode: "EventTime",
        reset: false
      }).pipe(Effect.either);

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        const error = result.left;
        expect(error._tag).toBe("DerivationError");
        if (error._tag === "DerivationError") {
          expect(error.reason).toContain("EventTime mode only supports pure filters");
        }
      }
    }).pipe(Effect.provide(TestLayer), Effect.runPromise)
  );

  test("EventTime mode accepts pure filters", () =>
    Effect.gen(function* () {
      const engine = yield* DerivationEngine;
      const writer = yield* StoreWriter;
      const index = yield* StoreIndex;
      const filter: FilterExpr = { _tag: "Author", handle: "test.bsky.social" };

      const posts = [
        createTestPost("at://test/post1", "Hello"),
        createTestPost("at://test/post2", "World")
      ];

      for (const post of posts) {
        const event = PostUpsert.make({ post, meta: createTestMeta() });
        const record = yield* writer.append(sourceRef, event);
        yield* index.apply(sourceRef, record);
      }

      const result = yield* engine.derive(sourceRef, targetRef, filter, {
        mode: "EventTime",
        reset: false
      });

      expect(result.eventsProcessed).toBe(2);
      expect(result.eventsMatched).toBe(2);
    }).pipe(Effect.provide(TestLayer), Effect.runPromise)
  );

  test("DeriveTime mode accepts Llm filters", () =>
    Effect.gen(function* () {
      const engine = yield* DerivationEngine;
      const writer = yield* StoreWriter;
      const index = yield* StoreIndex;
      const filter: FilterExpr = { _tag: "Llm", prompt: "test", minConfidence: 0.8, onError: { _tag: "Exclude" } };

      const post = createTestPost("at://test/post1", "Test post");
      const event = PostUpsert.make({ post, meta: createTestMeta() });
      const record = yield* writer.append(sourceRef, event);
      yield* index.apply(sourceRef, record);

      const result = yield* engine.derive(sourceRef, targetRef, filter, {
        mode: "DeriveTime",
        reset: false
      });

      expect(result.eventsProcessed).toBe(1);
      expect(result.eventsMatched).toBe(1);
    }).pipe(Effect.provide(TestLayer), Effect.runPromise)
  );

  test("PostDelete events propagate unfiltered", () =>
    Effect.gen(function* () {
      const engine = yield* DerivationEngine;
      const writer = yield* StoreWriter;
      const index = yield* StoreIndex;
      const filter: FilterExpr = { _tag: "Author", handle: "other.bsky.social" }; // Won't match

      const post = createTestPost("at://test/post1", "Test");
      const upsertEvent = PostUpsert.make({ post, meta: createTestMeta() });
      const upsertRecord = yield* writer.append(sourceRef, upsertEvent);
      yield* index.apply(sourceRef, upsertRecord);

      const deleteEvent = PostDelete.make({
        uri: post.uri,
        cid: post.cid,
        meta: createTestMeta()
      });
      const deleteRecord = yield* writer.append(sourceRef, deleteEvent);
      yield* index.apply(sourceRef, deleteRecord);

      const result = yield* engine.derive(sourceRef, targetRef, filter, {
        mode: "EventTime",
        reset: false
      });

      expect(result.eventsProcessed).toBe(2);
      expect(result.deletesPropagated).toBe(1);
      expect(result.eventsMatched).toBe(0); // Post doesn't match filter
    }).pipe(Effect.provide(TestLayer), Effect.runPromise)
  );

  test("URI deduplication prevents duplicates", () =>
    Effect.gen(function* () {
      const engine = yield* DerivationEngine;
      const writer = yield* StoreWriter;
      const index = yield* StoreIndex;
      const filter: FilterExpr = all();

      const posts = [
        createTestPost("at://test/post1", "First"),
        createTestPost("at://test/post1", "Duplicate"), // Same URI
        createTestPost("at://test/post2", "Second")
      ];

      for (const post of posts) {
        const event = PostUpsert.make({ post, meta: createTestMeta() });
        const record = yield* writer.append(sourceRef, event);
        yield* index.apply(sourceRef, record);
      }

      const result = yield* engine.derive(sourceRef, targetRef, filter, {
        mode: "EventTime",
        reset: false
      });

      expect(result.eventsProcessed).toBe(3);
      expect(result.eventsMatched).toBe(2); // Only unique URIs
      expect(result.eventsSkipped).toBe(1);
    }).pipe(Effect.provide(TestLayer), Effect.runPromise)
  );

  test("Lineage is saved", () =>
    Effect.gen(function* () {
      const engine = yield* DerivationEngine;
      const lineageStore = yield* LineageStore;
      const filter: FilterExpr = all();

      const result = yield* engine.derive(sourceRef, targetRef, filter, {
        mode: "EventTime",
        reset: false
      });

      const lineageOption = yield* lineageStore.get(targetRef.name);
      expect(Option.isSome(lineageOption)).toBe(true);

      if (Option.isSome(lineageOption)) {
        const lineage = lineageOption.value;
        expect(lineage.storeName).toBe(targetRef.name);
        expect(lineage.isDerived).toBe(true);
        expect(lineage.sources.length).toBe(1);
        expect(lineage.sources[0]!.storeName).toBe(sourceRef.name);
      }
    }).pipe(Effect.provide(TestLayer), Effect.runPromise)
  );

  test("Reset clears target store", () =>
    Effect.gen(function* () {
      const engine = yield* DerivationEngine;
      const writer = yield* StoreWriter;
      const index = yield* StoreIndex;
      const filter: FilterExpr = all();

      // Pre-populate target with a post
      const existingPost = createTestPost("at://test/existing", "Existing");
      const existingEvent = PostUpsert.make({ post: existingPost, meta: createTestMeta() });
      const existingRecord = yield* writer.append(targetRef, existingEvent);
      yield* index.apply(targetRef, existingRecord);

      // Verify it exists
      const beforeReset = yield* index.hasUri(targetRef, existingPost.uri);
      expect(beforeReset).toBe(true);

      // Add source post
      const post = createTestPost("at://test/post1", "New");
      const event = PostUpsert.make({ post, meta: createTestMeta() });
      const record = yield* writer.append(sourceRef, event);
      yield* index.apply(sourceRef, record);

      // Derive with reset
      yield* engine.derive(sourceRef, targetRef, filter, {
        mode: "EventTime",
        reset: true
      });

      // Old post should be gone
      const afterReset = yield* index.hasUri(targetRef, existingPost.uri);
      expect(afterReset).toBe(false);
    }).pipe(Effect.provide(TestLayer), Effect.runPromise)
  );
});
