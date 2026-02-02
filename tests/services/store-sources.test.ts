import { describe, expect, test } from "bun:test";
import { Effect, Layer, Option, Schema } from "effect";
import { FileSystem } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import { StoreDb } from "../../src/services/store-db.js";
import { StoreSources } from "../../src/services/store-sources.js";
import { AppConfigService, ConfigOverrides } from "../../src/services/app-config.js";
import { StoreRef } from "../../src/domain/store.js";
import { AuthorSource, storeSourceId } from "../../src/domain/store-sources.js";
import { Did, Handle, Timestamp } from "../../src/domain/primitives.js";

const sampleStore = Schema.decodeUnknownSync(StoreRef)({
  name: "alpha",
  root: "stores/alpha"
});

const sampleAuthor = AuthorSource.make({
  actor: Schema.decodeUnknownSync(Did)("did:plc:example"),
  display: Schema.decodeUnknownSync(Handle)("alice.bsky"),
  addedAt: Schema.decodeUnknownSync(Timestamp)("2026-01-01T00:00:00.000Z"),
  enabled: true
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
  const storeSourcesLayer = StoreSources.layer.pipe(Layer.provideMerge(storeDbLayer));

  return Layer.mergeAll(
    appConfigLayer,
    storeDbLayer,
    storeSourcesLayer
  ).pipe(Layer.provideMerge(BunContext.layer));
};

describe("StoreSources", () => {
  test("add/list/get/remove sources", async () => {
    const program = Effect.gen(function* () {
      const sources = yield* StoreSources;
      const id = storeSourceId(sampleAuthor);

      yield* sources.add(sampleStore, sampleAuthor);
      const list = yield* sources.list(sampleStore);
      const fetched = yield* sources.get(sampleStore, id);

      yield* sources.setEnabled(sampleStore, id, false);
      const updated = yield* sources.get(sampleStore, id);

      const syncedAt = new Date("2026-01-02T00:00:00.000Z");
      yield* sources.markSynced(sampleStore, id, syncedAt);
      const updatedAfterSync = yield* sources.get(sampleStore, id);

      yield* sources.remove(sampleStore, id);
      const afterRemove = yield* sources.list(sampleStore);

      return { list, fetched, updated, updatedAfterSync, afterRemove, syncedAt };
    });

    const tempDir = await makeTempDir();
    try {
      const layer = buildLayer(tempDir);
      const result = await Effect.runPromise(program.pipe(Effect.provide(layer)));

      expect(result.list).toHaveLength(1);
      expect(result.list[0]?._tag).toBe("AuthorSource");

      expect(Option.isSome(result.fetched)).toBe(true);
      if (Option.isSome(result.fetched)) {
        expect(result.fetched.value.actor).toBe(sampleAuthor.actor);
      }

      expect(Option.isSome(result.updated)).toBe(true);
      if (Option.isSome(result.updated)) {
        expect(result.updated.value.enabled).toBe(false);
      }

      expect(Option.isSome(result.updatedAfterSync)).toBe(true);
      if (Option.isSome(result.updatedAfterSync)) {
        const lastSyncedAt = result.updatedAfterSync.value.lastSyncedAt;
        expect(lastSyncedAt instanceof Date).toBe(true);
        expect(lastSyncedAt?.toISOString()).toBe(result.syncedAt.toISOString());
      }

      expect(result.afterRemove).toHaveLength(0);
    } finally {
      await removeTempDir(tempDir);
    }
  });
});
