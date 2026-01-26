import { describe, expect, test } from "bun:test";
import { Chunk, Effect, Layer, Option, Schema } from "effect";
import * as KeyValueStore from "@effect/platform/KeyValueStore";
import { StoreManager } from "../../src/services/store-manager.js";
import { StoreConfig, StoreMetadata } from "../../src/domain/store.js";
import { StoreName } from "../../src/domain/primitives.js";

const sampleName = Schema.decodeUnknownSync(StoreName)("arsenal");
const otherName = Schema.decodeUnknownSync(StoreName)("milan");
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

const testLayer = StoreManager.layer.pipe(
  Layer.provideMerge(KeyValueStore.layerMemory)
);

describe("StoreManager", () => {
  test("createStore persists metadata + config", async () => {
    const program = Effect.gen(function* () {
      const manager = yield* StoreManager;
      const kv = yield* KeyValueStore.KeyValueStore;
      const metadata = kv.forSchema(StoreMetadata);
      const configs = kv.forSchema(StoreConfig);
      const manifest = kv.forSchema(Schema.Array(StoreName));

      const ref = yield* manager.createStore(sampleName, sampleConfig);
      const meta = yield* metadata.get(`stores/${sampleName}/meta`);
      const config = yield* configs.get(`stores/${sampleName}/config`);
      const manifestEntry = yield* manifest.get("stores/manifest");

      return { ref, meta, config, manifestEntry };
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(testLayer)));

    expect(result.ref.name).toBe(sampleName);
    expect(String(result.ref.root)).toBe(`stores/${sampleName}`);
    expect(Option.isSome(result.meta)).toBe(true);
    expect(Option.isSome(result.config)).toBe(true);
    expect(Option.isSome(result.manifestEntry)).toBe(true);
    if (Option.isSome(result.manifestEntry)) {
      expect(result.manifestEntry.value).toEqual([sampleName]);
    }
  });

  test("createStore is idempotent and listStores is stable", async () => {
    const program = Effect.gen(function* () {
      const manager = yield* StoreManager;
      yield* manager.createStore(sampleName, sampleConfig);
      yield* manager.createStore(sampleName, sampleConfig);
      return yield* manager.listStores();
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(testLayer)));

    const entries = Chunk.toReadonlyArray(result);
    expect(entries.length).toBe(1);
    expect(entries[0]).toBeDefined();
    if (entries[0]) {
      expect(entries[0].name).toBe(sampleName);
    }
  });

  test("getStore and getConfig return Option", async () => {
    const program = Effect.gen(function* () {
      const manager = yield* StoreManager;
      yield* manager.createStore(sampleName, sampleConfig);

      const found = yield* manager.getStore(sampleName);
      const config = yield* manager.getConfig(sampleName);
      const missing = yield* manager.getStore(otherName);

      return { found, config, missing };
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(testLayer)));

    expect(Option.isSome(result.found)).toBe(true);
    expect(Option.isSome(result.config)).toBe(true);
    expect(Option.isNone(result.missing)).toBe(true);
  });
});
