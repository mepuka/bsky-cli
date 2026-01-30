import { test, expect, describe } from "bun:test";
import { Effect, Layer, Option, Schema } from "effect";
import { FileSystem } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import { DerivationValidator } from "../src/services/derivation-validator.js";
import { ViewCheckpointStore } from "../src/services/view-checkpoint-store.js";
import { StoreEventLog } from "../src/services/store-event-log.js";
import { StoreWriter } from "../src/services/store-writer.js";
import { StoreManager } from "../src/services/store-manager.js";
import { StoreIndex } from "../src/services/store-index.js";
import { StoreDb } from "../src/services/store-db.js";
import { StoreRef } from "../src/domain/store.js";
import { StoreName, Timestamp } from "../src/domain/primitives.js";
import { defaultStoreConfig } from "../src/domain/defaults.js";
import { DerivationCheckpoint } from "../src/domain/derivation.js";
import { PostUpsert, EventMeta } from "../src/domain/events.js";
import { Post } from "../src/domain/post.js";
import { AppConfigService, ConfigOverrides } from "../src/services/app-config.js";

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

const buildTestLayer = (storeRoot: string) => {
  const overrides = Layer.succeed(ConfigOverrides, { storeRoot });
  const appConfigLayer = AppConfigService.layer.pipe(Layer.provide(overrides));
  const storeDbLayer = StoreDb.layer.pipe(Layer.provideMerge(appConfigLayer));
  const storeManagerLayer = StoreManager.layer.pipe(Layer.provideMerge(appConfigLayer));
  const eventLogLayer = StoreEventLog.layer.pipe(Layer.provideMerge(storeDbLayer));
  const indexLayer = StoreIndex.layer.pipe(
    Layer.provideMerge(storeDbLayer),
    Layer.provideMerge(eventLogLayer)
  );
  const writerLayer = StoreWriter.layer.pipe(Layer.provideMerge(storeDbLayer));
  const checkpointLayer = ViewCheckpointStore.layer.pipe(
    Layer.provideMerge(storeDbLayer),
    Layer.provideMerge(storeManagerLayer)
  );
  const storageServices = Layer.mergeAll(
    writerLayer,
    storeManagerLayer,
    checkpointLayer
  );

  return Layer.mergeAll(
    appConfigLayer,
    storeDbLayer,
    storeManagerLayer,
    eventLogLayer,
    indexLayer,
    storageServices,
    DerivationValidator.layer.pipe(
      Layer.provideMerge(indexLayer),
      Layer.provideMerge(storageServices)
    )
  ).pipe(Layer.provideMerge(BunContext.layer));
};

const withTestLayer = async <A>(program: Effect.Effect<A>) => {
  const tempDir = await makeTempDir();
  const layer = buildTestLayer(tempDir);
  try {
    return await Effect.runPromise(program.pipe(Effect.provide(layer)));
  } finally {
    await removeTempDir(tempDir);
  }
};

