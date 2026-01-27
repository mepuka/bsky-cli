import { describe, expect, test } from "bun:test";
import { Effect, Layer, Option, Schema } from "effect";
import { FileSystem } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import * as KeyValueStore from "@effect/platform/KeyValueStore";
import { ViewCheckpointStore } from "../../src/services/view-checkpoint-store.js";
import { DerivationCheckpoint } from "../../src/domain/derivation.js";
import { StoreName, Timestamp } from "../../src/domain/primitives.js";

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

const testLayer = ViewCheckpointStore.layer.pipe(
  Layer.provideMerge(KeyValueStore.layerMemory)
);

describe("ViewCheckpointStore", () => {
  test("save writes checkpoint to KV store", async () => {
    const program = Effect.gen(function* () {
      const store = yield* ViewCheckpointStore;
      const kv = yield* KeyValueStore.KeyValueStore;

      yield* store.save(sampleCheckpoint);

      const checkpoints = kv.forSchema(DerivationCheckpoint);
      const key = `stores/${sampleCheckpoint.viewName}/checkpoints/derivation/${sampleCheckpoint.sourceStore}`;
      const stored = yield* checkpoints.get(key);

      return stored;
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(testLayer)));

    expect(Option.isSome(result)).toBe(true);
    if (Option.isSome(result)) {
      expect(result.value).toEqual(sampleCheckpoint);
    }
  });

  test("load retrieves saved checkpoint", async () => {
    const program = Effect.gen(function* () {
      const store = yield* ViewCheckpointStore;

      yield* store.save(sampleCheckpoint);
      const loaded = yield* store.load(sampleViewName, sampleSourceName);

      return loaded;
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(testLayer)));

    expect(Option.isSome(result)).toBe(true);
    if (Option.isSome(result)) {
      expect(result.value).toEqual(sampleCheckpoint);
    }
  });

  test("load returns None when checkpoint does not exist", async () => {
    const program = Effect.gen(function* () {
      const store = yield* ViewCheckpointStore;
      const nonExistentView = Schema.decodeUnknownSync(StoreName)("nonexistent");
      const nonExistentSource = Schema.decodeUnknownSync(StoreName)("nonexistent-source");

      const loaded = yield* store.load(nonExistentView, nonExistentSource);

      return loaded;
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(testLayer)));

    expect(Option.isNone(result)).toBe(true);
  });

  test("save overwrites existing checkpoint", async () => {
    const program = Effect.gen(function* () {
      const store = yield* ViewCheckpointStore;

      yield* store.save(sampleCheckpoint);

      const updated = Schema.decodeUnknownSync(DerivationCheckpoint)({
        ...sampleCheckpoint,
        eventsProcessed: 200,
        eventsMatched: 50,
        updatedAt: "2026-01-02T00:00:00.000Z"
      });

      yield* store.save(updated);
      const loaded = yield* store.load(sampleViewName, sampleSourceName);

      return loaded;
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(testLayer)));

    expect(Option.isSome(result)).toBe(true);
    if (Option.isSome(result)) {
      expect(result.value.eventsProcessed).toBe(200);
      expect(result.value.eventsMatched).toBe(50);
    }
  });

  test("remove deletes checkpoint", async () => {
    const program = Effect.gen(function* () {
      const store = yield* ViewCheckpointStore;

      yield* store.save(sampleCheckpoint);
      yield* store.remove(sampleViewName, sampleSourceName);
      const loaded = yield* store.load(sampleViewName, sampleSourceName);

      return loaded;
    });

    const result = await Effect.runPromise(program.pipe(Effect.provide(testLayer)));

    expect(Option.isNone(result)).toBe(true);
  });

  test("remove ignores missing checkpoint in filesystem stores", async () => {
    const tempDir = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.makeTempDirectory();
      }).pipe(Effect.provide(BunContext.layer))
    );

    const fsLayer = ViewCheckpointStore.layer.pipe(
      Layer.provideMerge(KeyValueStore.layerFileSystem(tempDir)),
      Layer.provideMerge(BunContext.layer)
    );

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* ViewCheckpointStore;
          yield* store.remove(sampleViewName, sampleSourceName);
        }).pipe(Effect.provide(fsLayer))
      );
    } finally {
      await Effect.runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.remove(tempDir, { recursive: true });
        }).pipe(Effect.provide(BunContext.layer))
      );
    }
  });
});
