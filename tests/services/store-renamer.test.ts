import { describe, expect, test } from "bun:test";
import { Effect, Layer, Option, Schema } from "effect";
import { BunContext } from "@effect/platform-bun";
import { FileSystem, Path } from "@effect/platform";
import * as KeyValueStore from "@effect/platform/KeyValueStore";
import { StoreRenamer } from "../../src/services/store-renamer.js";
import { StoreManager } from "../../src/services/store-manager.js";
import { StoreDb } from "../../src/services/store-db.js";
import { LineageStore } from "../../src/services/lineage-store.js";
import { ViewCheckpointStore } from "../../src/services/view-checkpoint-store.js";
import { AppConfigService, ConfigOverrides } from "../../src/services/app-config.js";
import { defaultStoreConfig } from "../../src/domain/defaults.js";
import { StoreLineage, DerivationCheckpoint } from "../../src/domain/derivation.js";
import { StoreName } from "../../src/domain/primitives.js";

const sourceName = Schema.decodeUnknownSync(StoreName)("arsenal");
const derivedName = Schema.decodeUnknownSync(StoreName)("arsenal-links");
const renamedSourceName = Schema.decodeUnknownSync(StoreName)("arsenal-archive");
const renamedDerivedName = Schema.decodeUnknownSync(StoreName)("arsenal-links-2026");

const sampleLineage = Schema.decodeUnknownSync(StoreLineage)({
  storeName: "arsenal-links",
  isDerived: true,
  sources: [
    {
      storeName: "arsenal",
      filter: { _tag: "All" },
      filterHash: "abc123",
      evaluationMode: "EventTime",
      derivedAt: "2026-01-01T00:00:00.000Z"
    }
  ],
  updatedAt: "2026-01-01T00:00:00.000Z"
});

