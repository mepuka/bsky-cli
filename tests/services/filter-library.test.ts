import { describe, expect, test } from "bun:test";
import { FileSystem, Path } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import { Effect, Layer, Schema } from "effect";
import { FilterLibrary } from "../../src/services/filter-library.js";
import { AppConfigService, ConfigOverrides } from "../../src/services/app-config.js";
import { StoreName } from "../../src/domain/primitives.js";

const buildLayer = (storeRoot: string) => {
  const overrides = Layer.succeed(ConfigOverrides, { storeRoot });
  const appConfigLayer = AppConfigService.layer.pipe(Layer.provide(overrides));
  const libraryLayer = FilterLibrary.layer.pipe(Layer.provideMerge(appConfigLayer));
  const baseLayer = Layer.mergeAll(appConfigLayer, libraryLayer);
  return baseLayer.pipe(Layer.provideMerge(BunContext.layer));
};

describe("FilterLibrary", () => {
  test("saves and retrieves filters", async () => {
    const tempDir = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.makeTempDirectory();
      }).pipe(Effect.provide(BunContext.layer))
    );

    const layer = buildLayer(tempDir);

    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const library = yield* FilterLibrary;
          const name = Schema.decodeUnknownSync(StoreName)("tech");

          yield* library.save(name, { _tag: "Hashtag", tag: "#tech" });

          const list = yield* library.list();
          const expr = yield* library.get(name);

          return { list, expr };
        }).pipe(Effect.provide(layer))
      );

      expect(result.list).toContain("tech");
      expect(result.expr).toMatchObject({ _tag: "Hashtag", tag: "#tech" });
    } finally {
      await Effect.runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.remove(tempDir, { recursive: true });
        }).pipe(Effect.provide(BunContext.layer))
      );
    }
  });

  test("validateAll reports invalid filters", async () => {
    const tempDir = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.makeTempDirectory();
      }).pipe(Effect.provide(BunContext.layer))
    );

    const layer = buildLayer(tempDir);

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const filtersDir = path.join(tempDir, "filters");
          yield* fs.makeDirectory(filtersDir, { recursive: true });
          yield* fs.writeFileString(path.join(filtersDir, "broken.json"), "{");
        }).pipe(Effect.provide(BunContext.layer))
      );

      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const library = yield* FilterLibrary;
          return yield* library.validateAll();
        }).pipe(Effect.provide(layer))
      );

      expect(result.length).toBe(1);
      expect(result[0]?.ok).toBe(false);
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
