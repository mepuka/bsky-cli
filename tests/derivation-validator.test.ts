import { test, expect, describe } from "bun:test";
import { Effect, Layer, Option, Schema } from "effect";
import * as KeyValueStore from "@effect/platform/KeyValueStore";
import { DerivationValidator } from "../src/services/derivation-validator.js";
import { ViewCheckpointStore } from "../src/services/view-checkpoint-store.js";
import { StoreEventLog } from "../src/services/store-event-log.js";
import { StoreWriter } from "../src/services/store-writer.js";
import { StoreManager } from "../src/services/store-manager.js";
import { StoreIndex } from "../src/services/store-index.js";
import { StoreRef } from "../src/domain/store.js";
import { StoreName, Timestamp } from "../src/domain/primitives.js";
import { defaultStoreConfig } from "../src/domain/defaults.js";
import { DerivationCheckpoint } from "../src/domain/derivation.js";
import { PostUpsert, EventMeta } from "../src/domain/events.js";
import { Post } from "../src/domain/post.js";

// Test helpers
const createTestStoreName = (name: string) =>
  Schema.decodeUnknownSync(StoreName)(name);

const createTestTimestamp = () =>
  Schema.decodeUnknownSync(Timestamp)(new Date().toISOString());

// Helper to get StoreRef from manager (don't create fake ones)
const getStoreRef = (manager: StoreManager, name: StoreName) =>
  Effect.gen(function* () {
    const storeOpt = yield* manager.getStore(name);
    if (Option.isNone(storeOpt)) {
      throw new Error(`Store not found: ${name}`);
    }
    return storeOpt.value;
  });

const createTestMeta = (): EventMeta =>
  EventMeta.make({
    source: "timeline",
    command: "test",
    createdAt: createTestTimestamp()
  });

const createTestPost = (uri: string, text: string): Post =>
  Post.make({
    uri: Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand("PostUri")))(uri),
    cid: Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand("PostCid")))("test-cid"),
    text,
    author: Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand("Handle")))("test.bsky.social"),
    authorDid: Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand("Did")))("did:plc:test"),
    createdAt: createTestTimestamp(),
    hashtags: [],
    mentions: [],
    links: []
  });

// Test layer setup - build complete layers with dependencies satisfied
// CRITICAL: StoreIndex depends on StoreEventLog, so we build complete layers

// Build StoreEventLog with KeyValueStore
const StoreEventLogComplete = StoreEventLog.layer.pipe(
  Layer.provideMerge(KeyValueStore.layerMemory)
);

// Build StoreIndex with StoreEventLog (which includes KeyValueStore)
const StoreIndexComplete = StoreIndex.layer.pipe(
  Layer.provideMerge(StoreEventLogComplete)
);

// Build other storage services with KeyValueStore
const StorageServices = Layer.mergeAll(
  StoreWriter.layer,
  StoreManager.layer,
  ViewCheckpointStore.layer
).pipe(
  Layer.provideMerge(KeyValueStore.layerMemory)
);

// Final test layer
const TestLayer = DerivationValidator.layer.pipe(
  Layer.provideMerge(StoreIndexComplete),
  Layer.provideMerge(StorageServices)
);

