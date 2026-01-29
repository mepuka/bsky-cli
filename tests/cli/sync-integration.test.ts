import { Command } from "@effect/cli";
import { BunContext } from "@effect/platform-bun";
import { describe, expect, test } from "bun:test";
import { Effect, Layer, Ref, Sink, Stream } from "effect";
import { CliOutput, type CliOutputService } from "../../src/cli/output.js";
import { syncCommand } from "../../src/cli/sync.js";
import { storeCommand } from "../../src/cli/store.js";
import { AppConfigService, ConfigOverrides } from "../../src/services/app-config.js";
import { BskyClient } from "../../src/services/bsky-client.js";
import { CredentialStore } from "../../src/services/credential-store.js";
import { StoreManager } from "../../src/services/store-manager.js";
import { StoreLock } from "../../src/services/store-lock.js";
import { ResourceMonitor } from "../../src/services/resource-monitor.js";
import { OutputManager } from "../../src/services/output-manager.js";
import { FilterLibrary } from "../../src/services/filter-library.js";
import { makeBskyMockLayer } from "../support/bsky-mock-server.js";
import { FileSystem } from "@effect/platform";
import * as KeyValueStore from "@effect/platform/KeyValueStore";
import { StoreDb } from "../../src/services/store-db.js";
import { StoreWriter } from "../../src/services/store-writer.js";
import { StoreCommitter } from "../../src/services/store-commit.js";
import { StoreEventLog } from "../../src/services/store-event-log.js";
import { StoreIndex } from "../../src/services/store-index.js";
import { StoreCleaner } from "../../src/services/store-cleaner.js";
import { SyncCheckpointStore } from "../../src/services/sync-checkpoint-store.js";
import { LinkValidator } from "../../src/services/link-validator.js";
import * as FetchHttpClient from "@effect/platform/FetchHttpClient";
import { TrendingTopics } from "../../src/services/trending-topics.js";
import { FilterRuntime } from "../../src/services/filter-runtime.js";
import { SyncSettings, SyncSettingsOverrides } from "../../src/services/sync-settings.js";
import { SyncEngine } from "../../src/services/sync-engine.js";
import { SyncReporter } from "../../src/services/sync-reporter.js";
import { PostParser } from "../../src/services/post-parser.js";
import { FilterCompiler } from "../../src/services/filter-compiler.js";
import { Path } from "@effect/platform";
import { CliPreferences } from "../../src/cli/preferences.js";
import { LineageStore } from "../../src/services/lineage-store.js";

// Helper to capture output
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

const mockFeed = {
  feed: [
    {
      post: {
        uri: "at://did:plc:alice/app.bsky.feed.post/1",
        cid: "bafkreigks6arfsq3xxfpvqrrwonchxcnu6do76auprhhfomao6c273sixm",
        author: {
          did: "did:plc:alice",
          handle: "alice.bsky"
        },
        record: {
          $type: "app.bsky.feed.post",
          text: "Hello list",
          createdAt: "2026-01-01T00:00:00.000Z"
        },
        indexedAt: "2026-01-01T00:00:01.000Z",
        replyCount: 0
      }
    }
  ]
};