describe("DerivationValidator", () => {
  test("returns true when no checkpoint exists (never materialized)", () => withTestLayer(
    Effect.gen(function* () {
      const validator = yield* DerivationValidator;
      const viewName = createTestStoreName("view-store");
      const sourceName = createTestStoreName("source-store");

      const isStale = yield* validator.isStale(viewName, sourceName);

      expect(isStale).toBe(true);
    }))
  );

  test("returns false when source store does not exist", () => withTestLayer(
    Effect.gen(function* () {
      const validator = yield* DerivationValidator;
      const checkpoints = yield* ViewCheckpointStore;
      const manager = yield* StoreManager;
      const viewName = createTestStoreName("view-store");
      const sourceName = createTestStoreName("nonexistent-source");

      yield* manager.createStore(viewName, defaultStoreConfig);

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
    }))
  );

  test("returns false when source store is empty", () => withTestLayer(
    Effect.gen(function* () {
      const validator = yield* DerivationValidator;
      const checkpoints = yield* ViewCheckpointStore;
      const manager = yield* StoreManager;
      const viewName = createTestStoreName("view-store");
      const sourceName = createTestStoreName("empty-source");

      yield* manager.createStore(viewName, defaultStoreConfig);

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
    }))
  );

  test("returns true when checkpoint has no lastSourceEventSeq", () => withTestLayer(
    Effect.gen(function* () {
      const validator = yield* DerivationValidator;
      const checkpoints = yield* ViewCheckpointStore;
      const manager = yield* StoreManager;
      const writer = yield* StoreWriter;
      const index = yield* StoreIndex;
      const viewName = createTestStoreName("view-store");
      const sourceName = createTestStoreName("source-store");

      yield* manager.createStore(viewName, defaultStoreConfig);

      // Create source store with an event
      yield* manager.createStore(
        sourceName,
        defaultStoreConfig
      );
      const sourceRef = yield* getStoreRef(manager, sourceName);
      const post = createTestPost("at://test/post1", "Test post");
      const event = PostUpsert.make({ post, meta: createTestMeta() });
      const entry = yield* writer.append(sourceRef, event);
      yield* index.apply(sourceRef, entry.record);

      // Create checkpoint without lastSourceEventSeq
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
        // lastSourceEventSeq is undefined
      });
      yield* checkpoints.save(checkpoint);

      const isStale = yield* validator.isStale(viewName, sourceName);

      expect(isStale).toBe(true);
    }))
  );

  test("returns false when checkpoint is up-to-date with source", () => withTestLayer(
    Effect.gen(function* () {
      const validator = yield* DerivationValidator;
      const checkpoints = yield* ViewCheckpointStore;
      const manager = yield* StoreManager;
      const writer = yield* StoreWriter;
      const index = yield* StoreIndex;
      const viewName = createTestStoreName("view-store");
      const sourceName = createTestStoreName("source-store");

      yield* manager.createStore(viewName, defaultStoreConfig);

      // Create source store with an event
      yield* manager.createStore(
        sourceName,
        defaultStoreConfig
      );
      const sourceRef = yield* getStoreRef(manager, sourceName);
      const post = createTestPost("at://test/post1", "Test post");
      const event = PostUpsert.make({ post, meta: createTestMeta() });
      const entry = yield* writer.append(sourceRef, event);
      yield* index.apply(sourceRef, entry.record);

      // Create checkpoint with the same lastSourceEventSeq
      const checkpoint = DerivationCheckpoint.make({
        viewName,
        sourceStore: sourceName,
        targetStore: viewName,
        filterHash: "abc123",
        evaluationMode: "EventTime",
        lastSourceEventSeq: entry.seq,
        eventsProcessed: 1,
        eventsMatched: 1,
        deletesPropagated: 0,
        updatedAt: createTestTimestamp()
      });
      yield* checkpoints.save(checkpoint);

      const isStale = yield* validator.isStale(viewName, sourceName);

      expect(isStale).toBe(false);
    }))
  );

  test("returns true when source has newer events than checkpoint", () => withTestLayer(
    Effect.gen(function* () {
      const validator = yield* DerivationValidator;
      const checkpoints = yield* ViewCheckpointStore;
      const manager = yield* StoreManager;
      const writer = yield* StoreWriter;
      const index = yield* StoreIndex;
      const viewName = createTestStoreName("view-store");
      const sourceName = createTestStoreName("source-store");

      yield* manager.createStore(viewName, defaultStoreConfig);

      // Create source store with first event
      yield* manager.createStore(
        sourceName,
        defaultStoreConfig
      );
      const sourceRef = yield* getStoreRef(manager, sourceName);
      const post1 = createTestPost("at://test/post1", "First post");
      const event1 = PostUpsert.make({ post: post1, meta: createTestMeta() });
      const entry1 = yield* writer.append(sourceRef, event1);
      yield* index.apply(sourceRef, entry1.record);

      // Create checkpoint tracking first event
      const checkpoint = DerivationCheckpoint.make({
        viewName,
        sourceStore: sourceName,
        targetStore: viewName,
        filterHash: "abc123",
        evaluationMode: "EventTime",
        lastSourceEventSeq: entry1.seq,
        eventsProcessed: 1,
        eventsMatched: 1,
        deletesPropagated: 0,
        updatedAt: createTestTimestamp()
      });
      yield* checkpoints.save(checkpoint);

      // Add a second event to source (making it stale)
      const post2 = createTestPost("at://test/post2", "Second post");
      const event2 = PostUpsert.make({ post: post2, meta: createTestMeta() });
      const entry2 = yield* writer.append(sourceRef, event2);
      yield* index.apply(sourceRef, entry2.record);

      const isStale = yield* validator.isStale(viewName, sourceName);

      expect(isStale).toBe(true);
    }))
  );
});
