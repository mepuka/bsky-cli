import { describe, expect, test } from "bun:test";
import { Chunk, Duration, Effect, Fiber, Layer, Option, Ref, Schema, Sink, Stream, TestClock, TestContext } from "effect";
import { makeWatchCommandBody, type WatchCommandInput } from "../../src/cli/sync-factory.js";
import { CliOutput, type CliOutputService } from "../../src/cli/output.js";
import { ResourceMonitor } from "../../src/services/resource-monitor.js";
import { SyncEngine } from "../../src/services/sync-engine.js";
import { StoreManager } from "../../src/services/store-manager.js";
import { StoreIndex } from "../../src/services/store-index.js";
import { FilterLibrary } from "../../src/services/filter-library.js";
import { FilterNotFound } from "../../src/domain/errors.js";
import { DataSource, SyncEvent, SyncResult } from "../../src/domain/sync.js";
import { StoreRef } from "../../src/domain/store.js";
import { StoreName } from "../../src/domain/primitives.js";
import { defaultStoreConfig } from "../../src/domain/defaults.js";
import { ImageCache } from "../../src/services/images/image-cache.js";
import { ImageConfig } from "../../src/services/images/image-config.js";

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
    append(
      stdoutRef,
      ensureNewline(JSON.stringify(value, null, pretty ? 2 : 0))
    );

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

const sampleStoreName = Schema.decodeUnknownSync(StoreName)("watch-test");
const sampleStore = StoreRef.make({ name: sampleStoreName, root: "stores/watch-test" });

const libraryLayer = Layer.succeed(
  FilterLibrary,
  FilterLibrary.make({
    list: () => Effect.succeed([]),
    get: (name) => Effect.fail(FilterNotFound.make({ name })),
    save: () => Effect.void,
    remove: () => Effect.void,
    validateAll: () => Effect.succeed([])
  })
);

const storeManagerLayer = Layer.succeed(
  StoreManager,
  StoreManager.make({
    createStore: () => Effect.succeed(sampleStore),
    getStore: () => Effect.succeed(Option.some(sampleStore)),
    listStores: () => Effect.succeed(Chunk.empty()),
    getMetadata: () => Effect.succeed(Option.none()),
    getConfig: () => Effect.succeed(Option.some(defaultStoreConfig)),
    deleteStore: () => Effect.void,
    renameStore: () => Effect.succeed(sampleStore),
    updateDescription: () => Effect.die("unused")
  })
);

const storeIndexLayer = Layer.succeed(
  StoreIndex,
  StoreIndex.make({
    apply: () => Effect.die("unused"),
    getByDate: () => Effect.die("unused"),
    getByHashtag: () => Effect.die("unused"),
    getPost: () => Effect.die("unused"),
    hasUri: () => Effect.die("unused"),
    clear: () => Effect.die("unused"),
    loadCheckpoint: () => Effect.die("unused"),
    saveCheckpoint: () => Effect.die("unused"),
    query: () => Stream.empty,
    threadPosts: () => Effect.die("unused"),
    searchPosts: () => Effect.die("unused"),
    entries: () => Stream.empty,
    threadGroups: () => Effect.die("unused"),
    count: () => Effect.die("unused"),
    rebuild: () => Effect.die("unused")
  })
);

const imageConfigLayer = Layer.succeed(
  ImageConfig,
  ImageConfig.make({
    enabled: false,
    cacheRoot: ".",
    metaRoot: ".",
    originalsRoot: ".",
    thumbsRoot: ".",
    cacheTtl: Duration.seconds(0),
    failureTtl: Duration.seconds(0),
    memCapacity: 0,
    memTtl: Duration.seconds(0)
  })
);

const imageCacheLayer = Layer.succeed(
  ImageCache,
  ImageCache.make({
    get: () => Effect.die("unused"),
    getCached: () => Effect.die("unused"),
    invalidate: () => Effect.die("unused")
  })
);

const makeResult = (postsAdded: number) =>
  SyncResult.make({
    postsAdded,
    postsDeleted: 0,
    postsSkipped: 0,
    errors: []
  });

const parseJsonLines = (lines: ReadonlyArray<string>) =>
  lines
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));

describe("watch command", () => {
  test("honors maxCycles for watch streams", async () => {
    const events = [
      SyncEvent.make({ result: makeResult(1) }),
      SyncEvent.make({ result: makeResult(2) }),
      SyncEvent.make({ result: makeResult(3) })
    ];

    const engineLayer = Layer.succeed(
      SyncEngine,
      SyncEngine.make({
        stream: () => Stream.empty,
        sync: () => Effect.succeed(makeResult(0)),
        watch: () => Stream.fromIterable(events)
      })
    );

    const { layer: outputLayer, stdoutRef } = makeOutputCapture();
    const appLayer = Layer.mergeAll(
      engineLayer,
      outputLayer,
      storeManagerLayer,
      libraryLayer,
      ResourceMonitor.testLayer,
      storeIndexLayer,
      imageConfigLayer,
      imageCacheLayer
    );

    const runWatch = makeWatchCommandBody("timeline", DataSource.timeline);
    const input: WatchCommandInput = {
      store: sampleStoreName,
      filter: Option.none(),
      filterJson: Option.none(),
      quiet: true,
      refresh: false,
      cacheImages: false,
      cacheImagesMode: Option.none(),
      cacheImagesLimit: Option.none(),
      interval: Option.none(),
      maxCycles: Option.some(2),
      until: Option.none()
    };

    await Effect.runPromise(runWatch(input).pipe(Effect.provide(appLayer)));

    const stdout = await Effect.runPromise(Ref.get(stdoutRef));
    const payloads = parseJsonLines(stdout);
    expect(payloads).toHaveLength(2);
    expect(payloads[0]).toMatchObject({ postsAdded: 1 });
  });

  test("honors --until by interrupting the watch stream", async () => {
    const event = SyncEvent.make({ result: makeResult(1) });
    const timedStream = Stream.repeatEffect(
      Effect.sleep(Duration.seconds(1)).pipe(Effect.as(event))
    );

    const engineLayer = Layer.succeed(
      SyncEngine,
      SyncEngine.make({
        stream: () => Stream.empty,
        sync: () => Effect.succeed(makeResult(0)),
        watch: () => timedStream
      })
    );

    const { layer: outputLayer, stdoutRef } = makeOutputCapture();
    const appLayer = Layer.mergeAll(
      engineLayer,
      outputLayer,
      storeManagerLayer,
      libraryLayer,
      ResourceMonitor.testLayer,
      storeIndexLayer,
      imageConfigLayer,
      imageCacheLayer
    );

    const runWatch = makeWatchCommandBody("timeline", DataSource.timeline);
    const input: WatchCommandInput = {
      store: sampleStoreName,
      filter: Option.none(),
      filterJson: Option.none(),
      quiet: true,
      refresh: false,
      cacheImages: false,
      cacheImagesMode: Option.none(),
      cacheImagesLimit: Option.none(),
      interval: Option.none(),
      maxCycles: Option.none(),
      until: Option.some(Duration.millis(2500))
    };

    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* runWatch(input).pipe(Effect.fork);
        yield* TestClock.adjust("3 seconds");
        yield* Fiber.join(fiber);
      }).pipe(Effect.provide(appLayer), Effect.provide(TestContext.TestContext))
    );

    const stdout = await Effect.runPromise(Ref.get(stdoutRef));
    const payloads = parseJsonLines(stdout);
    expect(payloads).toHaveLength(2);
  });
});
