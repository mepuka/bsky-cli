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
import { ExcludeOnError } from "../src/domain/policies.js";

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

// Build test layer by composing self-contained dependency layers
// CRITICAL: StoreIndex depends on StoreEventLog, so we must ensure StoreEventLog
// is available when StoreIndex.layer is being constructed. We do this by building
// complete layers with their dependencies satisfied.

// Build StoreEventLog with KeyValueStore
const StoreEventLogComplete = StoreEventLog.layer.pipe(
  Layer.provideMerge(KeyValueStore.layerMemory)
);

// Build StoreIndex with StoreEventLog (which includes KeyValueStore)
const StoreIndexComplete = StoreIndex.layer.pipe(
  Layer.provideMerge(StoreEventLogComplete)
);

// Build other storage services with KeyValueStore
const OtherStorageServices = Layer.mergeAll(
  StoreWriter.layer,
  ViewCheckpointStore.layer,
  LineageStore.layer
).pipe(
  Layer.provideMerge(KeyValueStore.layerMemory)
);

// Build filter services with mocks
const FilterServices = Layer.mergeAll(
  FilterRuntime.layer,
  FilterCompiler.layer
).pipe(
  Layer.provideMerge(MockLlmDecision),
  Layer.provideMerge(MockLinkValidator),
  Layer.provideMerge(MockTrendingTopics)
);