describe("CLI sync command", () => {
  test("sync list command fetches posts from list feed", async () => {
    const { layer: outputLayer, stdoutRef, stderrRef } = makeOutputCapture();

    const runStore = Command.run(storeCommand, {
      name: "skygent",
      version: "0.0.0"
    });

    const runSync = Command.run(syncCommand, {
      name: "skygent",
      version: "0.0.0"
    });

    const storeRoot = await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        return yield* fs.makeTempDirectory();
      }).pipe(Effect.provide(BunContext.layer))
    );

    // Override config
    const configLayer = AppConfigService.layer.pipe(
      Layer.provide(Layer.succeed(ConfigOverrides, { storeRoot })),
      Layer.provide(BunContext.layer)
    );

    // Mock Bsky Client
    const baseLayer = Layer.mergeAll(
      BunContext.layer,
      makeBskyMockLayer({
        listFeed: mockFeed
      })
    );
    const credentialLayer = CredentialStore.layer.pipe(
      Layer.provideMerge(configLayer),
      Layer.provideMerge(baseLayer)
    );
    const bskyLayer = BskyClient.layer.pipe(
      Layer.provideMerge(configLayer),
      Layer.provideMerge(credentialLayer)
    );

    // Reconstruct Core Layers (mimicking CliLive)
    const storageLayer = Layer.unwrapEffect(
      Effect.gen(function* () {
        const config = yield* AppConfigService;
        const path = yield* Path.Path;
        const kvRoot = path.join(config.storeRoot, "kv");
        return KeyValueStore.layerFileSystem(kvRoot);
      })
    ).pipe(Layer.provide(configLayer));

    const storeDbLayer = StoreDb.layer.pipe(Layer.provideMerge(configLayer));
    const writerLayer = StoreWriter.layer.pipe(Layer.provideMerge(storeDbLayer));
    const committerLayer = StoreCommitter.layer.pipe(
      Layer.provideMerge(storeDbLayer),
      Layer.provideMerge(writerLayer)
    );
    const eventLogLayer = StoreEventLog.layer.pipe(Layer.provideMerge(storeDbLayer));
    const indexLayer = StoreIndex.layer.pipe(
      Layer.provideMerge(storeDbLayer),
      Layer.provideMerge(eventLogLayer)
    );
    const managerLayer = StoreManager.layer.pipe(Layer.provideMerge(configLayer));

    const cleanerLayer = StoreCleaner.layer.pipe(
      Layer.provideMerge(managerLayer),
      Layer.provideMerge(indexLayer),
      Layer.provideMerge(eventLogLayer),
      Layer.provideMerge(storeDbLayer)
    );

    const checkpointLayer = SyncCheckpointStore.layer.pipe(
      Layer.provideMerge(storageLayer)
    );

    const linkValidatorLayer = LinkValidator.layer.pipe(
      Layer.provideMerge(storageLayer),
      Layer.provideMerge(FetchHttpClient.layer)
    );
    const trendingTopicsLayer = TrendingTopics.layer.pipe(
      Layer.provideMerge(storageLayer),
      Layer.provideMerge(bskyLayer)
    );
    const resourceMonitorLayer = ResourceMonitor.layer.pipe(
      Layer.provideMerge(configLayer)
    );
    const runtimeLayer = FilterRuntime.layer.pipe(
      Layer.provideMerge(linkValidatorLayer),
      Layer.provideMerge(trendingTopicsLayer)
    );

    const syncSettingsLayer = SyncSettings.layer.pipe(
      Layer.provide(SyncSettingsOverrides.layer)
    );
    const syncLayer = SyncEngine.layer.pipe(
      Layer.provideMerge(committerLayer),
      Layer.provideMerge(indexLayer),
      Layer.provideMerge(checkpointLayer),
      Layer.provideMerge(runtimeLayer),
      Layer.provideMerge(PostParser.layer),
      Layer.provideMerge(bskyLayer),
      Layer.provideMerge(SyncReporter.layer),
      Layer.provideMerge(syncSettingsLayer)
    );

    const storeLockLayer = StoreLock.layer.pipe(
      Layer.provideMerge(configLayer)
    );

    const outputManagerLayer = OutputManager.layer.pipe(
        Layer.provideMerge(configLayer),
        Layer.provideMerge(managerLayer),
        Layer.provideMerge(indexLayer),
        Layer.provideMerge(runtimeLayer),
        Layer.provideMerge(FilterCompiler.layer)
    );

    const preferencesLayer = Layer.succeed(CliPreferences, { compact: false });
    const lineageLayer = LineageStore.layer.pipe(Layer.provideMerge(storageLayer));

    const appLayer = Layer.mergeAll(
      outputLayer,
      managerLayer,
      storeLockLayer,
      syncLayer,
      storeDbLayer,
      cleanerLayer,
      preferencesLayer,
      lineageLayer,
      outputManagerLayer,
      resourceMonitorLayer,
      FilterLibrary.layer.pipe(Layer.provideMerge(configLayer))
    ).pipe(
        Layer.provideMerge(BunContext.layer)
    );

    await Effect.runPromise(
      Effect.gen(function* () {
        // Create store
        yield* runStore(["node", "skygent", "create", "test-store"]);
        // Sync list
        yield* runSync(["node", "skygent", "list", "at://did:plc:test/app.bsky.graph.list/1", "--store", "test-store", "--quiet"]);
      }).pipe(Effect.provide(appLayer))
    );

    const stdout = await Effect.runPromise(Ref.get(stdoutRef));
    const stderr = await Effect.runPromise(Ref.get(stderrRef));

    // Cleanup
    await Effect.runPromise(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.remove(storeRoot, { recursive: true });
      }).pipe(Effect.provide(BunContext.layer))
    );

    // Verify
    const startLog = stderr.find(l => l.includes("Starting sync"));
    expect(startLog).toBeDefined();

    const lastOutput = JSON.parse(stdout[stdout.length - 1]);
    expect(lastOutput).toMatchObject({
        postsAdded: 1,
        postsSkipped: 0,
        errors: []
    });
  });
});
