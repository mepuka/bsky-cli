import { describe, expect, test } from "bun:test";
import { Effect, Layer, Option, Schema } from "effect";
import { BunContext } from "@effect/platform-bun";
import { ViewCheckpointStore } from "../../src/services/view-checkpoint-store.js";
import { DerivationCheckpoint } from "../../src/domain/derivation.js";
import { StoreName, Timestamp } from "../../src/domain/primitives.js";
import { AppConfigService, ConfigOverrides } from "../../src/services/app-config.js";
import { StoreManager } from "../../src/services/store-manager.js";
import { StoreDb } from "../../src/services/store-db.js";
import { defaultStoreConfig } from "../../src/domain/defaults.js";
import { FileSystem } from "@effect/platform";

const sampleViewName = Schema.decodeUnknownSync(StoreName)("arsenal-links");
const sampleSourceName = Schema.decodeUnknownSync(StoreName)("arsenal");
const sampleCheckpoint = Schema.decodeUnknownSync(DerivationCheckpoint)({
  viewName: "arsenal-links",
  sourceStore: "arsenal",
  targetStore: "arsenal-links",
  filterHash: "abc123",
  evaluationMode: "EventTime",
  eventsProcessed: 100,
  eventsMatched: 25,
  deletesPropagated: 5,
  updatedAt: "2026-01-01T00:00:00.000Z"
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
  const storeManagerLayer = StoreManager.layer.pipe(Layer.provide(appConfigLayer));
  const storeDbLayer = StoreDb.layer.pipe(Layer.provide(appConfigLayer));
  const viewCheckpointLayer = ViewCheckpointStore.layer.pipe(
    Layer.provideMerge(storeDbLayer),
    Layer.provideMerge(storeManagerLayer)
  );
  return Layer.mergeAll(
    viewCheckpointLayer,
    storeManagerLayer,
    storeDbLayer,
    appConfigLayer
  ).pipe(Layer.provideMerge(BunContext.layer));
};

describe("ViewCheckpointStore", () => {
  test("save writes checkpoint and load retrieves it", async () => {
    const tempDir = await makeTempDir();
    const layer = buildLayer(tempDir);

    try {
      const program = Effect.gen(function* () {
        const store = yield* ViewCheckpointStore;
        const manager = yield* StoreManager;

        yield* manager.createStore(sampleViewName, defaultStoreConfig);
        yield* store.save(sampleCheckpoint);

        return yield* store.load(sampleViewName, sampleSourceName);
      });

      const result = await Effect.runPromise(program.pipe(Effect.provide(layer)));

      expect(Option.isSome(result)).toBe(true);
      if (Option.isSome(result)) {
        expect(result.value).toEqual(sampleCheckpoint);
      }
    } finally {
      await removeTempDir(tempDir);
    }
  });

  test("load returns None when checkpoint does not exist", async () => {
    const tempDir = await makeTempDir();
    const layer = buildLayer(tempDir);

    try {
      const program = Effect.gen(function* () {
        const store = yield* ViewCheckpointStore;
        const manager = yield* StoreManager;
        const nonExistentView = Schema.decodeUnknownSync(StoreName)("nonexistent");
        const nonExistentSource = Schema.decodeUnknownSync(StoreName)("nonexistent-source");

        yield* manager.createStore(sampleViewName, defaultStoreConfig);

        return yield* store.load(nonExistentView, nonExistentSource);
      });

      const result = await Effect.runPromise(program.pipe(Effect.provide(layer)));

      expect(Option.isNone(result)).toBe(true);
    } finally {
      await removeTempDir(tempDir);
    }
  });

  test("save overwrites existing checkpoint", async () => {
    const tempDir = await makeTempDir();
    const layer = buildLayer(tempDir);

    try {
      const program = Effect.gen(function* () {
        const store = yield* ViewCheckpointStore;
        const manager = yield* StoreManager;

        yield* manager.createStore(sampleViewName, defaultStoreConfig);
        yield* store.save(sampleCheckpoint);

        const updated = Schema.decodeUnknownSync(DerivationCheckpoint)({
          ...sampleCheckpoint,
          eventsProcessed: 200,
          eventsMatched: 50,
          updatedAt: "2026-01-02T00:00:00.000Z"
        });

        yield* store.save(updated);
        return yield* store.load(sampleViewName, sampleSourceName);
      });

      const result = await Effect.runPromise(program.pipe(Effect.provide(layer)));

      expect(Option.isSome(result)).toBe(true);
      if (Option.isSome(result)) {
        expect(result.value.eventsProcessed).toBe(200);
        expect(result.value.eventsMatched).toBe(50);
      }
    } finally {
      await removeTempDir(tempDir);
    }
  });

  test("remove deletes checkpoint", async () => {
    const tempDir = await makeTempDir();
    const layer = buildLayer(tempDir);

    try {
      const program = Effect.gen(function* () {
        const store = yield* ViewCheckpointStore;
        const manager = yield* StoreManager;

        yield* manager.createStore(sampleViewName, defaultStoreConfig);
        yield* store.save(sampleCheckpoint);
        yield* store.remove(sampleViewName, sampleSourceName);
        return yield* store.load(sampleViewName, sampleSourceName);
      });

      const result = await Effect.runPromise(program.pipe(Effect.provide(layer)));

      expect(Option.isNone(result)).toBe(true);
    } finally {
      await removeTempDir(tempDir);
    }
  });

  test("remove ignores missing checkpoint", async () => {
    const tempDir = await makeTempDir();
    const layer = buildLayer(tempDir);

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* ViewCheckpointStore;
          const manager = yield* StoreManager;

          yield* manager.createStore(sampleViewName, defaultStoreConfig);
          yield* store.remove(sampleViewName, sampleSourceName);
        }).pipe(Effect.provide(layer))
      );
    } finally {
      await removeTempDir(tempDir);
    }
  });
});
