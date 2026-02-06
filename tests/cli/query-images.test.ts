import { Command } from "@effect/cli";
import { BunContext } from "@effect/platform-bun";
import { FileSystem, Path } from "@effect/platform";
import * as KeyValueStore from "@effect/platform/KeyValueStore";
import * as Persistence from "@effect/experimental/Persistence";
import { describe, expect, test } from "bun:test";
import { Chunk, ConfigProvider, Effect, Layer, Option, Ref, Schema, Sink, Stream } from "effect";
import { queryCommand } from "../../src/cli/query.js";
import { CliOutput, type CliOutputService } from "../../src/cli/output.js";
import { CliPreferences } from "../../src/cli/preferences.js";
import { AppConfigService, ConfigOverrides } from "../../src/services/app-config.js";
import { StoreManager } from "../../src/services/store-manager.js";
import { StoreDb } from "../../src/services/store-db.js";
import { StoreEventLog } from "../../src/services/store-event-log.js";
import { StoreIndex } from "../../src/services/store-index.js";
import { FilterRuntime } from "../../src/services/filter-runtime.js";
import { StoreConfig } from "../../src/domain/store.js";
import { EventMeta, PostEventRecord, PostUpsert } from "../../src/domain/events.js";
import { EventId, StoreName } from "../../src/domain/primitives.js";
import { Post } from "../../src/domain/post.js";
import { EmbedImage, EmbedImages } from "../../src/domain/bsky.js";
import { ImageFetcher } from "../../src/services/images/image-fetcher.js";
import { ImageArchive } from "../../src/services/images/image-archive.js";
import { ImageCache } from "../../src/services/images/image-cache.js";
import { ImageConfig } from "../../src/services/images/image-config.js";
import { ImagePipeline } from "../../src/services/images/image-pipeline.js";
import { ImageRefIndex } from "../../src/services/images/image-ref-index.js";
import { cacheSweepForStore, cacheTtlSweep } from "../../src/cli/image-cache.js";

const sampleConfig = Schema.decodeUnknownSync(StoreConfig)({
  format: { json: true, markdown: false },
  autoSync: false,
  filters: []
});

const sampleMeta = Schema.decodeUnknownSync(EventMeta)({
  source: "timeline",
  command: "sync timeline",
  createdAt: "2026-01-01T00:00:00.000Z"
});

const eventId = (value: string) => Schema.decodeUnknownSync(EventId)(value);

const makePostWithImages = () =>
  Schema.decodeUnknownSync(Post)({
    uri: "at://did:plc:example/app.bsky.feed.post/1",
    author: "alice.bsky",
    text: "Photo post",
    createdAt: "2026-01-01T00:01:00.000Z",
    hashtags: [],
    mentions: [],
    links: [],
    embed: EmbedImages.make({
      images: [
        EmbedImage.make({
          fullsize: "https://example.com/full.png",
          thumb: "https://example.com/thumb.png",
          alt: "Example image"
        })
      ]
    })
  });

const makePostWithoutImages = () =>
  Schema.decodeUnknownSync(Post)({
    uri: "at://did:plc:example/app.bsky.feed.post/2",
    author: "alice.bsky",
    text: "Text-only post",
    createdAt: "2026-01-01T00:00:00.000Z",
    hashtags: [],
    mentions: [],
    links: []
  });

const makeRecord = (post: Post, id: string) =>
  PostEventRecord.make({
    id: eventId(id),
    version: 1,
    event: PostUpsert.make({ post, meta: sampleMeta })
  });

const ensureNewline = (value: string) => (value.endsWith("\n") ? value : `${value}\n`);

const decodeChunk = (chunk: string | Uint8Array) =>
  typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);