// Assemble everything for DerivationEngine
const TestLayer = DerivationEngine.layer.pipe(
  Layer.provideMerge(StoreIndexComplete),
  Layer.provideMerge(OtherStorageServices),
  Layer.provideMerge(FilterServices)
);

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
      const filter: FilterExpr = { _tag: "Llm", prompt: "test", minConfidence: 0.8, onError: ExcludeOnError.make({}) };

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

  test("Idempotence: derive twice yields same result", () =>
    Effect.gen(function* () {
      const engine = yield* DerivationEngine;
      const writer = yield* StoreWriter;
      const index = yield* StoreIndex;
      const filter: FilterExpr = all();

      // Add posts to source
      const posts = [
        createTestPost("at://test/post1", "First"),
        createTestPost("at://test/post2", "Second"),
        createTestPost("at://test/post3", "Third")
      ];

      for (const post of posts) {
        const event = PostUpsert.make({ post, meta: createTestMeta() });
        const record = yield* writer.append(sourceRef, event);
        yield* index.apply(sourceRef, record);
      }

      // First derivation
      const result1 = yield* engine.derive(sourceRef, targetRef, filter, {
        mode: "EventTime",
        reset: false
      });

      expect(result1.eventsProcessed).toBe(3);
      expect(result1.eventsMatched).toBe(3);

      // Second derivation (checkpoint filters out already-processed events)
      const result2 = yield* engine.derive(sourceRef, targetRef, filter, {
        mode: "EventTime",
        reset: false
      });

      // Checkpoint filtering + URI deduplication ensures idempotence
      expect(result2.eventsProcessed).toBe(0);
      expect(result2.eventsMatched).toBe(0);

      // Verify target still has exactly 3 posts
      const hasPost1 = yield* index.hasUri(targetRef, posts[0].uri);
      const hasPost2 = yield* index.hasUri(targetRef, posts[1].uri);
      const hasPost3 = yield* index.hasUri(targetRef, posts[2].uri);

      expect(hasPost1).toBe(true);
      expect(hasPost2).toBe(true);
      expect(hasPost3).toBe(true);
    }).pipe(Effect.provide(TestLayer), Effect.runPromise)
  );

  test("Checkpoint enables incremental derivation", () =>
    Effect.gen(function* () {
      const engine = yield* DerivationEngine;
      const writer = yield* StoreWriter;
      const index = yield* StoreIndex;
      const filter: FilterExpr = all();

      // Add initial batch of posts
      const initialPosts = [
        createTestPost("at://test/post1", "First"),
        createTestPost("at://test/post2", "Second")
      ];

      for (const post of initialPosts) {
        const event = PostUpsert.make({ post, meta: createTestMeta() });
        const record = yield* writer.append(sourceRef, event);
        yield* index.apply(sourceRef, record);
      }

      // First derivation
      const result1 = yield* engine.derive(sourceRef, targetRef, filter, {
        mode: "EventTime",
        reset: false
      });

      expect(result1.eventsProcessed).toBe(2);
      expect(result1.eventsMatched).toBe(2);

      // Add more posts to source
      const newPosts = [
        createTestPost("at://test/post3", "Third"),
        createTestPost("at://test/post4", "Fourth")
      ];

      for (const post of newPosts) {
        const event = PostUpsert.make({ post, meta: createTestMeta() });
        const record = yield* writer.append(sourceRef, event);
        yield* index.apply(sourceRef, record);
      }

      // Second derivation (incremental)
      const result2 = yield* engine.derive(sourceRef, targetRef, filter, {
        mode: "EventTime",
        reset: false
      });

      // Checkpoint filtering: processes only events with EventId > last checkpoint
      expect(result2.eventsMatched).toBe(2);

      // Verify all 4 posts are in target
      const hasPost1 = yield* index.hasUri(targetRef, initialPosts[0].uri);
      const hasPost2 = yield* index.hasUri(targetRef, initialPosts[1].uri);
      const hasPost3 = yield* index.hasUri(targetRef, newPosts[0].uri);
      const hasPost4 = yield* index.hasUri(targetRef, newPosts[1].uri);

      expect(hasPost1).toBe(true);
      expect(hasPost2).toBe(true);
      expect(hasPost3).toBe(true);
      expect(hasPost4).toBe(true);
    }).pipe(Effect.provide(TestLayer), Effect.runPromise)
  );

  test("Count invariant: processed = matched + skipped + deletes", () =>
    Effect.gen(function* () {
      const engine = yield* DerivationEngine;
      const writer = yield* StoreWriter;
      const index = yield* StoreIndex;
      const filter: FilterExpr = { _tag: "Hashtag", tag: Hashtag.make("#tech") };

      // Add mixed events: some matching, some not, some deletes
      const matchingPost = createTestPost("at://test/post1", "Tech post", ["#tech"]);
      const nonMatchingPost = createTestPost("at://test/post2", "Other post", ["#science"]);
      const deletePost = createTestPost("at://test/post3", "Deleted", ["#tech"]);

      // Add matching post
      const event1 = PostUpsert.make({ post: matchingPost, meta: createTestMeta() });
      const record1 = yield* writer.append(sourceRef, event1);
      yield* index.apply(sourceRef, record1);

      // Add non-matching post
      const event2 = PostUpsert.make({ post: nonMatchingPost, meta: createTestMeta() });
      const record2 = yield* writer.append(sourceRef, event2);
      yield* index.apply(sourceRef, record2);

      // Add delete event
      const deleteEvent = PostDelete.make({
        uri: deletePost.uri,
        cid: deletePost.cid,
        meta: createTestMeta()
      });
      const deleteRecord = yield* writer.append(sourceRef, deleteEvent);
      yield* index.apply(sourceRef, deleteRecord);

      const result = yield* engine.derive(sourceRef, targetRef, filter, {
        mode: "EventTime",
        reset: false
      });

      // Verify count invariant
      const total = result.eventsMatched + result.eventsSkipped + result.deletesPropagated;
      expect(result.eventsProcessed).toBe(total);

      // Specific counts
      expect(result.eventsMatched).toBe(1); // Only #tech post
      expect(result.eventsSkipped).toBe(1); // Non-matching #science post
      expect(result.deletesPropagated).toBe(1); // Delete event
      expect(result.eventsProcessed).toBe(3); // Total
    }).pipe(Effect.provide(TestLayer), Effect.runPromise)
  );

  test("Reset ignores existing checkpoint", () =>
    Effect.gen(function* () {
      const engine = yield* DerivationEngine;
      const writer = yield* StoreWriter;
      const index = yield* StoreIndex;
      const filter: FilterExpr = all();

      // Seed source with a post
      const post = createTestPost("at://test/post1", "First");
      const event = PostUpsert.make({ post, meta: createTestMeta() });
      const record = yield* writer.append(sourceRef, event);
      yield* index.apply(sourceRef, record);

      // First derivation to create checkpoint
      const first = yield* engine.derive(sourceRef, targetRef, filter, {
        mode: "EventTime",
        reset: false
      });
      expect(first.eventsMatched).toBe(1);

      // Reset derivation should re-process even with existing checkpoint
      const second = yield* engine.derive(sourceRef, targetRef, filter, {
        mode: "EventTime",
        reset: true
      });
      expect(second.eventsMatched).toBe(1);
    }).pipe(Effect.provide(TestLayer), Effect.runPromise)
  );
});
