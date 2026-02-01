import { describe, expect, test } from "bun:test";
import { ConfigProvider, Effect, Layer, Option } from "effect";
import { FileSystem } from "@effect/platform";
import { BunContext } from "@effect/platform-bun";
import * as KeyValueStore from "@effect/platform/KeyValueStore";
import * as Persistence from "@effect/experimental/Persistence";
import { AppConfigService, ConfigOverrides } from "../../src/services/app-config.js";
import { ImageFetcher } from "../../src/services/images/image-fetcher.js";
import { ImageArchive } from "../../src/services/images/image-archive.js";
import { ImageCache } from "../../src/services/images/image-cache.js";
import { ImageConfig } from "../../src/services/images/image-config.js";
import { ImagePipeline } from "../../src/services/images/image-pipeline.js";

const envProvider = (entries: Array<readonly [string, string]>) =>
  Layer.setConfigProvider(ConfigProvider.fromMap(new Map(entries)));

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

const makeFetcherLayer = (onFetch: () => void) => {
  const fetch = (url: string) => {
    onFetch();
    return Effect.succeed({
      url,
      status: 200,
      contentType: "image/png",
      bytes: new Uint8Array([1, 2, 3])
    });
  };

  return Layer.succeed(
    ImageFetcher,
    ImageFetcher.of({
      fetch,
      fetchMany: (urls) => Effect.forEach(urls, (url) => fetch(url))
    })
  );
};

const buildLayer = (storeRoot: string, entries: Array<readonly [string, string]>, fetcherLayer: Layer.Layer<ImageFetcher>) => {
  const overrides = Layer.succeed(ConfigOverrides, { storeRoot });
  const appConfigLayer = AppConfigService.layer.pipe(Layer.provide(overrides));
  const imageConfigLayer = ImageConfig.layer.pipe(
    Layer.provideMerge(appConfigLayer)
  );
  const imageArchiveLayer = ImageArchive.layer.pipe(
    Layer.provideMerge(imageConfigLayer)
  );
  const persistenceLayer = Persistence.layerResultKeyValueStore.pipe(
    Layer.provide(KeyValueStore.layerMemory)
  );
  const imageCacheLayer = ImageCache.layer.pipe(
    Layer.provideMerge(imageConfigLayer),
    Layer.provideMerge(imageArchiveLayer),
    Layer.provideMerge(fetcherLayer),
    Layer.provideMerge(persistenceLayer)
  );
  const imagePipelineLayer = ImagePipeline.layer.pipe(
    Layer.provideMerge(imageConfigLayer),
    Layer.provideMerge(imageCacheLayer)
  );

  return Layer.mergeAll(
    appConfigLayer,
    imageConfigLayer,
    imageArchiveLayer,
    imageCacheLayer,
    imagePipelineLayer,
    fetcherLayer
  ).pipe(
    Layer.provideMerge(BunContext.layer),
    Layer.provide(envProvider(entries))
  );
};

describe("ImageCache", () => {
  test("stores assets and reuses cached entries", async () => {
    let calls = 0;
    const fetcherLayer = makeFetcherLayer(() => {
      calls += 1;
    });
    const tempDir = await makeTempDir();

    try {
      const layer = buildLayer(
        tempDir,
        [["SKYGENT_IMAGE_CACHE_ENABLED", "true"]],
        fetcherLayer
      );
      const program = Effect.gen(function* () {
        const cache = yield* ImageCache;
        const archive = yield* ImageArchive;
        const fs = yield* FileSystem.FileSystem;

        const cachedBefore = yield* cache.getCached(
          "https://example.com/image.png",
          "original"
        );
        const first = yield* cache.get(
          "https://example.com/image.png",
          "original"
        );
        const second = yield* cache.get(
          "https://example.com/image.png",
          "original"
        );
        const cachedAfter = yield* cache.getCached(
          "https://example.com/image.png",
          "original"
        );
        const filePath = archive.resolvePath(first);
        const exists = yield* fs.exists(filePath);

        return { cachedBefore, cachedAfter, exists, first, second };
      });

      const result = await Effect.runPromise(program.pipe(Effect.provide(layer)));

      expect(calls).toBe(1);
      expect(Option.isNone(result.cachedBefore)).toBe(true);
      expect(Option.isSome(result.cachedAfter)).toBe(true);
      expect(result.exists).toBe(true);
      expect(result.first.path).toBe(result.second.path);
    } finally {
      await removeTempDir(tempDir);
    }
  });
});

describe("ImagePipeline", () => {
  test("respects disabled cache", async () => {
    let calls = 0;
    const fetcherLayer = makeFetcherLayer(() => {
      calls += 1;
    });
    const tempDir = await makeTempDir();

    try {
      const layer = buildLayer(
        tempDir,
        [["SKYGENT_IMAGE_CACHE_ENABLED", "false"]],
        fetcherLayer
      );
      const program = Effect.gen(function* () {
        const pipeline = yield* ImagePipeline;
        return yield* pipeline.ensureCached(
          "https://example.com/image.png",
          "original"
        );
      });

      const result = await Effect.runPromise(program.pipe(Effect.provide(layer)));

      expect(calls).toBe(0);
      expect(Option.isNone(result)).toBe(true);
    } finally {
      await removeTempDir(tempDir);
    }
  });

  test("caches when enabled", async () => {
    let calls = 0;
    const fetcherLayer = makeFetcherLayer(() => {
      calls += 1;
    });
    const tempDir = await makeTempDir();

    try {
      const layer = buildLayer(
        tempDir,
        [["SKYGENT_IMAGE_CACHE_ENABLED", "true"]],
        fetcherLayer
      );
      const program = Effect.gen(function* () {
        const pipeline = yield* ImagePipeline;
        return yield* pipeline.ensureCached(
          "https://example.com/image.png",
          "original"
        );
      });

      const result = await Effect.runPromise(program.pipe(Effect.provide(layer)));

      expect(calls).toBe(1);
      expect(Option.isSome(result)).toBe(true);
    } finally {
      await removeTempDir(tempDir);
    }
  });
});