const makeOutputCapture = () => {
  const stdoutRef = Ref.unsafeMake<ReadonlyArray<string>>([]);
  const stderrRef = Ref.unsafeMake<ReadonlyArray<string>>([]);

  const append = (ref: Ref.Ref<ReadonlyArray<string>>, chunk: string | Uint8Array) =>
    Ref.update(ref, (items) => [...items, decodeChunk(chunk)]);

  const stdoutSink = Sink.forEach((chunk: string | Uint8Array) =>
    append(stdoutRef, chunk)
  );
  const stderrSink = Sink.forEach((chunk: string | Uint8Array) =>
    append(stderrRef, chunk)
  );

  const writeJson = (value: unknown, pretty?: boolean) =>
    append(stdoutRef, ensureNewline(JSON.stringify(value, null, pretty ? 2 : 0)));

  const writeText = (value: string) =>
    append(stdoutRef, ensureNewline(value));

  const writeJsonStream = <A, E, R>(stream: Stream.Stream<A, E, R>) =>
    stream.pipe(
      Stream.map((value) => `${JSON.stringify(value)}\n`),
      Stream.run(stdoutSink)
    );

  const writeStderr = (value: string) =>
    append(stderrRef, ensureNewline(value));

  const service: CliOutputService = {
    stdout: stdoutSink,
    stderr: stderrSink,
    writeJson,
    writeText,
    writeJsonStream,
    writeStderr
  };

  const layer = Layer.succeed(CliOutput, CliOutput.of(service));

  return { layer, stdoutRef, stderrRef };
};

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
    ImageFetcher.make({
      fetch,
      fetchMany: (urls) => Effect.forEach(urls, (url) => fetch(url))
    })
  );
};

const buildLayer = (
  storeRoot: string,
  entries: Array<readonly [string, string]>,
  fetcherLayer: Layer.Layer<ImageFetcher>
) => {
  const overrides = Layer.succeed(ConfigOverrides, { storeRoot });
  const appConfigLayer = AppConfigService.layer.pipe(Layer.provide(overrides));
  const storeDbLayer = StoreDb.layer.pipe(Layer.provideMerge(appConfigLayer));
  const eventLogLayer = StoreEventLog.layer.pipe(Layer.provideMerge(storeDbLayer));
  const indexLayer = StoreIndex.layer.pipe(
    Layer.provideMerge(storeDbLayer),
    Layer.provideMerge(eventLogLayer)
  );
  const managerLayer = StoreManager.layer.pipe(Layer.provideMerge(appConfigLayer));
  const filterRuntimeLayer = Layer.succeed(
    FilterRuntime,
    FilterRuntime.make({
      evaluate: () => Effect.succeed(() => Effect.succeed(true)),
      evaluateWithMetadata: () => Effect.succeed(() => Effect.succeed({ ok: true })),
      evaluateBatch: () =>
        Effect.succeed((posts) => Effect.succeed(Chunk.map(posts, () => true))),
      explain: () => Effect.succeed(() => Effect.succeed({ ok: true, reasons: [] }))
    })
  );
  const imageConfigLayer = ImageConfig.layer.pipe(
    Layer.provideMerge(appConfigLayer)
  );
  const imageArchiveLayer = ImageArchive.layer.pipe(
    Layer.provideMerge(imageConfigLayer)
  );
  const persistenceLayer = Persistence.layerResultKeyValueStore.pipe(
    Layer.provide(KeyValueStore.layerMemory)
  );
  const imageRefIndexLayer = ImageRefIndex.layer.pipe(
    Layer.provideMerge(persistenceLayer)
  );
  const imageCacheLayer = ImageCache.layer.pipe(
    Layer.provideMerge(imageConfigLayer),
    Layer.provideMerge(imageArchiveLayer),
    Layer.provideMerge(fetcherLayer),
    Layer.provideMerge(persistenceLayer),
    Layer.provideMerge(imageRefIndexLayer)
  );
  const imagePipelineLayer = ImagePipeline.layer.pipe(
    Layer.provideMerge(imageConfigLayer),
    Layer.provideMerge(imageCacheLayer)
  );

  return Layer.mergeAll(
    appConfigLayer,
    storeDbLayer,
    eventLogLayer,
    indexLayer,
    managerLayer,
    filterRuntimeLayer,
    imageConfigLayer,
    imageArchiveLayer,
    imageCacheLayer,
    imageRefIndexLayer,
    imagePipelineLayer,
    fetcherLayer
  ).pipe(
    Layer.provideMerge(BunContext.layer),
    Layer.provide(envProvider(entries))
  );
};

const setupAppLayer = (
  storeRoot: string,
  entries: Array<readonly [string, string]>,
  fetcherLayer: Layer.Layer<ImageFetcher>
) => {
  const { layer: outputLayer, stdoutRef } = makeOutputCapture();
  const appLayer = Layer.mergeAll(
    outputLayer,
    Layer.succeed(CliPreferences, { compact: false }),
    buildLayer(storeRoot, entries, fetcherLayer)
  );
  return { appLayer, stdoutRef };
};