const sampleCheckpoint = Schema.decodeUnknownSync(DerivationCheckpoint)({
  viewName: "arsenal-links",
  sourceStore: "arsenal",
  targetStore: "arsenal-links",
  filterHash: "abc123",
  evaluationMode: "EventTime",
  eventsProcessed: 10,
  eventsMatched: 5,
  deletesPropagated: 0,
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
  const managerLayer = StoreManager.layer.pipe(Layer.provideMerge(appConfigLayer));
  const storeDbLayer = StoreDb.layer.pipe(Layer.provide(appConfigLayer));
  const lineageLayer = LineageStore.layer.pipe(
    Layer.provideMerge(KeyValueStore.layerMemory)
  );
  const viewCheckpointLayer = ViewCheckpointStore.layer.pipe(
    Layer.provideMerge(storeDbLayer),
    Layer.provideMerge(managerLayer)
  );
  const renamerLayer = StoreRenamer.layer.pipe(
    Layer.provideMerge(appConfigLayer),
    Layer.provideMerge(managerLayer),
    Layer.provideMerge(storeDbLayer),
    Layer.provideMerge(lineageLayer)
  );

  return Layer.mergeAll(
    appConfigLayer,
    managerLayer,
    storeDbLayer,
    lineageLayer,
    viewCheckpointLayer,
    renamerLayer
  ).pipe(Layer.provideMerge(BunContext.layer));
};

describe("StoreRenamer", () => {
  test("renames a source store and updates lineage sources + checkpoints", async () => {
    const tempDir = await makeTempDir();
    const layer = buildLayer(tempDir);

    try {
      const program = Effect.gen(function* () {
        const manager = yield* StoreManager;
        const renamer = yield* StoreRenamer;
        const lineageStore = yield* LineageStore;
        const checkpoints = yield* ViewCheckpointStore;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* manager.createStore(sourceName, defaultStoreConfig);
        yield* manager.createStore(derivedName, defaultStoreConfig);

        const sourceDir = path.join(tempDir, "stores", sourceName);
        yield* fs.makeDirectory(sourceDir, { recursive: true });

        yield* lineageStore.save(sampleLineage);
        yield* checkpoints.save(sampleCheckpoint);

        const result = yield* renamer.rename(sourceName, renamedSourceName);
        const renamed = yield* manager.getStore(renamedSourceName);
        const missing = yield* manager.getStore(sourceName);
        const updatedLineage = yield* lineageStore.get(derivedName);
        const oldCheckpoint = yield* checkpoints.load(derivedName, sourceName);
        const newCheckpoint = yield* checkpoints.load(derivedName, renamedSourceName);
        const newDirExists = yield* fs.exists(
          path.join(tempDir, "stores", renamedSourceName)
        );

        return {
          result,
          renamed,
          missing,
          updatedLineage,
          oldCheckpoint,
          newCheckpoint,
          newDirExists
        };
      });

      const result = await Effect.runPromise(program.pipe(Effect.provide(layer)));

      expect(result.result.moved).toBe(true);
      expect(Option.isSome(result.renamed)).toBe(true);
      expect(Option.isNone(result.missing)).toBe(true);
      expect(result.newDirExists).toBe(true);
      expect(Option.isSome(result.updatedLineage)).toBe(true);
      if (Option.isSome(result.updatedLineage)) {
        expect(result.updatedLineage.value.sources[0]?.storeName).toBe(
          renamedSourceName
        );
      }
      expect(Option.isNone(result.oldCheckpoint)).toBe(true);
      expect(Option.isSome(result.newCheckpoint)).toBe(true);
      if (Option.isSome(result.newCheckpoint)) {
        expect(result.newCheckpoint.value.sourceStore).toBe(renamedSourceName);
      }
    } finally {
      await removeTempDir(tempDir);
    }
  });

  test("renames a derived store and updates lineage key + checkpoint view", async () => {
    const tempDir = await makeTempDir();
    const layer = buildLayer(tempDir);

    try {
      const program = Effect.gen(function* () {
        const manager = yield* StoreManager;
        const renamer = yield* StoreRenamer;
        const lineageStore = yield* LineageStore;
        const checkpoints = yield* ViewCheckpointStore;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        yield* manager.createStore(sourceName, defaultStoreConfig);
        yield* manager.createStore(derivedName, defaultStoreConfig);

        const derivedDir = path.join(tempDir, "stores", derivedName);
        yield* fs.makeDirectory(derivedDir, { recursive: true });

        yield* lineageStore.save(sampleLineage);
        yield* checkpoints.save(sampleCheckpoint);

        const result = yield* renamer.rename(derivedName, renamedDerivedName);
        const renamed = yield* manager.getStore(renamedDerivedName);
        const missing = yield* manager.getStore(derivedName);
        const updatedLineage = yield* lineageStore.get(renamedDerivedName);
        const oldLineage = yield* lineageStore.get(derivedName);
        const oldCheckpoint = yield* checkpoints.load(derivedName, sourceName);
        const newCheckpoint = yield* checkpoints.load(renamedDerivedName, sourceName);
        const newDirExists = yield* fs.exists(
          path.join(tempDir, "stores", renamedDerivedName)
        );

        return {
          result,
          renamed,
          missing,
          updatedLineage,
          oldLineage,
          oldCheckpoint,
          newCheckpoint,
          newDirExists
        };
      });

      const result = await Effect.runPromise(program.pipe(Effect.provide(layer)));

      expect(result.result.moved).toBe(true);
      expect(Option.isSome(result.renamed)).toBe(true);
      expect(Option.isNone(result.missing)).toBe(true);
      expect(result.newDirExists).toBe(true);
      expect(Option.isSome(result.updatedLineage)).toBe(true);
      expect(Option.isNone(result.oldLineage)).toBe(true);
      if (Option.isSome(result.updatedLineage)) {
        expect(result.updatedLineage.value.storeName).toBe(renamedDerivedName);
      }
      expect(Option.isNone(result.oldCheckpoint)).toBe(true);
      expect(Option.isSome(result.newCheckpoint)).toBe(true);
      if (Option.isSome(result.newCheckpoint)) {
        expect(result.newCheckpoint.value.viewName).toBe(renamedDerivedName);
        expect(result.newCheckpoint.value.targetStore).toBe(renamedDerivedName);
      }
    } finally {
      await removeTempDir(tempDir);
    }
  });
});
