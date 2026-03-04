import { describe, expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";
import { StoreDb } from "../../src/services/store-db.js";
import { StoreManager } from "../../src/services/store-manager.js";
import { StoreCleaner } from "../../src/services/store-cleaner.js";
import { StoreConfig } from "../../src/domain/store.js";
import { StoreName } from "../../src/domain/primitives.js";
import { buildStoreCoreLayer } from "../support/layers.js";
import { makeTempDir, removeTempDir } from "../support/temp-dir.js";

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
const buildLayer = (storeRoot: string) => {
  const coreLayer = buildStoreCoreLayer(storeRoot);
  const cleanerLayer = StoreCleaner.layer.pipe(
    Layer.provideMerge(coreLayer)
  );

  return Layer.mergeAll(coreLayer, cleanerLayer);
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
        expect(result.reason).toBe("missing");
      });

      await Effect.runPromise(program.pipe(Effect.provide(layer)));
    } finally {
      await removeTempDir(tempDir);
    }
  });
});
