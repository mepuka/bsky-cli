import { Duration, Effect, Option, Stream } from "effect";
import { DataSource, SyncResult, WatchConfig } from "../domain/sync.js";
import { SyncEngine } from "../services/sync-engine.js";
import { SyncReporter } from "../services/sync-reporter.js";
import { OutputManager } from "../services/output-manager.js";
import { ResourceMonitor } from "../services/resource-monitor.js";
import { StoreIndex } from "../services/store-index.js";
import { parseFilterExpr } from "./filter-input.js";
import { CliOutput, writeJson, writeJsonStream } from "./output.js";
import { storeOptions } from "./store.js";
import { logInfo, logWarn, makeSyncReporter } from "./logging.js";
import { parseInterval, parseOptionalDuration } from "./interval.js";
import type { StoreName } from "../domain/primitives.js";
import type { StoreRef } from "../domain/store.js";
import { cacheStoreImages } from "./image-cache.js";
import type { CacheImagesMode } from "./shared-options.js";

/** Common options shared by sync and watch API-based commands */
export interface CommonCommandInput {
  readonly store: StoreName;
  readonly filter: Option.Option<string>;
  readonly filterJson: Option.Option<string>;
  readonly quiet: boolean;
  readonly refresh: boolean;
  readonly cacheImages: boolean;
  readonly cacheImagesMode: Option.Option<CacheImagesMode>;
  readonly cacheImagesLimit: Option.Option<number>;
  readonly noCacheImagesThumbnails: boolean;
  readonly dryRun?: boolean;
  readonly limit?: Option.Option<number>;
}

export const resolveCacheMode = (mode: Option.Option<CacheImagesMode>): CacheImagesMode =>
  Option.getOrElse(mode, () => "new");

export const resolveCacheLimit = (
  mode: CacheImagesMode,
  postsAdded: number,
  limitOverride: Option.Option<number>
): number | undefined => {
  const override = Option.getOrUndefined(limitOverride);
  if (mode === "full") {
    return override;
  }
  if (postsAdded <= 0) {
    return 0;
  }
  if (override !== undefined) {
    return Math.min(postsAdded, override);
  }
  return postsAdded;
};

/** Run image cache after a one-shot sync. Handles mode/limit resolution, logging, and error resilience. */
export const runImageCacheAfterSync = (options: {
  readonly storeRef: StoreRef;
  readonly sourceName: string;
  readonly mode: CacheImagesMode;
  readonly postsAdded: number;
  readonly limitOverride: Option.Option<number>;
  readonly includeThumbnails: boolean;
}) =>
  Effect.gen(function* () {
    const cacheLimit = resolveCacheLimit(options.mode, options.postsAdded, options.limitOverride);
    const shouldRun = options.mode === "full" || options.postsAdded > 0;
    if (!shouldRun || cacheLimit === 0) return;
    yield* Effect.gen(function* () {
      if (options.mode === "full") {
        yield* logWarn("Running full image cache scan", {
          store: options.storeRef.name,
          source: options.sourceName
        });
      }
      yield* logInfo("Caching image embeds", {
        store: options.storeRef.name,
        source: options.sourceName,
        postsAdded: options.postsAdded
      });
      const cacheResult = yield* cacheStoreImages(options.storeRef, {
        includeThumbnails: options.includeThumbnails,
        ...(cacheLimit !== undefined ? { limit: cacheLimit } : {})
      });
      yield* logInfo("Image cache complete", cacheResult);
    }).pipe(
      Effect.catchAll((error) =>
        logWarn("Image cache failed", {
          store: options.storeRef.name,
          source: options.sourceName,
          error
        }).pipe(Effect.orElseSucceed(() => undefined))
      )
    );
  });

