import { describe, expect, test } from "bun:test";
import { Chunk, Effect, Option, Schema } from "effect";
import { StoreManager } from "../../src/services/store-manager.js";
import { StoreConfig } from "../../src/domain/store.js";
import { StoreName } from "../../src/domain/primitives.js";
import { buildStoreCoreLayer } from "../support/layers.js";
import { makeTempDir, removeTempDir } from "../support/temp-dir.js";

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
const buildLayer = (storeRoot: string) => buildStoreCoreLayer(storeRoot);

describe("StoreManager", () => {
  test("createStore persists metadata + config", async () => {
    const program = Effect.gen(function* () {
      const manager = yield* StoreManager;
      const ref = yield* manager.createStore(sampleName, sampleConfig);
      const meta = yield* manager.getStore(sampleName);
      const config = yield* manager.getConfig(sampleName);

      return { ref, meta, config };
    });

    const tempDir = await makeTempDir();
    try {
      const layer = buildLayer(tempDir);
      const result = await Effect.runPromise(program.pipe(Effect.provide(layer)));

      expect(result.ref.name).toBe(sampleName);
      expect(String(result.ref.root)).toBe(`stores/${sampleName}`);
      expect(Option.isSome(result.meta)).toBe(true);
      expect(Option.isSome(result.config)).toBe(true);
    } finally {
      await removeTempDir(tempDir);
    }
  });

  test("createStore is idempotent and listStores is stable", async () => {
    const program = Effect.gen(function* () {
      const manager = yield* StoreManager;
      yield* manager.createStore(sampleName, sampleConfig);
      yield* manager.createStore(sampleName, sampleConfig);
      return yield* manager.listStores();
    });

    const tempDir = await makeTempDir();
    try {
      const layer = buildLayer(tempDir);
      const result = await Effect.runPromise(program.pipe(Effect.provide(layer)));

      const entries = Chunk.toReadonlyArray(result);
      expect(entries.length).toBe(1);
      expect(entries[0]).toBeDefined();
      if (entries[0]) {
        expect(entries[0].name).toBe(sampleName);
      }
    } finally {
      await removeTempDir(tempDir);
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

    const tempDir = await makeTempDir();
    try {
      const layer = buildLayer(tempDir);
      const result = await Effect.runPromise(program.pipe(Effect.provide(layer)));

      expect(Option.isSome(result.found)).toBe(true);
      expect(Option.isSome(result.config)).toBe(true);
      expect(Option.isNone(result.missing)).toBe(true);
    } finally {
      await removeTempDir(tempDir);
    }
  });
});