describe("DerivationValidator", () => {
  test("returns true when no checkpoint exists (never materialized)", () =>
    Effect.gen(function* () {
      const validator = yield* DerivationValidator;
      const viewName = createTestStoreName("view-store");
      const sourceName = createTestStoreName("source-store");

      const isStale = yield* validator.isStale(viewName, sourceName);

      expect(isStale).toBe(true);
    }).pipe(Effect.provide(TestLayer), Effect.runPromise)
  );

  test("returns false when source store does not exist", () =>
    Effect.gen(function* () {
      const validator = yield* DerivationValidator;
      const checkpoints = yield* ViewCheckpointStore;
      const viewName = createTestStoreName("view-store");
      const sourceName = createTestStoreName("nonexistent-source");

      // Create a checkpoint
      const checkpoint = DerivationCheckpoint.make({
        viewName,
        sourceStore: sourceName,
        targetStore: viewName,
        filterHash: "abc123",
        evaluationMode: "EventTime",
        eventsProcessed: 0,
        eventsMatched: 0,
        deletesPropagated: 0,
        updatedAt: createTestTimestamp()
      });
      yield* checkpoints.save(checkpoint);

      const isStale = yield* validator.isStale(viewName, sourceName);

      expect(isStale).toBe(false);
    }).pipe(Effect.provide(TestLayer), Effect.runPromise)
  );

  test("returns false when source store is empty", () =>
    Effect.gen(function* () {
      const validator = yield* DerivationValidator;
      const checkpoints = yield* ViewCheckpointStore;
      const manager = yield* StoreManager;
      const viewName = createTestStoreName("view-store");
      const sourceName = createTestStoreName("empty-source");

      // Create the source store (empty)
      yield* manager.createStore(
        sourceName,
        defaultStoreConfig
      );

      // Create a checkpoint
      const checkpoint = DerivationCheckpoint.make({
        viewName,
        sourceStore: sourceName,
        targetStore: viewName,
        filterHash: "abc123",
        evaluationMode: "EventTime",
        eventsProcessed: 0,
        eventsMatched: 0,
        deletesPropagated: 0,
        updatedAt: createTestTimestamp()
      });
      yield* checkpoints.save(checkpoint);

      const isStale = yield* validator.isStale(viewName, sourceName);

      expect(isStale).toBe(false);
    }).pipe(Effect.provide(TestLayer), Effect.runPromise)
  );

  test("returns true when checkpoint has no lastSourceEventId", () =>
    Effect.gen(function* () {
      const validator = yield* DerivationValidator;
      const checkpoints = yield* ViewCheckpointStore;
      const manager = yield* StoreManager;
      const writer = yield* StoreWriter;
      const index = yield* StoreIndex;
      const viewName = createTestStoreName("view-store");
      const sourceName = createTestStoreName("source-store");

      // Create source store with an event
      yield* manager.createStore(
        sourceName,
        defaultStoreConfig
      );
      const sourceRef = yield* getStoreRef(manager, sourceName);
      const post = createTestPost("at://test/post1", "Test post");
      const event = PostUpsert.make({ post, meta: createTestMeta() });
      const record = yield* writer.append(sourceRef, event);
      yield* index.apply(sourceRef, record);

      // Create checkpoint without lastSourceEventId
      const checkpoint = DerivationCheckpoint.make({
        viewName,
        sourceStore: sourceName,
        targetStore: viewName,
        filterHash: "abc123",
        evaluationMode: "EventTime",
        eventsProcessed: 0,
        eventsMatched: 0,
        deletesPropagated: 0,
        updatedAt: createTestTimestamp()
        // lastSourceEventId is undefined
      });
      yield* checkpoints.save(checkpoint);

      const isStale = yield* validator.isStale(viewName, sourceName);

      expect(isStale).toBe(true);
    }).pipe(Effect.provide(TestLayer), Effect.runPromise)
  );

  test("returns false when checkpoint is up-to-date with source", () =>
    Effect.gen(function* () {
      const validator = yield* DerivationValidator;
      const checkpoints = yield* ViewCheckpointStore;
      const manager = yield* StoreManager;
      const writer = yield* StoreWriter;
      const index = yield* StoreIndex;
      const viewName = createTestStoreName("view-store");
      const sourceName = createTestStoreName("source-store");

      // Create source store with an event
      yield* manager.createStore(
        sourceName,
        defaultStoreConfig
      );
      const sourceRef = yield* getStoreRef(manager, sourceName);
      const post = createTestPost("at://test/post1", "Test post");
      const event = PostUpsert.make({ post, meta: createTestMeta() });
      const record = yield* writer.append(sourceRef, event);
      yield* index.apply(sourceRef, record);

      // Create checkpoint with the same lastSourceEventId
      const checkpoint = DerivationCheckpoint.make({
        viewName,
        sourceStore: sourceName,
        targetStore: viewName,
        filterHash: "abc123",
        evaluationMode: "EventTime",
        lastSourceEventId: record.id,
        eventsProcessed: 1,
        eventsMatched: 1,
        deletesPropagated: 0,
        updatedAt: createTestTimestamp()
      });
      yield* checkpoints.save(checkpoint);

      const isStale = yield* validator.isStale(viewName, sourceName);

      expect(isStale).toBe(false);
    }).pipe(Effect.provide(TestLayer), Effect.runPromise)
  );

  test("returns true when source has newer events than checkpoint", () =>
    Effect.gen(function* () {
      const validator = yield* DerivationValidator;
      const checkpoints = yield* ViewCheckpointStore;
      const manager = yield* StoreManager;
      const writer = yield* StoreWriter;
      const index = yield* StoreIndex;
      const viewName = createTestStoreName("view-store");
      const sourceName = createTestStoreName("source-store");

      // Create source store with first event
      yield* manager.createStore(
        sourceName,
        defaultStoreConfig
      );
      const sourceRef = yield* getStoreRef(manager, sourceName);
      const post1 = createTestPost("at://test/post1", "First post");
      const event1 = PostUpsert.make({ post: post1, meta: createTestMeta() });
      const record1 = yield* writer.append(sourceRef, event1);
      yield* index.apply(sourceRef, record1);

      // Create checkpoint tracking first event
      const checkpoint = DerivationCheckpoint.make({
        viewName,
        sourceStore: sourceName,
        targetStore: viewName,
        filterHash: "abc123",
        evaluationMode: "EventTime",
        lastSourceEventId: record1.id,
        eventsProcessed: 1,
        eventsMatched: 1,
        deletesPropagated: 0,
        updatedAt: createTestTimestamp()
      });
      yield* checkpoints.save(checkpoint);

      // Add a second event to source (making it stale)
      const post2 = createTestPost("at://test/post2", "Second post");
      const event2 = PostUpsert.make({ post: post2, meta: createTestMeta() });
      const record2 = yield* writer.append(sourceRef, event2);
      yield* index.apply(sourceRef, record2);

      const isStale = yield* validator.isStale(viewName, sourceName);

      expect(isStale).toBe(true);
    }).pipe(Effect.provide(TestLayer), Effect.runPromise)
  );
});
