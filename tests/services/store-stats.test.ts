import { describe, expect, test } from "bun:test";
import { FileSystem, Path } from "@effect/platform";
import * as KeyValueStore from "@effect/platform/KeyValueStore";
import { Effect, Layer, Schema } from "effect";
import { StoreStats } from "../../src/services/store-stats.js";
import { StoreManager } from "../../src/services/store-manager.js";
import { StoreWriter } from "../../src/services/store-writer.js";
import { StoreEventLog } from "../../src/services/store-event-log.js";
import { StoreIndex } from "../../src/services/store-index.js";
import { LineageStore } from "../../src/services/lineage-store.js";
import { SyncCheckpointStore } from "../../src/services/sync-checkpoint-store.js";
import { ViewCheckpointStore } from "../../src/services/view-checkpoint-store.js";
import { DerivationValidator } from "../../src/services/derivation-validator.js";
import { AppConfigService } from "../../src/services/app-config.js";
import { AppConfig } from "../../src/domain/config.js";
import { defaultStoreConfig } from "../../src/domain/defaults.js";
import { StoreName } from "../../src/domain/primitives.js";
import { EventMeta, PostUpsert } from "../../src/domain/events.js";
import { Post } from "../../src/domain/post.js";

const makeAppConfigLayer = () => {
  const config = AppConfig.make({
    service: "https://bsky.social",
    storeRoot: "/tmp/skygent-test",
    outputFormat: "ndjson"
  });
  return Layer.succeed(AppConfigService, AppConfigService.of(config));
};

const testLayers = () => {
  const kvLayer = KeyValueStore.layerMemory;
  const managerLayer = StoreManager.layer.pipe(Layer.provide(kvLayer));
  const writerLayer = StoreWriter.layer.pipe(Layer.provide(kvLayer));
  const eventLogLayer = StoreEventLog.layer.pipe(Layer.provide(kvLayer));
  const indexLayer = StoreIndex.layer.pipe(
    Layer.provideMerge(kvLayer),
    Layer.provideMerge(eventLogLayer)
  );
  const lineageLayer = LineageStore.layer.pipe(Layer.provide(kvLayer));
  const syncCheckpointLayer = SyncCheckpointStore.layer.pipe(
    Layer.provide(kvLayer)
  );
  const viewCheckpointLayer = ViewCheckpointStore.layer.pipe(
    Layer.provide(kvLayer)
  );
  const derivationValidatorLayer = DerivationValidator.layer.pipe(
    Layer.provideMerge(viewCheckpointLayer),
    Layer.provideMerge(eventLogLayer),
    Layer.provideMerge(managerLayer)
  );
  const fsLayer = FileSystem.layerNoop({
    exists: () => Effect.succeed(false)
  });
  const pathLayer = Path.layer;
  const appConfigLayer = makeAppConfigLayer();
  const storeStatsLayer = StoreStats.layer.pipe(
    Layer.provideMerge(appConfigLayer),
    Layer.provideMerge(managerLayer),
    Layer.provideMerge(indexLayer),
    Layer.provideMerge(lineageLayer),
    Layer.provideMerge(derivationValidatorLayer),
    Layer.provideMerge(eventLogLayer),
    Layer.provideMerge(syncCheckpointLayer),
    Layer.provideMerge(fsLayer),
    Layer.provideMerge(pathLayer)
  );

  return Layer.mergeAll(
    storeStatsLayer,
    managerLayer,
    writerLayer,
    indexLayer,
    eventLogLayer,
    lineageLayer,
    syncCheckpointLayer,
    derivationValidatorLayer,
    appConfigLayer,
    fsLayer,
    pathLayer
  );
};

const sampleMeta = Schema.decodeUnknownSync(EventMeta)({
  source: "timeline",
  command: "sync timeline",
  createdAt: "2026-01-01T00:00:00.000Z"
});

const samplePost = Schema.decodeUnknownSync(Post)({
  uri: "at://did:plc:example/app.bsky.feed.post/1",
  author: "alice.bsky",
  text: "Hello #ai",
  createdAt: "2026-01-01T00:00:00.000Z",
  hashtags: ["#ai"],
  mentions: [],
  links: []
});

const samplePostLater = Schema.decodeUnknownSync(Post)({
  uri: "at://did:plc:example/app.bsky.feed.post/2",
  author: "bob.bsky",
  text: "Later post #tech",
  createdAt: "2026-01-03T00:00:00.000Z",
  hashtags: ["#tech"],
  mentions: [],
  links: []
});

describe("StoreStats", () => {
  test("computes basic stats for a store", async () => {
    const program = Effect.gen(function* () {
      const manager = yield* StoreManager;
      const writer = yield* StoreWriter;
      const index = yield* StoreIndex;
      const stats = yield* StoreStats;

      const name = Schema.decodeUnknownSync(StoreName)("demo");
      const store = yield* manager.createStore(name, defaultStoreConfig);

      const record1 = yield* writer.append(
        store,
        PostUpsert.make({ post: samplePost, meta: sampleMeta })
      );
      const record2 = yield* writer.append(
        store,
        PostUpsert.make({ post: samplePostLater, meta: sampleMeta })
      );
      yield* index.apply(store, record1);
      yield* index.apply(store, record2);

      return yield* stats.stats(store);
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(testLayers())));

    expect(result.posts).toBe(2);
    expect(result.authors).toBe(2);
    expect(result.status).toBe("source");
    expect(result.dateRange).toMatchObject({
      first: "2026-01-01",
      last: "2026-01-03"
    });
    expect(result.hashtags).toEqual(expect.arrayContaining(["#ai", "#tech"]));
    expect(result.topAuthors).toEqual(
      expect.arrayContaining(["alice.bsky", "bob.bsky"])
    );
  });

  test("summarizes stores", async () => {
    const program = Effect.gen(function* () {
      const manager = yield* StoreManager;
      const stats = yield* StoreStats;
      const name = Schema.decodeUnknownSync(StoreName)("summary");
      yield* manager.createStore(name, defaultStoreConfig);
      return yield* stats.summary();
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(testLayers())));

    expect(result.total).toBeGreaterThanOrEqual(1);
    expect(result.stores.some((store) => store.name === "summary")).toBe(true);
  });
});
