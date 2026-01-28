import { describe, expect, test } from "bun:test";
import { Effect, Layer, Option, Schema } from "effect";
import { FileSystem } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import { StoreDb } from "../../src/services/store-db.js";
import { StoreIndex } from "../../src/services/store-index.js";
import { StoreEventLog } from "../../src/services/store-event-log.js";
import { StoreManager } from "../../src/services/store-manager.js";
import { StoreCleaner } from "../../src/services/store-cleaner.js";
import { AppConfigService, ConfigOverrides } from "../../src/services/app-config.js";
import { StoreConfig } from "../../src/domain/store.js";
import { StoreName } from "../../src/domain/primitives.js";

const sampleName = Schema.decodeUnknownSync(StoreName)("teststore");
const sampleConfig = Schema.decodeUnknownSync(StoreConfig)({
  format: { json: true, markdown: false },
  autoSync: false,
  filters: [
    {
      name: "all",
      expr: { _tag: "All" },
      output: { path: "all", json: true, markdown: false }
    }
  ]
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
  const indexLayer = StoreIndex.layer.pipe(
    Layer.provideMerge(storeDbLayer),
    Layer.provideMerge(eventLogLayer)
  );
  const managerLayer = StoreManager.layer.pipe(Layer.provideMerge(appConfigLayer));
  const cleanerLayer = StoreCleaner.layer.pipe(
    Layer.provideMerge(managerLayer),
    Layer.provideMerge(indexLayer),
    Layer.provideMerge(eventLogLayer),
    Layer.provideMerge(storeDbLayer)
  );

  return Layer.mergeAll(
    appConfigLayer,
    storeDbLayer,
    eventLogLayer,
    indexLayer,
    managerLayer,
    cleanerLayer
  ).pipe(Layer.provideMerge(BunContext.layer));
};

describe("StoreCleaner", () => {
  test("deleteStore removes StoreDb cached client", async () => {
    const tempDir = await makeTempDir();
    try {
      const layer = buildLayer(tempDir);

      const program = Effect.gen(function* () {
        const manager = yield* StoreManager;
        const storeDb = yield* StoreDb;
        const cleaner = yield* StoreCleaner;

        // Create a store and use the client to populate the cache
        const storeRef = yield* manager.createStore(sampleName, sampleConfig);
        yield* storeDb.withClient(storeRef, (client) =>
          client`SELECT 1`
        );

        // Delete the store -- this should remove the cached client
        const result = yield* cleaner.deleteStore(sampleName);
        expect(result.deleted).toBe(true);

        // After deletion, the old cached client should be gone.
        // Creating the store again and using it should work (proves no stale client).
        const newRef = yield* manager.createStore(sampleName, sampleConfig);
        const rows = yield* storeDb.withClient(newRef, (client) =>
          client`SELECT 1 as val`
        );
        expect(rows.length).toBe(1);
      });

      await Effect.runPromise(program.pipe(Effect.provide(layer)));
    } finally {
      await removeTempDir(tempDir);
    }
  });

  test("deleteStore for non-existent store returns deleted: false", async () => {
    const tempDir = await makeTempDir();
    try {
      const layer = buildLayer(tempDir);

      const program = Effect.gen(function* () {
        const cleaner = yield* StoreCleaner;
        const result = yield* cleaner.deleteStore(sampleName);
        expect(result.deleted).toBe(false);
      });

      await Effect.runPromise(program.pipe(Effect.provide(layer)));
    } finally {
      await removeTempDir(tempDir);
    }
  });
});
