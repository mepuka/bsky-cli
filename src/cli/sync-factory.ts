import { Effect, Stream } from "effect";
import { DataSource, SyncResult, WatchConfig } from "../domain/sync.js";
import { SyncEngine } from "../services/sync-engine.js";
import { SyncReporter } from "../services/sync-reporter.js";
import { OutputManager } from "../services/output-manager.js";
import { StoreLock } from "../services/store-lock.js";
import { ResourceMonitor } from "../services/resource-monitor.js";
import { parseFilterExpr } from "./filter-input.js";
import { CliOutput, writeJson, writeJsonStream } from "./output.js";
import { storeOptions } from "./store.js";
import { logInfo, makeSyncReporter } from "./logging.js";
import { parseInterval } from "./interval.js";
import type { Option } from "effect";
import type { StoreName } from "../domain/primitives.js";

/** Common options shared by sync and watch API-based commands */
export interface CommonCommandInput {
  readonly store: StoreName;
  readonly filter: Option.Option<string>;
  readonly filterJson: Option.Option<string>;
  readonly quiet: boolean;
}

/** Build the command body for a one-shot sync command (timeline, feed, notifications). */
export const makeSyncCommandBody = (
  sourceName: string,
  makeDataSource: () => DataSource,
  extraLogFields?: Record<string, unknown>
) =>
  (input: CommonCommandInput) =>
    Effect.gen(function* () {
      const storeLock = yield* StoreLock;
      const sync = yield* SyncEngine;
      const monitor = yield* ResourceMonitor;
      const output = yield* CliOutput;
      const outputManager = yield* OutputManager;
      const storeRef = yield* storeOptions.loadStoreRef(input.store);
      const expr = yield* parseFilterExpr(input.filter, input.filterJson);
      return yield* storeLock.withStoreLock(
        storeRef,
        Effect.gen(function* () {
          yield* logInfo("Starting sync", { source: sourceName, store: storeRef.name, ...extraLogFields });
          const result = yield* sync
            .sync(makeDataSource(), storeRef, expr)
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
          yield* logInfo("Sync complete", { source: sourceName, store: storeRef.name, ...extraLogFields });
          yield* writeJson(result as SyncResult);
        })
      );
    });

/** Common options for watch API-based commands */
export interface WatchCommandInput extends CommonCommandInput {
  readonly interval: Option.Option<string>;
}

/** Build the command body for a watch command (timeline, feed, notifications). */
export const makeWatchCommandBody = (
  sourceName: string,
  makeDataSource: () => DataSource,
  extraLogFields?: Record<string, unknown>
) =>
  (input: WatchCommandInput) =>
    Effect.gen(function* () {
      const storeLock = yield* StoreLock;
      const sync = yield* SyncEngine;
      const monitor = yield* ResourceMonitor;
      const output = yield* CliOutput;
      const storeRef = yield* storeOptions.loadStoreRef(input.store);
      const expr = yield* parseFilterExpr(input.filter, input.filterJson);
      const parsedInterval = yield* parseInterval(input.interval);
      return yield* storeLock.withStoreLock(
        storeRef,
        Effect.gen(function* () {
          yield* logInfo("Starting watch", { source: sourceName, store: storeRef.name, ...extraLogFields });
          const stream = sync
            .watch(
              WatchConfig.make({
                source: makeDataSource(),
                store: storeRef,
                filter: expr,
                interval: parsedInterval
              })
            )
            .pipe(
              Stream.map((event) => event.result),
              Stream.provideService(SyncReporter, makeSyncReporter(input.quiet, monitor, output))
            );
          yield* writeJsonStream(stream);
        })
      );
    });
