import { Args, Command, Options } from "@effect/cli";
import { Effect, Layer, Option, Stream } from "effect";
import { Jetstream } from "effect-jetstream";
import { filterExprSignature } from "../domain/filter.js";
import { DataSource, WatchConfig } from "../domain/sync.js";
import { StoreName } from "../domain/primitives.js";
import { SyncEngine } from "../services/sync-engine.js";
import { SyncReporter } from "../services/sync-reporter.js";
import { JetstreamSyncEngine } from "../services/jetstream-sync.js";
import { parseInterval } from "./interval.js";
import { filterDslDescription, filterJsonDescription } from "./filter-help.js";
import { parseFilterExpr } from "./filter-input.js";
import { CliOutput, writeJsonStream } from "./output.js";
import { storeOptions } from "./store.js";
import { logInfo, makeSyncReporter } from "./logging.js";
import { ResourceMonitor } from "../services/resource-monitor.js";
import { withExamples } from "./help.js";
import { buildJetstreamSelection, jetstreamOptions } from "./jetstream.js";
import { CliInputError } from "./errors.js";
import { StoreLock } from "../services/store-lock.js";

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
  Options.withDescription(
    "Polling interval (e.g. \"30 seconds\", \"500 millis\") (default: 30 seconds)"
  ),
  Options.optional
);
const quietOption = Options.boolean("quiet").pipe(
  Options.withDescription("Suppress progress output")
);
const strictOption = Options.boolean("strict").pipe(
  Options.withDescription("Stop on first error and do not advance the checkpoint")
);
const maxErrorsOption = Options.integer("max-errors").pipe(
  Options.withDescription("Stop after exceeding N errors (default: unlimited)"),
  Options.optional
);

const parseFilter = (
  filter: Option.Option<string>,
  filterJson: Option.Option<string>
) => parseFilterExpr(filter, filterJson);

const parseMaxErrors = (maxErrors: Option.Option<number>) =>
  Option.match(maxErrors, {
    onNone: () => Effect.succeed(Option.none()),
    onSome: (value) =>
      value < 0
        ? Effect.fail(
            CliInputError.make({
              message: "max-errors must be a non-negative integer.",
              cause: value
            })
          )
        : Effect.succeed(Option.some(value))
  });

const timelineCommand = Command.make(
  "timeline",
  {
    store: storeNameOption,
    filter: filterOption,
    filterJson: filterJsonOption,
    interval: intervalOption,
    quiet: quietOption
  },
  ({ store, filter, filterJson, interval, quiet }) =>
    Effect.gen(function* () {
      const storeLock = yield* StoreLock;
      const sync = yield* SyncEngine;
      const monitor = yield* ResourceMonitor;
      const output = yield* CliOutput;
      const storeRef = yield* storeOptions.loadStoreRef(store);
      const expr = yield* parseFilter(filter, filterJson);
      const parsedInterval = yield* parseInterval(interval);
      return yield* storeLock.withStoreLock(
        storeRef,
        Effect.gen(function* () {
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
      );
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
    quiet: quietOption
  },
  ({ uri, store, filter, filterJson, interval, quiet }) =>
    Effect.gen(function* () {
      const storeLock = yield* StoreLock;
      const sync = yield* SyncEngine;
      const monitor = yield* ResourceMonitor;
      const output = yield* CliOutput;
      const storeRef = yield* storeOptions.loadStoreRef(store);
      const expr = yield* parseFilter(filter, filterJson);
      const parsedInterval = yield* parseInterval(interval);
      return yield* storeLock.withStoreLock(
        storeRef,
        Effect.gen(function* () {
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
      );
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
    quiet: quietOption
  },
  ({ store, filter, filterJson, interval, quiet }) =>
    Effect.gen(function* () {
      const storeLock = yield* StoreLock;
      const sync = yield* SyncEngine;
      const monitor = yield* ResourceMonitor;
      const output = yield* CliOutput;
      const storeRef = yield* storeOptions.loadStoreRef(store);
      const expr = yield* parseFilter(filter, filterJson);
      const parsedInterval = yield* parseInterval(interval);
      return yield* storeLock.withStoreLock(
        storeRef,
        Effect.gen(function* () {
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
      );
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

const jetstreamCommand = Command.make(
  "jetstream",
  {
    store: storeNameOption,
    filter: filterOption,
    filterJson: filterJsonOption,
    quiet: quietOption,
    endpoint: jetstreamOptions.endpoint,
    collections: jetstreamOptions.collections,
    dids: jetstreamOptions.dids,
    cursor: jetstreamOptions.cursor,
    compress: jetstreamOptions.compress,
    maxMessageSize: jetstreamOptions.maxMessageSize,
    strict: strictOption,
    maxErrors: maxErrorsOption
  },
  ({
    store,
    filter,
    filterJson,
    quiet,
    endpoint,
    collections,
    dids,
    cursor,
    compress,
    maxMessageSize,
    strict,
    maxErrors
  }) =>
    Effect.gen(function* () {
      const storeLock = yield* StoreLock;
      const monitor = yield* ResourceMonitor;
      const output = yield* CliOutput;
      const storeRef = yield* storeOptions.loadStoreRef(store);
      const expr = yield* parseFilter(filter, filterJson);
      const filterHash = filterExprSignature(expr);
      const selection = yield* buildJetstreamSelection(
        {
          endpoint,
          collections,
          dids,
          cursor,
          compress,
          maxMessageSize
        },
        storeRef,
        filterHash
      );
      const parsedMaxErrors = yield* parseMaxErrors(maxErrors);
      const engineLayer = JetstreamSyncEngine.layer.pipe(
        Layer.provideMerge(Jetstream.live(selection.config))
      );
      return yield* storeLock.withStoreLock(
        storeRef,
        Effect.gen(function* () {
          yield* logInfo("Starting watch", { source: "jetstream", store: storeRef.name });
          yield* Effect.gen(function* () {
            const engine = yield* JetstreamSyncEngine;
            const maxErrorsValue = Option.getOrUndefined(parsedMaxErrors);
            const stream = engine.watch({
              source: selection.source,
              store: storeRef,
              filter: expr,
              command: "watch jetstream",
              ...(selection.cursor !== undefined ? { cursor: selection.cursor } : {}),
              ...(strict ? { strict } : {}),
              ...(maxErrorsValue !== undefined ? { maxErrors: maxErrorsValue } : {})
            });
            const outputStream = stream.pipe(
              Stream.map((event) => event.result),
              Stream.provideService(
                SyncReporter,
                makeSyncReporter(quiet, monitor, output)
              )
            );
            return yield* writeJsonStream(outputStream);
          }).pipe(Effect.provide(engineLayer));
        })
      );
    })
).pipe(
  Command.withDescription(
    withExamples(
      "Watch Jetstream updates and emit sync results (posts only)",
      [
        "skygent watch jetstream --store my-store",
        "skygent watch jetstream --store my-store --quiet"
      ],
      ["Tip: use --collections to override subscribed collections."]
    )
  )
);

export const watchCommand = Command.make("watch", {}).pipe(
  Command.withSubcommands([
    timelineCommand,
    feedCommand,
    notificationsCommand,
    jetstreamCommand
  ]),
  Command.withDescription(
    withExamples("Continuously sync and emit results", [
      "skygent watch timeline --store my-store --interval \"2 minutes\""
    ])
  )
);
