import { Effect, Option, Stream } from "effect";
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

/** Common options shared by sync and watch API-based commands */
export interface CommonCommandInput {
  readonly store: StoreName;
  readonly filter: Option.Option<string>;
  readonly filterJson: Option.Option<string>;
  readonly quiet: boolean;
  readonly refresh: boolean;
  readonly limit?: Option.Option<number>;
}

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
          ...(limitValue !== undefined ? { limit: limitValue } : {})
        })
        .pipe(
          Effect.provideService(SyncReporter, makeSyncReporter(input.quiet, monitor, output))
        );
      const materialized = yield* outputManager.materializeStore(storeRef);
      if (materialized.filters.length > 0) {
        yield* logInfo("Materialized filter outputs", {
          store: storeRef.name,
          filters: materialized.filters.map((spec) => spec.name)
        });
      }
      const totalPosts = yield* index.count(storeRef);
      yield* logInfo("Sync complete", { source: sourceName, store: storeRef.name, ...extraLogFields });
      yield* writeJson({ ...(result as SyncResult), totalPosts });
    });

/** Common options for watch API-based commands */
export interface WatchCommandInput extends CommonCommandInput {
  readonly interval: Option.Option<string>;
  readonly maxCycles: Option.Option<number>;
  readonly until: Option.Option<string>;
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
      const parsedInterval = yield* parseInterval(input.interval);
      const parsedUntil = yield* parseOptionalDuration(input.until);
      yield* logInfo("Starting watch", { source: sourceName, store: storeRef.name, ...extraLogFields });
      if (policy === "refresh") {
        yield* logWarn("Refresh mode updates existing posts and may grow the event log.", {
          source: sourceName,
          store: storeRef.name
        });
      }
      let stream = sync
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
      if (Option.isSome(input.maxCycles)) {
        stream = stream.pipe(Stream.take(input.maxCycles.value));
      }
      if (Option.isSome(parsedUntil)) {
        stream = stream.pipe(Stream.interruptWhen(Effect.sleep(parsedUntil.value)));
      }
      yield* writeJsonStream(stream);
    });
