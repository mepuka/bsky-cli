import { Args, Command, Options } from "@effect/cli";
import { Effect, Option, Stream } from "effect";
import { FilterExprSchema, all } from "../domain/filter.js";
import { DataSource, WatchConfig } from "../domain/sync.js";
import { StoreName } from "../domain/primitives.js";
import { SyncEngine } from "../services/sync-engine.js";
import { SyncReporter } from "../services/sync-reporter.js";
import { parseInterval } from "./interval.js";
import { decodeJson } from "./parse.js";
import { CliOutput, writeJsonStream } from "./output.js";
import { storeOptions } from "./store.js";
import { logInfo, makeSyncReporter } from "./logging.js";
import { ResourceMonitor } from "../services/resource-monitor.js";

const storeNameOption = Options.text("store").pipe(Options.withSchema(StoreName));
const filterJsonOption = Options.text("filter-json").pipe(
  Options.withDescription("Filter expression as JSON string"),
  Options.optional
);
const intervalOption = Options.text("interval").pipe(
  Options.withDescription("Polling interval (e.g. \"30 seconds\", \"500 millis\")"),
  Options.optional
);
const intervalMsOption = Options.integer("interval-ms").pipe(
  Options.withDescription("Polling interval in milliseconds (deprecated)"),
  Options.optional
);
const quietOption = Options.boolean("quiet").pipe(
  Options.withDescription("Suppress progress output")
);

const parseFilter = (filterJson: Option.Option<string>) =>
  Option.match(filterJson, {
    onNone: () => Effect.succeed(all()),
    onSome: (raw) => decodeJson(FilterExprSchema, raw)
  });

const timelineCommand = Command.make(
  "timeline",
  {
    store: storeNameOption,
    filter: filterJsonOption,
    interval: intervalOption,
    intervalMs: intervalMsOption,
    quiet: quietOption
  },
  ({ store, filter, interval, intervalMs, quiet }) =>
    Effect.gen(function* () {
      const sync = yield* SyncEngine;
      const monitor = yield* ResourceMonitor;
      const output = yield* CliOutput;
      const storeRef = yield* storeOptions.loadStoreRef(store);
      const expr = yield* parseFilter(filter);
      const parsedInterval = yield* parseInterval(interval, intervalMs);
      yield* logInfo("Starting watch", { source: "timeline", store: storeRef.name });
      const stream = sync
        .watch(
          WatchConfig.make({
            source: DataSource.timeline(),
            store: storeRef,
            filter: expr,
            interval: parsedInterval
          })
        )
        .pipe(
          Stream.map((event) => event.result),
          Stream.provideService(SyncReporter, makeSyncReporter(quiet, monitor, output))
        );
      yield* writeJsonStream(stream);
    })
).pipe(Command.withDescription("Watch timeline updates and emit sync results"));

const feedUriArg = Args.text({ name: "uri" });

const feedCommand = Command.make(
  "feed",
  {
    uri: feedUriArg,
    store: storeNameOption,
    filter: filterJsonOption,
    interval: intervalOption,
    intervalMs: intervalMsOption,
    quiet: quietOption
  },
  ({ uri, store, filter, interval, intervalMs, quiet }) =>
    Effect.gen(function* () {
      const sync = yield* SyncEngine;
      const monitor = yield* ResourceMonitor;
      const output = yield* CliOutput;
      const storeRef = yield* storeOptions.loadStoreRef(store);
      const expr = yield* parseFilter(filter);
      const parsedInterval = yield* parseInterval(interval, intervalMs);
      yield* logInfo("Starting watch", { source: "feed", uri, store: storeRef.name });
      const stream = sync
        .watch(
          WatchConfig.make({
            source: DataSource.feed(uri),
            store: storeRef,
            filter: expr,
            interval: parsedInterval
          })
        )
        .pipe(
          Stream.map((event) => event.result),
          Stream.provideService(SyncReporter, makeSyncReporter(quiet, monitor, output))
        );
      yield* writeJsonStream(stream);
    })
).pipe(Command.withDescription("Watch a feed URI and emit sync results"));

const notificationsCommand = Command.make(
  "notifications",
  {
    store: storeNameOption,
    filter: filterJsonOption,
    interval: intervalOption,
    intervalMs: intervalMsOption,
    quiet: quietOption
  },
  ({ store, filter, interval, intervalMs, quiet }) =>
    Effect.gen(function* () {
      const sync = yield* SyncEngine;
      const monitor = yield* ResourceMonitor;
      const output = yield* CliOutput;
      const storeRef = yield* storeOptions.loadStoreRef(store);
      const expr = yield* parseFilter(filter);
      const parsedInterval = yield* parseInterval(interval, intervalMs);
      yield* logInfo("Starting watch", { source: "notifications", store: storeRef.name });
      const stream = sync
        .watch(
          WatchConfig.make({
            source: DataSource.notifications(),
            store: storeRef,
            filter: expr,
            interval: parsedInterval
          })
        )
        .pipe(
          Stream.map((event) => event.result),
          Stream.provideService(SyncReporter, makeSyncReporter(quiet, monitor, output))
        );
      yield* writeJsonStream(stream);
    })
).pipe(Command.withDescription("Watch notifications and emit sync results"));

export const watchCommand = Command.make("watch", {}).pipe(
  Command.withSubcommands([timelineCommand, feedCommand, notificationsCommand])
);