/** Run initial full image cache scan on watch startup. Handles logging and error resilience. */
export const runInitialFullCacheScan = (options: {
  readonly storeRef: StoreRef;
  readonly sourceName: string;
  readonly limitOverride: Option.Option<number>;
  readonly includeThumbnails: boolean;
}) =>
  Effect.gen(function* () {
    yield* logWarn("Running full image cache scan", {
      store: options.storeRef.name,
      source: options.sourceName
    });
    const cacheResult = yield* cacheStoreImages(options.storeRef, {
      includeThumbnails: options.includeThumbnails,
      ...(Option.isSome(options.limitOverride)
        ? { limit: options.limitOverride.value }
        : {})
    });
    yield* logInfo("Image cache complete", cacheResult);
  }).pipe(
    Effect.catchAll((error) =>
      logWarn("Image cache failed", {
        store: options.storeRef.name,
        source: options.sourceName,
        error
      }).pipe(Effect.orElseSucceed(() => undefined))
    )
  );

/** Wrap a sync result with incremental image caching. For use in Stream.mapEffect on watch streams. */
export const withIncrementalImageCaching = (options: {
  readonly storeRef: StoreRef;
  readonly sourceName: string;
  readonly limitOverride: Option.Option<number>;
  readonly includeThumbnails: boolean;
}) =>
  <A extends { readonly postsAdded: number }>(result: A) =>
    result.postsAdded > 0
      ? Effect.gen(function* () {
          const cacheLimit = resolveCacheLimit("new", result.postsAdded, options.limitOverride);
          yield* logInfo("Caching image embeds", {
            store: options.storeRef.name,
            source: options.sourceName,
            postsAdded: result.postsAdded
          });
          const cacheResult = yield* cacheStoreImages(options.storeRef, {
            includeThumbnails: options.includeThumbnails,
            ...(cacheLimit !== undefined && cacheLimit > 0
              ? { limit: cacheLimit }
              : {})
          });
          yield* logInfo("Image cache complete", cacheResult);
        }).pipe(
          Effect.catchAll((error) =>
            logWarn("Image cache failed", {
              store: options.storeRef.name,
              source: options.sourceName,
              error
            }).pipe(Effect.orElseSucceed(() => undefined))
          ),
          Effect.as(result)
        )
      : Effect.succeed(result);

/** Build the command body for a one-shot sync command (timeline, feed, notifications). */
export const makeSyncCommandBody = (
  sourceName: string,
  makeDataSource: () => DataSource,
  extraLogFields?: Record<string, unknown>
) =>
  (input: CommonCommandInput) =>
    Effect.gen(function* () {
      const sync = yield* SyncEngine;
      const monitor = yield* ResourceMonitor;
      const output = yield* CliOutput;
      const outputManager = yield* OutputManager;
      const index = yield* StoreIndex;
      const storeRef = yield* storeOptions.loadStoreRef(input.store);
      const storeConfig = yield* storeOptions.loadStoreConfig(input.store);
      const expr = yield* parseFilterExpr(input.filter, input.filterJson);
      const basePolicy = storeConfig.syncPolicy ?? "dedupe";
      const policy = input.refresh ? "refresh" : basePolicy;
      const dryRun = input.dryRun ?? false;
      if (dryRun) {
        yield* logInfo("Dry run: no changes will be written", {
          source: sourceName,
          store: storeRef.name
        });
      }
      yield* logInfo("Starting sync", { source: sourceName, store: storeRef.name, ...extraLogFields });
      if (policy === "refresh") {
        yield* logWarn("Refresh mode updates existing posts and may grow the event log.", {
          source: sourceName,
          store: storeRef.name
        });
      }
      const limitValue = Option.getOrUndefined(input.limit ?? Option.none());
      const result = yield* sync
        .sync(makeDataSource(), storeRef, expr, {
          policy,
          ...(limitValue !== undefined ? { limit: limitValue } : {}),
          ...(dryRun ? { dryRun: true } : {})
        })
        .pipe(
          Effect.provideService(SyncReporter, makeSyncReporter(input.quiet, monitor, output))
        );
      if (!dryRun) {
        const materialized = yield* outputManager.materializeStore(storeRef);
        if (materialized.filters.length > 0) {
          yield* logInfo("Materialized filter outputs", {
            store: storeRef.name,
            filters: materialized.filters.map((spec) => spec.name)
          });
        }
      }
      const totalPosts = yield* index.count(storeRef);
      if (input.cacheImages && !dryRun) {
        yield* runImageCacheAfterSync({
          storeRef,
          sourceName,
          mode: resolveCacheMode(input.cacheImagesMode),
          postsAdded: result.postsAdded,
          limitOverride: input.cacheImagesLimit,
          includeThumbnails: !input.noCacheImagesThumbnails
        });
      }
      yield* logInfo("Sync complete", {
        source: sourceName,
        store: storeRef.name,
        ...extraLogFields,
        ...(dryRun ? { dryRun: true } : {})
      });
      yield* writeJson({
        ...(result as SyncResult),
        totalPosts,
        ...(dryRun ? { dryRun: true } : {})
      });
    });