const parseJson = (stdout: ReadonlyArray<string>) =>
  JSON.parse(stdout.join("").trim());

const parseNdjson = (stdout: ReadonlyArray<string>) =>
  stdout
    .join("")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));

describe("query image cache integration", () => {
  test("resolve-images rewrites URLs without fetching", async () => {
    let calls = 0;
    const fetcherLayer = makeFetcherLayer(() => {
      calls += 1;
    });
    const tempDir = await makeTempDir();
    const { appLayer, stdoutRef } = setupAppLayer(
      tempDir,
      [["SKYGENT_IMAGE_CACHE_ENABLED", "true"]],
      fetcherLayer
    );
    const run = Command.run(queryCommand, { name: "skygent", version: "0.0.0" });

    try {
      const { fullPath, thumbPath, callsBefore } = await Effect.runPromise(
        Effect.gen(function* () {
          const manager = yield* StoreManager;
          const index = yield* StoreIndex;
          const cache = yield* ImageCache;
          const archive = yield* ImageArchive;

          const store = yield* manager.createStore(
            Schema.decodeUnknownSync(StoreName)("images"),
            sampleConfig
          );
          const post = makePostWithImages();
          yield* index.apply(store, makeRecord(post, "01ARZ3NDEKTSV4RRFFQ69G5FAV"));

          const fullAsset = yield* cache.get(
            "https://example.com/full.png",
            "original"
          );
          const thumbAsset = yield* cache.get(
            "https://example.com/thumb.png",
            "thumb"
          );
          const callsBefore = calls;

          yield* run([
            "node",
            "skygent",
            "images",
            "--fields",
            "@images",
            "--resolve-images",
            "--format",
            "json"
          ]);

          return {
            fullPath: archive.resolvePath(fullAsset),
            thumbPath: archive.resolvePath(thumbAsset),
            callsBefore
          };
        }).pipe(Effect.provide(appLayer))
      );

      const stdout = await Effect.runPromise(Ref.get(stdoutRef));
      const payload = parseJson(stdout) as Array<{ images?: Array<{ fullsizeUrl: string; thumbUrl: string }> }>;
      const image = payload[0]?.images?.[0];

      expect(image.fullsizeUrl).toBe(fullPath);
      expect(image.thumbUrl).toBe(thumbPath);
      expect(calls).toBe(callsBefore);
    } finally {
      await removeTempDir(tempDir);
    }
  });

  test("cache-images fetches and resolves URLs", async () => {
    let calls = 0;
    const fetcherLayer = makeFetcherLayer(() => {
      calls += 1;
    });
    const tempDir = await makeTempDir();
    const { appLayer, stdoutRef } = setupAppLayer(
      tempDir,
      [["SKYGENT_IMAGE_CACHE_ENABLED", "true"]],
      fetcherLayer
    );
    const run = Command.run(queryCommand, { name: "skygent", version: "0.0.0" });

    try {
      const { fullPath, thumbPath } = await Effect.runPromise(
        Effect.gen(function* () {
          const manager = yield* StoreManager;
          const index = yield* StoreIndex;
          const cache = yield* ImageCache;
          const archive = yield* ImageArchive;

          const store = yield* manager.createStore(
            Schema.decodeUnknownSync(StoreName)("images"),
            sampleConfig
          );
          const post = makePostWithImages();
          yield* index.apply(store, makeRecord(post, "01ARZ3NDEKTSV4RRFFQ69G5FAW"));

          yield* run([
            "node",
            "skygent",
            "images",
            "--fields",
            "@images",
            "--cache-images",
            "--format",
            "json"
          ]);

          const cachedFull = yield* cache.getCached(
            "https://example.com/full.png",
            "original"
          );
          const cachedThumb = yield* cache.getCached(
            "https://example.com/thumb.png",
            "thumb"
          );

          return {
            fullPath: Option.match(cachedFull, {
              onNone: () => undefined,
              onSome: (asset) => archive.resolvePath(asset)
            }),
            thumbPath: Option.match(cachedThumb, {
              onNone: () => undefined,
              onSome: (asset) => archive.resolvePath(asset)
            })
          };
        }).pipe(Effect.provide(appLayer))
      );

      const stdout = await Effect.runPromise(Ref.get(stdoutRef));
      const payload = parseJson(stdout) as Array<{ images?: Array<{ fullsizeUrl: string; thumbUrl: string }> }>;
      const image = payload[0]?.images?.[0];

      expect(image.fullsizeUrl).toBe(fullPath);
      expect(image.thumbUrl).toBe(thumbPath);
      expect(calls).toBe(2);
    } finally {
      await removeTempDir(tempDir);
    }
  });

  test("extract-images outputs json image rows", async () => {
    const fetcherLayer = makeFetcherLayer(() => undefined);
    const tempDir = await makeTempDir();
    const { appLayer, stdoutRef } = setupAppLayer(tempDir, [], fetcherLayer);
    const run = Command.run(queryCommand, { name: "skygent", version: "0.0.0" });

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const manager = yield* StoreManager;
          const index = yield* StoreIndex;

          const store = yield* manager.createStore(
            Schema.decodeUnknownSync(StoreName)("images"),
            sampleConfig
          );
          const post = makePostWithImages();
          yield* index.apply(store, makeRecord(post, "01ARZ3NDEKTSV4RRFFQ69G5FAX"));

          yield* run([
            "node",
            "skygent",
            "images",
            "--extract-images",
            "--format",
            "json"
          ]);
        }).pipe(Effect.provide(appLayer))
      );

      const stdout = await Effect.runPromise(Ref.get(stdoutRef));
      const payload = parseJson(stdout) as Array<{ postUri: string; imageUrl: string; thumbUrl: string; alt?: string }>;
      expect(payload).toHaveLength(1);
      expect(payload[0]).toMatchObject({
        postUri: "at://did:plc:example/app.bsky.feed.post/1",
        imageUrl: "https://example.com/full.png",
        thumbUrl: "https://example.com/thumb.png"
      });
    } finally {
      await removeTempDir(tempDir);
    }
  });

  test("extract-images outputs ndjson image rows", async () => {
    const fetcherLayer = makeFetcherLayer(() => undefined);
    const tempDir = await makeTempDir();
    const { appLayer, stdoutRef } = setupAppLayer(tempDir, [], fetcherLayer);
    const run = Command.run(queryCommand, { name: "skygent", version: "0.0.0" });

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const manager = yield* StoreManager;
          const index = yield* StoreIndex;

          const store = yield* manager.createStore(
            Schema.decodeUnknownSync(StoreName)("images"),
            sampleConfig
          );
          const post = makePostWithImages();
          yield* index.apply(store, makeRecord(post, "01ARZ3NDEKTSV4RRFFQ69G5FAY"));

          yield* run([
            "node",
            "skygent",
            "images",
            "--extract-images",
            "--format",
            "ndjson"
          ]);
        }).pipe(Effect.provide(appLayer))
      );

      const stdout = await Effect.runPromise(Ref.get(stdoutRef));
      const payload = parseNdjson(stdout) as Array<{ postUri: string; imageUrl: string; thumbUrl: string }>;
      expect(payload).toHaveLength(1);
      expect(payload[0]).toMatchObject({
        postUri: "at://did:plc:example/app.bsky.feed.post/1",
        imageUrl: "https://example.com/full.png",
        thumbUrl: "https://example.com/thumb.png"
      });
    } finally {
      await removeTempDir(tempDir);
    }
  });

  test("extract-images outputs table rows", async () => {
    const fetcherLayer = makeFetcherLayer(() => undefined);
    const tempDir = await makeTempDir();
    const { appLayer, stdoutRef } = setupAppLayer(tempDir, [], fetcherLayer);
    const run = Command.run(queryCommand, { name: "skygent", version: "0.0.0" });

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const manager = yield* StoreManager;
          const index = yield* StoreIndex;

          const store = yield* manager.createStore(
            Schema.decodeUnknownSync(StoreName)("images"),
            sampleConfig
          );
          const post = makePostWithImages();
          yield* index.apply(store, makeRecord(post, "01ARZ3NDEKTSV4RRFFQ69G5FAZ"));

          yield* run([
            "node",
            "skygent",
            "images",
            "--extract-images",
            "--format",
            "table"
          ]);
        }).pipe(Effect.provide(appLayer))
      );

      const stdout = await Effect.runPromise(Ref.get(stdoutRef));
      const output = stdout.join("");
      expect(output).toContain("Image URL");
      expect(output).toContain("https://example.com/full.png");
    } finally {
      await removeTempDir(tempDir);
    }
  });

  test("extract-images limit applies to images, not posts", async () => {
    const fetcherLayer = makeFetcherLayer(() => undefined);
    const tempDir = await makeTempDir();
    const { appLayer, stdoutRef } = setupAppLayer(tempDir, [], fetcherLayer);
    const run = Command.run(queryCommand, { name: "skygent", version: "0.0.0" });

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const manager = yield* StoreManager;
          const index = yield* StoreIndex;

          const store = yield* manager.createStore(
            Schema.decodeUnknownSync(StoreName)("images"),
            sampleConfig
          );
          const postWithout = makePostWithoutImages();
          const postWith = makePostWithImages();
          yield* index.apply(store, makeRecord(postWithout, "01ARZ3NDEKTSV4RRFFQ69G5FB0"));
          yield* index.apply(store, makeRecord(postWith, "01ARZ3NDEKTSV4RRFFQ69G5FB1"));

          yield* run([
            "node",
            "skygent",
            "images",
            "--extract-images",
            "--limit",
            "1",
            "--format",
            "ndjson"
          ]);
        }).pipe(Effect.provide(appLayer))
      );

      const stdout = await Effect.runPromise(Ref.get(stdoutRef));
      const payload = parseNdjson(stdout) as Array<{ postUri: string; imageUrl: string; thumbUrl: string }>;
      expect(payload).toHaveLength(1);
      expect(payload[0]).toMatchObject({
        postUri: "at://did:plc:example/app.bsky.feed.post/1",
        imageUrl: "https://example.com/full.png",
        thumbUrl: "https://example.com/thumb.png"
      });
    } finally {
      await removeTempDir(tempDir);
    }
  });

  test("cache-images requires images in output", async () => {
    const fetcherLayer = makeFetcherLayer(() => undefined);
    const tempDir = await makeTempDir();
    const { appLayer } = setupAppLayer(
      tempDir,
      [["SKYGENT_IMAGE_CACHE_ENABLED", "true"]],
      fetcherLayer
    );
    const run = Command.run(queryCommand, { name: "skygent", version: "0.0.0" });

    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const manager = yield* StoreManager;
          yield* manager.createStore(
            Schema.decodeUnknownSync(StoreName)("images"),
            sampleConfig
          );
          return yield* run([
            "node",
            "skygent",
            "images",
            "--fields",
            "uri",
            "--cache-images",
            "--format",
            "json"
          ]).pipe(Effect.either);
        }).pipe(Effect.provide(appLayer))
      );

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left._tag).toBe("CliInputError");
      }
    } finally {
      await removeTempDir(tempDir);
    }
  });

  test("resolve-images requires images in output", async () => {
    const fetcherLayer = makeFetcherLayer(() => undefined);
    const tempDir = await makeTempDir();
    const { appLayer } = setupAppLayer(
      tempDir,
      [["SKYGENT_IMAGE_CACHE_ENABLED", "true"]],
      fetcherLayer
    );
    const run = Command.run(queryCommand, { name: "skygent", version: "0.0.0" });

    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const manager = yield* StoreManager;
          yield* manager.createStore(
            Schema.decodeUnknownSync(StoreName)("images"),
            sampleConfig
          );
          return yield* run([
            "node",
            "skygent",
            "images",
            "--resolve-images",
            "--format",
            "json"
          ]).pipe(Effect.either);
        }).pipe(Effect.provide(appLayer))
      );

      expect(result._tag).toBe("Left");
      if (result._tag === "Left") {
        expect(result.left._tag).toBe("CliInputError");
      }
    } finally {
      await removeTempDir(tempDir);
    }
  });

  test("fields preset embeds includes embedSummary", async () => {
    const fetcherLayer = makeFetcherLayer(() => undefined);
    const tempDir = await makeTempDir();
    const { appLayer, stdoutRef } = setupAppLayer(
      tempDir,
      [["SKYGENT_IMAGE_CACHE_ENABLED", "true"]],
      fetcherLayer
    );
    const run = Command.run(queryCommand, { name: "skygent", version: "0.0.0" });

    try {
      await Effect.runPromise(
        Effect.gen(function* () {
          const manager = yield* StoreManager;
          const index = yield* StoreIndex;
          const store = yield* manager.createStore(
            Schema.decodeUnknownSync(StoreName)("images"),
            sampleConfig
          );
          const post = makePostWithImages();
          yield* index.apply(store, makeRecord(post, "01ARZ3NDEKTSV4RRFFQ69G5FAX"));

          yield* run([
            "node",
            "skygent",
            "images",
            "--fields",
            "@embeds",
            "--format",
            "json"
          ]);
        }).pipe(Effect.provide(appLayer))
      );

      const stdout = await Effect.runPromise(Ref.get(stdoutRef));
      const payload = parseJson(stdout) as Array<{ embedSummary?: { type?: string; imageSummary?: { imageCount?: number } } }>;
      const summary = payload[0]?.embedSummary;

      expect(summary?.type).toBe("images");
      expect(summary?.imageSummary?.imageCount).toBe(1);
    } finally {
      await removeTempDir(tempDir);
    }
  });

  test("cache sweep removes orphaned files", async () => {
    const fetcherLayer = makeFetcherLayer(() => undefined);
    const tempDir = await makeTempDir();
    const { appLayer } = setupAppLayer(
      tempDir,
      [["SKYGENT_IMAGE_CACHE_ENABLED", "true"]],
      fetcherLayer
    );

    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const manager = yield* StoreManager;
          const index = yield* StoreIndex;
          const cache = yield* ImageCache;
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const config = yield* ImageConfig;

          const store = yield* manager.createStore(
            Schema.decodeUnknownSync(StoreName)("images"),
            sampleConfig
          );
          const post = makePostWithImages();
          yield* index.apply(store, makeRecord(post, "01ARZ3NDEKTSV4RRFFQ69G5FAY"));

          yield* cache.get("https://example.com/full.png", "original");

          const orphanDir = path.join(config.cacheRoot, "original");
          const orphanPath = path.join(orphanDir, "orphan.bin");
          yield* fs.makeDirectory(orphanDir, { recursive: true });
          yield* fs.writeFile(orphanPath, new Uint8Array([1, 2, 3]));

          const sweep = yield* cacheSweepForStore(store, {
            includeThumbnails: false,
            remove: true
          });
          const orphanExists = yield* fs.exists(orphanPath).pipe(
            Effect.orElseSucceed(() => false)
          );

          return { sweep, orphanExists };
        }).pipe(Effect.provide(appLayer))
      );

      expect(result.sweep.orphanedFiles).toBe(1);
      expect(result.sweep.removedFiles).toBe(1);
      expect(result.orphanExists).toBe(false);
    } finally {
      await removeTempDir(tempDir);
    }
  });

  test("cache ttl sweep removes expired files", async () => {
    const fetcherLayer = makeFetcherLayer(() => undefined);
    const tempDir = await makeTempDir();
    const { appLayer } = setupAppLayer(
      tempDir,
      [
        ["SKYGENT_IMAGE_CACHE_ENABLED", "true"],
        ["SKYGENT_IMAGE_CACHE_TTL", "0 millis"]
      ],
      fetcherLayer
    );

    try {
      const result = await Effect.runPromise(
        Effect.gen(function* () {
          const cache = yield* ImageCache;
          const archive = yield* ImageArchive;
          const fs = yield* FileSystem.FileSystem;

          const asset = yield* cache.get(
            "https://example.com/full.png",
            "original"
          );
          const filePath = archive.resolvePath(asset);

          const sweep = yield* cacheTtlSweep({
            includeThumbnails: false,
            remove: true
          });
          const existsAfter = yield* fs.exists(filePath).pipe(
            Effect.orElseSucceed(() => false)
          );

          return { sweep, existsAfter };
        }).pipe(Effect.provide(appLayer))
      );

      expect(result.sweep.expiredFiles).toBe(1);
      expect(result.sweep.removedFiles).toBe(1);
      expect(result.existsAfter).toBe(false);
    } finally {
      await removeTempDir(tempDir);
    }
  });
});
