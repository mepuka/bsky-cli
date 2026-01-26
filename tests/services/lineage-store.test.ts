import { describe, expect, test } from "bun:test";
import { Effect, Layer, Option, Schema } from "effect";
import * as KeyValueStore from "@effect/platform/KeyValueStore";
import { LineageStore } from "../../src/services/lineage-store.js";
import { StoreLineage, StoreSource } from "../../src/domain/derivation.js";
import { StoreName } from "../../src/domain/primitives.js";

const sampleStoreName = Schema.decodeUnknownSync(StoreName)("arsenal-links");
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

const testLayer = LineageStore.layer.pipe(
  Layer.provideMerge(KeyValueStore.layerMemory)
);

describe("LineageStore", () => {
  test("save writes lineage to KV store", async () => {
    const program = Effect.gen(function* () {
      const store = yield* LineageStore;
      const kv = yield* KeyValueStore.KeyValueStore;

      yield* store.save(sampleLineage);

      const lineages = kv.forSchema(StoreLineage);
      const key = `stores/${sampleLineage.storeName}/lineage`;
      const stored = yield* lineages.get(key);

      return stored;
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(testLayer)));

    expect(Option.isSome(result)).toBe(true);
    if (Option.isSome(result)) {
      expect(result.value).toEqual(sampleLineage);
    }
  });

  test("get retrieves saved lineage", async () => {
    const program = Effect.gen(function* () {
      const store = yield* LineageStore;

      yield* store.save(sampleLineage);
      const loaded = yield* store.get(sampleStoreName);

      return loaded;
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(testLayer)));

    expect(Option.isSome(result)).toBe(true);
    if (Option.isSome(result)) {
      expect(result.value).toEqual(sampleLineage);
    }
  });

  test("get returns None when lineage does not exist", async () => {
    const program = Effect.gen(function* () {
      const store = yield* LineageStore;
      const nonExistentStore = Schema.decodeUnknownSync(StoreName)("nonexistent");

      const loaded = yield* store.get(nonExistentStore);

      return loaded;
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(testLayer)));

    expect(Option.isNone(result)).toBe(true);
  });

  test("save overwrites existing lineage", async () => {
    const program = Effect.gen(function* () {
      const store = yield* LineageStore;

      yield* store.save(sampleLineage);

      const updated = Schema.decodeUnknownSync(StoreLineage)({
        ...sampleLineage,
        sources: [
          ...sampleLineage.sources,
          {
            storeName: "another-source",
            filter: { _tag: "None" },
            filterHash: "def456",
            evaluationMode: "DeriveTime",
            derivedAt: "2026-01-02T00:00:00.000Z"
          }
        ],
        updatedAt: "2026-01-02T00:00:00.000Z"
      });

      yield* store.save(updated);
      const loaded = yield* store.get(sampleStoreName);

      return loaded;
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(testLayer)));

    expect(Option.isSome(result)).toBe(true);
    if (Option.isSome(result)) {
      expect(result.value.sources.length).toBe(2);
      expect(result.value.sources[1].storeName).toBe("another-source");
    }
  });
});
