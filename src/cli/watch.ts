import { Args, Command, Options } from "@effect/cli";
import { Effect, Option, Stream } from "effect";
import { DataSource, WatchConfig } from "../domain/sync.js";
import { StoreName } from "../domain/primitives.js";
import { SyncEngine } from "../services/sync-engine.js";
import { SyncReporter } from "../services/sync-reporter.js";
import { parseInterval } from "./interval.js";
import { filterDslDescription, filterJsonDescription } from "./filter-help.js";
import { parseFilterExpr } from "./filter-input.js";
import { CliOutput, writeJsonStream } from "./output.js";
import { storeOptions } from "./store.js";
import { logInfo, makeSyncReporter } from "./logging.js";
import { ResourceMonitor } from "../services/resource-monitor.js";
import { withExamples } from "./help.js";

const storeNameOption = Options.text("store").pipe(
  Options.withSchema(StoreName),
  Options.withDescription("Store name to write into")
);
const filterOption = Options.text("filter").pipe(
  Options.withDescription(filterDslDescription()),
  Options.optional
);
const filterJsonOption = Options.text("filter-json").pipe(
  Options.withDescription(filterJsonDescription()),
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

const parseFilter = (
  filter: Option.Option<string>,
  filterJson: Option.Option<string>
) => parseFilterExpr(filter, filterJson);

const timelineCommand = Command.make(
  "timeline",
  {
    store: storeNameOption,
    filter: filterOption,
    filterJson: filterJsonOption,
    interval: intervalOption,
    intervalMs: intervalMsOption,
    quiet: quietOption
  },
  ({ store, filter, filterJson, interval, intervalMs, quiet }) =>
    Effect.gen(function* () {
      const sync = yield* SyncEngine;
      const monitor = yield* ResourceMonitor;
      const output = yield* CliOutput;
      const storeRef = yield* storeOptions.loadStoreRef(store);
      const expr = yield* parseFilter(filter, filterJson);
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
).pipe(
  Command.withDescription(
    withExamples(
      "Watch timeline updates and emit sync results",
      [
        "skygent watch timeline --store my-store",
        "skygent watch timeline --store my-store --interval \"5 minutes\" --quiet"
      ],
      ["Tip: add --quiet to suppress progress logs."]
    )
  )
);

const feedUriArg = Args.text({ name: "uri" }).pipe(
  Args.withDescription("Bluesky feed URI (at://...)")
);

const feedCommand = Command.make(
  "feed",
  {
    uri: feedUriArg,
    store: storeNameOption,
    filter: filterOption,
    filterJson: filterJsonOption,
    interval: intervalOption,
    intervalMs: intervalMsOption,
    quiet: quietOption
  },
  ({ uri, store, filter, filterJson, interval, intervalMs, quiet }) =>
    Effect.gen(function* () {
      const sync = yield* SyncEngine;
      const monitor = yield* ResourceMonitor;
      const output = yield* CliOutput;
      const storeRef = yield* storeOptions.loadStoreRef(store);
      const expr = yield* parseFilter(filter, filterJson);
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
).pipe(
  Command.withDescription(
    withExamples(
      "Watch a feed URI and emit sync results",
      [
        "skygent watch feed at://did:plc:example/app.bsky.feed.generator/xyz --store my-store --interval \"2 minutes\""
      ],
      ["Tip: add --quiet to suppress progress logs."]
    )
  )
);

const notificationsCommand = Command.make(
  "notifications",
  {
    store: storeNameOption,
    filter: filterOption,
    filterJson: filterJsonOption,
    interval: intervalOption,
    intervalMs: intervalMsOption,
    quiet: quietOption
  },
  ({ store, filter, filterJson, interval, intervalMs, quiet }) =>
    Effect.gen(function* () {
      const sync = yield* SyncEngine;
      const monitor = yield* ResourceMonitor;
      const output = yield* CliOutput;
      const storeRef = yield* storeOptions.loadStoreRef(store);
      const expr = yield* parseFilter(filter, filterJson);
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
).pipe(
  Command.withDescription(
    withExamples(
      "Watch notifications and emit sync results",
      ["skygent watch notifications --store my-store --interval \"1 minute\" --quiet"],
      ["Tip: add --quiet to suppress progress logs."]
    )
  )
);

export const watchCommand = Command.make("watch", {}).pipe(
  Command.withSubcommands([timelineCommand, feedCommand, notificationsCommand]),
  Command.withDescription(
    withExamples("Continuously sync and emit results", [
      "skygent watch timeline --store my-store --interval \"2 minutes\""
    ])
  )
);