/** Common options for watch API-based commands */
export interface WatchCommandInput extends CommonCommandInput {
  readonly interval: Option.Option<Duration.Duration>;
  readonly maxCycles: Option.Option<number>;
  readonly until: Option.Option<Duration.Duration>;
}

/** Build the command body for a watch command (timeline, feed, notifications). */
export const makeWatchCommandBody = (
  sourceName: string,
  makeDataSource: () => DataSource,
  extraLogFields?: Record<string, unknown>
) =>
  (input: WatchCommandInput) =>
    Effect.gen(function* () {
      const sync = yield* SyncEngine;
      const monitor = yield* ResourceMonitor;
      const output = yield* CliOutput;
      const storeRef = yield* storeOptions.loadStoreRef(input.store);
      const storeConfig = yield* storeOptions.loadStoreConfig(input.store);
      const expr = yield* parseFilterExpr(input.filter, input.filterJson);
      const basePolicy = storeConfig.syncPolicy ?? "dedupe";
      const policy = input.refresh ? "refresh" : basePolicy;
      const parsedInterval = parseInterval(input.interval);
      const parsedUntil = parseOptionalDuration(input.until);
      const cacheMode = input.cacheImages
        ? resolveCacheMode(input.cacheImagesMode)
        : "new";
      yield* logInfo("Starting watch", { source: sourceName, store: storeRef.name, ...extraLogFields });
      if (policy === "refresh") {
        yield* logWarn("Refresh mode updates existing posts and may grow the event log.", {
          source: sourceName,
          store: storeRef.name
        });
      }
      if (input.cacheImages && cacheMode === "full") {
        yield* runInitialFullCacheScan({
          storeRef,
          sourceName,
          limitOverride: input.cacheImagesLimit,
          includeThumbnails: !input.noCacheImagesThumbnails
        });
      }
      const baseStream = sync
        .watch(
          WatchConfig.make({
            source: makeDataSource(),
            store: storeRef,
            filter: expr,
            interval: parsedInterval,
            policy
          })
        )
        .pipe(
          Stream.map((event) => event.result),
          Stream.provideService(SyncReporter, makeSyncReporter(input.quiet, monitor, output))
        );
      let stream = input.cacheImages
        ? baseStream.pipe(
            Stream.mapEffect(
              withIncrementalImageCaching({
                storeRef,
                sourceName,
                limitOverride: input.cacheImagesLimit,
                includeThumbnails: !input.noCacheImagesThumbnails
              })
            )
          )
        : baseStream;
      if (Option.isSome(input.maxCycles)) {
        stream = stream.pipe(Stream.take(input.maxCycles.value));
      }
      if (Option.isSome(parsedUntil)) {
        stream = stream.pipe(Stream.interruptWhen(Effect.sleep(parsedUntil.value)));
      }
      yield* writeJsonStream(stream);
    });
