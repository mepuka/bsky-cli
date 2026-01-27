import { Args, Command, Options } from "@effect/cli";
import { Duration, Effect, Layer, Option } from "effect";
import { Jetstream } from "effect-jetstream";
import { filterExprSignature } from "../domain/filter.js";
import { StoreName } from "../domain/primitives.js";
import { DataSource, SyncResult } from "../domain/sync.js";
import { SyncEngine } from "../services/sync-engine.js";
import { JetstreamSyncEngine } from "../services/jetstream-sync.js";
import { filterDslDescription, filterJsonDescription } from "./filter-help.js";
import { parseFilterExpr } from "./filter-input.js";
import { CliOutput, writeJson } from "./output.js";
import { storeOptions } from "./store.js";
import { logInfo, makeSyncReporter } from "./logging.js";
import { SyncReporter } from "../services/sync-reporter.js";
import { ResourceMonitor } from "../services/resource-monitor.js";
import { OutputManager } from "../services/output-manager.js";
import { withExamples } from "./help.js";
import { buildJetstreamSelection, jetstreamOptions } from "./jetstream.js";
import { CliInputError } from "./errors.js";

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
const quietOption = Options.boolean("quiet").pipe(
  Options.withDescription("Suppress progress output")
);
const limitOption = Options.integer("limit").pipe(
  Options.withDescription("Maximum number of Jetstream events to process"),
  Options.optional
);
const durationOption = Options.text("duration").pipe(
  Options.withDescription("Stop after a duration (e.g. \"2 minutes\")"),
  Options.optional
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

const parseLimit = (limit: Option.Option<number>) =>
  Option.match(limit, {
    onNone: () => Effect.succeed(Option.none()),
    onSome: (value) =>
      value <= 0
        ? Effect.fail(
            CliInputError.make({
              message: "Limit must be a positive integer.",
              cause: value
            })
          )
        : Effect.succeed(Option.some(value))
  });

const parseDuration = (value: Option.Option<string>) =>
  Option.match(value, {
    onNone: () => Effect.succeed(Option.none()),
    onSome: (raw) =>
      Effect.try({
        try: () => Duration.decode(raw as Duration.DurationInput),
        catch: (cause) =>
          CliInputError.make({
            message: `Invalid duration: ${raw}. Use formats like \"2 minutes\".`,
            cause
          })
      }).pipe(
        Effect.flatMap((duration) =>
          Duration.toMillis(duration) < 0
            ? Effect.fail(
                CliInputError.make({
                  message: "Duration must be non-negative.",
                  cause: duration
                })
              )
            : Effect.succeed(Option.some(duration))
        )
      )
  });

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
).pipe(
  Command.withDescription(
    withExamples(
      "Sync the authenticated timeline into a store",
      [
        "skygent sync timeline --store my-store",
        "skygent sync timeline --store my-store --filter 'hashtag:#ai' --quiet"
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
).pipe(
  Command.withDescription(
    withExamples(
      "Sync a feed URI into a store",
      [
        "skygent sync feed at://did:plc:example/app.bsky.feed.generator/xyz --store my-store"
      ],
      ["Tip: add --quiet to suppress progress logs."]
    )
  )
);

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
).pipe(
  Command.withDescription(
    withExamples(
      "Sync notifications into a store",
      ["skygent sync notifications --store my-store --quiet"],
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
    limit: limitOption,
    duration: durationOption,
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
    limit,
    duration,
    strict,
    maxErrors
  }) =>
    Effect.gen(function* () {
      const monitor = yield* ResourceMonitor;
      const output = yield* CliOutput;
      const outputManager = yield* OutputManager;
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
      const parsedLimit = yield* parseLimit(limit);
      const parsedDuration = yield* parseDuration(duration);
      const parsedMaxErrors = yield* parseMaxErrors(maxErrors);
      if (Option.isNone(parsedLimit) && Option.isNone(parsedDuration)) {
        return yield* CliInputError.make({
          message:
            "Jetstream sync requires --limit or --duration. Use watch jetstream for continuous streaming.",
          cause: { limit, duration }
        });
      }
      const engineLayer = JetstreamSyncEngine.layer.pipe(
        Layer.provideMerge(Jetstream.live(selection.config))
      );
      yield* logInfo("Starting sync", {
        source: "jetstream",
        store: storeRef.name
      });
      const result = yield* Effect.gen(function* () {
        const engine = yield* JetstreamSyncEngine;
        const limitValue = Option.getOrUndefined(parsedLimit);
        const durationValue = Option.getOrUndefined(parsedDuration);
        const maxErrorsValue = Option.getOrUndefined(parsedMaxErrors);
        return yield* engine.sync({
          source: selection.source,
          store: storeRef,
          filter: expr,
          command: "sync jetstream",
          ...(limitValue !== undefined ? { limit: limitValue } : {}),
          ...(durationValue !== undefined ? { duration: durationValue } : {}),
          ...(selection.cursor !== undefined ? { cursor: selection.cursor } : {}),
          ...(strict ? { strict } : {}),
          ...(maxErrorsValue !== undefined ? { maxErrors: maxErrorsValue } : {})
        });
      }).pipe(
        Effect.provide(engineLayer),
        Effect.provideService(SyncReporter, makeSyncReporter(quiet, monitor, output))
      );
      const materialized = yield* outputManager.materializeStore(storeRef);
      if (materialized.filters.length > 0) {
        yield* logInfo("Materialized filter outputs", {
          store: storeRef.name,
          filters: materialized.filters.map((spec) => spec.name)
        });
      }
      yield* logInfo("Sync complete", { source: "jetstream", store: storeRef.name });
      yield* writeJson(result as SyncResult);
    })
).pipe(
  Command.withDescription(
    withExamples(
      "Sync Jetstream events into a store (posts only)",
      [
        "skygent sync jetstream --store my-store --limit 500",
        "skygent sync jetstream --store my-store --duration \"2 minutes\""
      ],
      ["Tip: use watch jetstream for continuous streaming."]
    )
  )
);

export const syncCommand = Command.make("sync", {}).pipe(
  Command.withSubcommands([
    timelineCommand,
    feedCommand,
    notificationsCommand,
    jetstreamCommand
  ]),
  Command.withDescription(
    withExamples("Sync content into stores", [
      "skygent sync timeline --store my-store"
    ])
  )
);
