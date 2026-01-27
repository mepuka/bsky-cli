import { Args, Command, Options } from "@effect/cli";
import { Effect, Option } from "effect";
import { StoreName } from "../domain/primitives.js";
import { DataSource, SyncResult } from "../domain/sync.js";
import { SyncEngine } from "../services/sync-engine.js";
import { filterDslDescription, filterJsonDescription } from "./filter-help.js";
import { parseFilterExpr } from "./filter-input.js";
import { CliOutput, writeJson } from "./output.js";
import { storeOptions } from "./store.js";
import { logInfo, makeSyncReporter } from "./logging.js";
import { SyncReporter } from "../services/sync-reporter.js";
import { ResourceMonitor } from "../services/resource-monitor.js";
import { OutputManager } from "../services/output-manager.js";

const storeNameOption = Options.text("store").pipe(Options.withSchema(StoreName));
const filterOption = Options.text("filter").pipe(
  Options.withDescription(filterDslDescription()),
  Options.optional
);
const filterJsonOption = Options.text("filter-json").pipe(
  Options.withDescription(filterJsonDescription()),
  Options.optional
);
const quietOption = Options.boolean("quiet").pipe(
  Options.withDescription("Suppress progress output")
);

const parseFilter = (
  filter: Option.Option<string>,
  filterJson: Option.Option<string>
) => parseFilterExpr(filter, filterJson);

const timelineCommand = Command.make(
  "timeline",
  { store: storeNameOption, filter: filterOption, filterJson: filterJsonOption, quiet: quietOption },
  ({ store, filter, filterJson, quiet }) =>
    Effect.gen(function* () {
      const sync = yield* SyncEngine;
      const monitor = yield* ResourceMonitor;
      const output = yield* CliOutput;
      const outputManager = yield* OutputManager;
      const storeRef = yield* storeOptions.loadStoreRef(store);
      const expr = yield* parseFilter(filter, filterJson);
      yield* logInfo("Starting sync", { source: "timeline", store: storeRef.name });
      const result = yield* sync
        .sync(DataSource.timeline(), storeRef, expr)
        .pipe(
          Effect.provideService(SyncReporter, makeSyncReporter(quiet, monitor, output))
        );
      const materialized = yield* outputManager.materializeStore(storeRef);
      if (materialized.filters.length > 0) {
        yield* logInfo("Materialized filter outputs", {
          store: storeRef.name,
          filters: materialized.filters.map((spec) => spec.name)
        });
      }
      yield* logInfo("Sync complete", { source: "timeline", store: storeRef.name });
      yield* writeJson(result as SyncResult);
    })
).pipe(Command.withDescription("Sync the authenticated timeline into a store"));

const feedUriArg = Args.text({ name: "uri" });

const feedCommand = Command.make(
  "feed",
  { uri: feedUriArg, store: storeNameOption, filter: filterOption, filterJson: filterJsonOption, quiet: quietOption },
  ({ uri, store, filter, filterJson, quiet }) =>
    Effect.gen(function* () {
      const sync = yield* SyncEngine;
      const monitor = yield* ResourceMonitor;
      const output = yield* CliOutput;
      const outputManager = yield* OutputManager;
      const storeRef = yield* storeOptions.loadStoreRef(store);
      const expr = yield* parseFilter(filter, filterJson);
      yield* logInfo("Starting sync", { source: "feed", uri, store: storeRef.name });
      const result = yield* sync
        .sync(DataSource.feed(uri), storeRef, expr)
        .pipe(
          Effect.provideService(SyncReporter, makeSyncReporter(quiet, monitor, output))
        );
      const materialized = yield* outputManager.materializeStore(storeRef);
      if (materialized.filters.length > 0) {
        yield* logInfo("Materialized filter outputs", {
          store: storeRef.name,
          filters: materialized.filters.map((spec) => spec.name)
        });
      }
      yield* logInfo("Sync complete", { source: "feed", uri, store: storeRef.name });
      yield* writeJson(result as SyncResult);
    })
).pipe(Command.withDescription("Sync a feed URI into a store"));

const notificationsCommand = Command.make(
  "notifications",
  { store: storeNameOption, filter: filterOption, filterJson: filterJsonOption, quiet: quietOption },
  ({ store, filter, filterJson, quiet }) =>
    Effect.gen(function* () {
      const sync = yield* SyncEngine;
      const monitor = yield* ResourceMonitor;
      const output = yield* CliOutput;
      const outputManager = yield* OutputManager;
      const storeRef = yield* storeOptions.loadStoreRef(store);
      const expr = yield* parseFilter(filter, filterJson);
      yield* logInfo("Starting sync", { source: "notifications", store: storeRef.name });
      const result = yield* sync
        .sync(DataSource.notifications(), storeRef, expr)
        .pipe(
          Effect.provideService(SyncReporter, makeSyncReporter(quiet, monitor, output))
        );
      const materialized = yield* outputManager.materializeStore(storeRef);
      if (materialized.filters.length > 0) {
        yield* logInfo("Materialized filter outputs", {
          store: storeRef.name,
          filters: materialized.filters.map((spec) => spec.name)
        });
      }
      yield* logInfo("Sync complete", { source: "notifications", store: storeRef.name });
      yield* writeJson(result as SyncResult);
    })
).pipe(Command.withDescription("Sync notifications into a store"));

export const syncCommand = Command.make("sync", {}).pipe(
  Command.withSubcommands([timelineCommand, feedCommand, notificationsCommand])
);
