import { describe, expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";
import { FileSystem } from "@effect/platform";
import * as KeyValueStore from "@effect/platform/KeyValueStore";
import { BunContext } from "@effect/platform-bun";
import { StoreManager } from "../../src/services/store-manager.js";
import { StoreDb } from "../../src/services/store-db.js";
import { StoreEventLog } from "../../src/services/store-event-log.js";
import { StoreIndex } from "../../src/services/store-index.js";
import { StoreSources } from "../../src/services/store-sources.js";
import { LineageStore } from "../../src/services/lineage-store.js";
import { StoreTopology } from "../../src/services/store-topology.js";
import { AppConfigService, ConfigOverrides } from "../../src/services/app-config.js";
import { StoreConfig } from "../../src/domain/store.js";
import { StoreLineage, StoreSource } from "../../src/domain/derivation.js";
import { all, filterExprSignature } from "../../src/domain/filter.js";
import { TimelineSource } from "../../src/domain/store-sources.js";
import { StoreName } from "../../src/domain/primitives.js";

const sampleConfig = Schema.decodeUnknownSync(StoreConfig)({
  format: { json: true, markdown: false },
  autoSync: false,
  filters: []
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
  const sourcesLayer = StoreSources.layer.pipe(Layer.provideMerge(storeDbLayer));
  const lineageLayer = LineageStore.layer.pipe(Layer.provide(KeyValueStore.layerMemory));
  const topologyLayer = StoreTopology.layer.pipe(
    Layer.provideMerge(managerLayer),
    Layer.provideMerge(indexLayer),
    Layer.provideMerge(lineageLayer),
    Layer.provideMerge(sourcesLayer)
  );

  return Layer.mergeAll(
    appConfigLayer,
    storeDbLayer,
    eventLogLayer,
    indexLayer,
    managerLayer,
    sourcesLayer,
    lineageLayer,
    topologyLayer
  ).pipe(Layer.provideMerge(BunContext.layer));
};

describe("StoreTopology", () => {
  test("builds nodes and lineage edges", async () => {
    const tempDir = await makeTempDir();
    const layer = buildLayer(tempDir);

    const program = Effect.gen(function* () {
      const manager = yield* StoreManager;
      const sources = yield* StoreSources;
      const lineageStore = yield* LineageStore;
      const topology = yield* StoreTopology;

      const storeA = yield* manager.createStore(
        Schema.decodeUnknownSync(StoreName)("alpha"),
        sampleConfig
      );
      const storeB = yield* manager.createStore(
        Schema.decodeUnknownSync(StoreName)("bravo"),
        sampleConfig
      );

      const timelineSource = TimelineSource.make({
        addedAt: new Date("2026-02-02T00:00:00.000Z"),
        enabled: true
      });
      yield* sources.add(storeA, timelineSource);

      const filter = all();
      const lineage = StoreLineage.make({
        storeName: storeB.name,
        isDerived: true,
        sources: [
          StoreSource.make({
            storeName: storeA.name,
            filter,
            filterHash: filterExprSignature(filter),
            evaluationMode: "EventTime",
            derivedAt: new Date("2026-02-02T00:00:00.000Z")
          })
        ],
        updatedAt: new Date("2026-02-02T00:00:00.000Z")
      });
      yield* lineageStore.save(lineage);

      return yield* topology.build();
    });

    try {
      const result = await Effect.runPromise(program.pipe(Effect.provide(layer)));
      expect(result.roots).toContain("alpha");
      expect(result.nodes.length).toBe(2);
      const byName = new Map(result.nodes.map((node) => [node.name, node]));
      expect(byName.get("alpha")?.sources).toBe(1);
      expect(byName.get("bravo")?.derived).toBe(true);
      expect(result.edges.length).toBe(1);
      expect(result.edges[0]?.source).toBe("alpha");
      expect(result.edges[0]?.target).toBe("bravo");
    } finally {
      await removeTempDir(tempDir);
    }
  });
});
