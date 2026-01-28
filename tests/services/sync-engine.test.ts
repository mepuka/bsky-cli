import { describe, expect, test } from "bun:test";
import { Effect, Layer, Schema, Stream } from "effect";
import { FileSystem } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import * as KeyValueStore from "@effect/platform/KeyValueStore";
import { BskyClient } from "../../src/services/bsky-client.js";
import { FilterRuntime } from "../../src/services/filter-runtime.js";
import { LlmDecision } from "../../src/services/llm.js";
import { LinkValidator } from "../../src/services/link-validator.js";
import { PostParser } from "../../src/services/post-parser.js";
import { StoreEventLog } from "../../src/services/store-event-log.js";
import { StoreIndex } from "../../src/services/store-index.js";
import { StoreWriter } from "../../src/services/store-writer.js";
import { StoreDb } from "../../src/services/store-db.js";
import { SyncEngine } from "../../src/services/sync-engine.js";
import { SyncCheckpointStore } from "../../src/services/sync-checkpoint-store.js";
import { SyncReporter } from "../../src/services/sync-reporter.js";
import { TrendingTopics } from "../../src/services/trending-topics.js";
import { AppConfigService, ConfigOverrides } from "../../src/services/app-config.js";
import { SyncSettings, SyncSettingsOverrides } from "../../src/services/sync-settings.js";
import { all } from "../../src/domain/filter.js";
import { RawPost } from "../../src/domain/raw.js";
import { StoreRef } from "../../src/domain/store.js";
import { DataSource } from "../../src/domain/sync.js";

const sampleRaw = Schema.decodeUnknownSync(RawPost)({
  uri: "at://did:plc:example/app.bsky.feed.post/1",
  author: "alice.bsky",
  record: {
    text: "Hello #effect",
    createdAt: "2026-01-01T00:00:00.000Z"
  }
});

const sampleStore = Schema.decodeUnknownSync(StoreRef)({
  name: "arsenal",
  root: "stores/arsenal"
});

const bskyLayer = Layer.succeed(
  BskyClient,
  BskyClient.of({
    getTimeline: () => Stream.fromIterable([sampleRaw]),
    getNotifications: () => Stream.empty,
    getFeed: () => Stream.empty,
    getPost: () => Effect.succeed(sampleRaw)
  })
);

const filterRuntimeLayer = FilterRuntime.layer.pipe(
  Layer.provideMerge(LlmDecision.testLayer),
  Layer.provideMerge(LinkValidator.testLayer),
  Layer.provideMerge(TrendingTopics.testLayer)
);

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
  const syncOverrides = Layer.succeed(SyncSettingsOverrides, {});
  const appConfigLayer = AppConfigService.layer.pipe(Layer.provide(overrides));
  const syncSettingsLayer = SyncSettings.layer.pipe(Layer.provide(syncOverrides));
  const storageLayer = KeyValueStore.layerMemory;
  const storeDbLayer = StoreDb.layer.pipe(Layer.provideMerge(appConfigLayer));
  const eventLogLayer = StoreEventLog.layer.pipe(Layer.provideMerge(storeDbLayer));
  const indexLayer = StoreIndex.layer.pipe(
    Layer.provideMerge(storeDbLayer),
    Layer.provideMerge(eventLogLayer)
  );
  const writerLayer = StoreWriter.layer.pipe(Layer.provideMerge(storeDbLayer));
  const checkpointLayer = SyncCheckpointStore.layer.pipe(
    Layer.provideMerge(storageLayer)
  );

  return SyncEngine.layer.pipe(
    Layer.provideMerge(bskyLayer),
    Layer.provideMerge(PostParser.layer),
    Layer.provideMerge(filterRuntimeLayer),
    Layer.provideMerge(writerLayer),
    Layer.provideMerge(indexLayer),
    Layer.provideMerge(eventLogLayer),
    Layer.provideMerge(checkpointLayer),
    Layer.provideMerge(SyncReporter.layer),
    Layer.provideMerge(syncSettingsLayer),
    Layer.provideMerge(appConfigLayer),
    Layer.provideMerge(storageLayer),
    Layer.provideMerge(storeDbLayer),
    Layer.provideMerge(BunContext.layer)
  );
};

describe("SyncEngine", () => {
  test("sync processes timeline posts into event log + index", async () => {
    const program = Effect.gen(function* () {
      const sync = yield* SyncEngine;
      const index = yield* StoreIndex;

      const result = yield* sync.sync(
        DataSource.timeline(),
        sampleStore,
        all()
      );

      const byDate = yield* index.getByDate(sampleStore, "2026-01-01");
      const byTag = yield* index.getByHashtag(sampleStore, "#effect");

      return { result, byDate, byTag };
    });
    const tempDir = await makeTempDir();
    const layer = buildLayer(tempDir);
    try {
      const outcome = await Effect.runPromise(program.pipe(Effect.provide(layer)));

      expect(outcome.result.postsAdded).toBe(1);
      expect(outcome.result.postsSkipped).toBe(0);
      expect(outcome.result.errors).toEqual([]);
      expect(outcome.byDate).toEqual([sampleRaw.uri]);
      expect(outcome.byTag).toEqual([sampleRaw.uri]);
    } finally {
      await removeTempDir(tempDir);
    }
  });

  test("sync deduplicates previously stored posts", async () => {
    const program = Effect.gen(function* () {
      const sync = yield* SyncEngine;

      const first = yield* sync.sync(
        DataSource.timeline(),
        sampleStore,
        all()
      );
      const second = yield* sync.sync(
        DataSource.timeline(),
        sampleStore,
        all()
      );

      return { first, second };
    });
    const tempDir = await makeTempDir();
    const layer = buildLayer(tempDir);
    try {
      const outcome = await Effect.runPromise(program.pipe(Effect.provide(layer)));

      expect(outcome.first.postsAdded).toBe(1);
      expect(outcome.second.postsAdded).toBe(0);
      expect(outcome.second.postsSkipped).toBe(1);
    } finally {
      await removeTempDir(tempDir);
    }
  });
});
