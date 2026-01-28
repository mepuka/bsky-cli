import { Command, Options } from "@effect/cli";
import { Duration, Effect, Layer, Option } from "effect";
import { Jetstream } from "effect-jetstream";
import { filterExprSignature } from "../domain/filter.js";
import { DataSource, SyncResult } from "../domain/sync.js";
import { JetstreamSyncEngine } from "../services/jetstream-sync.js";
import { storeOptions } from "./store.js";
import { logInfo, makeSyncReporter } from "./logging.js";
import { SyncReporter } from "../services/sync-reporter.js";
import { ResourceMonitor } from "../services/resource-monitor.js";
import { OutputManager } from "../services/output-manager.js";
import { StoreLock } from "../services/store-lock.js";
import { CliOutput, writeJson } from "./output.js";
import { parseFilterExpr } from "./filter-input.js";
import { withExamples } from "./help.js";
import { buildJetstreamSelection, jetstreamOptions } from "./jetstream.js";
import { CliInputError } from "./errors.js";
import { makeSyncCommandBody } from "./sync-factory.js";
import {
  feedUriArg,
  postUriArg,
  actorArg,
  storeNameOption,
  filterOption,
  filterJsonOption,
  postFilterOption,
  postFilterJsonOption,
  authorFilterOption,
  includePinsOption,
  quietOption,
  strictOption,
  maxErrorsOption,
  parseMaxErrors
} from "./shared-options.js";

const limitOption = Options.integer("limit").pipe(
  Options.withDescription("Maximum number of Jetstream events to process"),
  Options.optional
);
const durationOption = Options.text("duration").pipe(
  Options.withDescription("Stop after a duration (e.g. \"2 minutes\")"),
  Options.optional
);
const depthOption = Options.integer("depth").pipe(
  Options.withDescription("Thread reply depth to include (0-1000, default 6)"),
  Options.optional
);
const parentHeightOption = Options.integer("parent-height").pipe(
  Options.withDescription("Thread parent height to include (0-1000, default 80)"),
  Options.optional
);

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

const parseBoundedIntOption = (
  value: Option.Option<number>,
  name: string,
  min: number,
  max: number
) =>
  Option.match(value, {
    onNone: () => Effect.succeed(Option.none()),
    onSome: (raw) =>
      raw < min || raw > max
        ? Effect.fail(
            CliInputError.make({
              message: `${name} must be between ${min} and ${max}.`,
              cause: raw
            })
          )
        : Effect.succeed(Option.some(raw))
  });

const timelineCommand = Command.make(
  "timeline",
  { store: storeNameOption, filter: filterOption, filterJson: filterJsonOption, quiet: quietOption },
  makeSyncCommandBody("timeline", () => DataSource.timeline())
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

const feedCommand = Command.make(
  "feed",
  { uri: feedUriArg, store: storeNameOption, filter: filterOption, filterJson: filterJsonOption, quiet: quietOption },
  ({ uri, ...rest }) => makeSyncCommandBody("feed", () => DataSource.feed(uri), { uri })(rest)
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
  makeSyncCommandBody("notifications", () => DataSource.notifications())
).pipe(
  Command.withDescription(
    withExamples(
      "Sync notifications into a store",
      ["skygent sync notifications --store my-store --quiet"],
      ["Tip: add --quiet to suppress progress logs."]
    )
  )
);

const authorCommand = Command.make(
  "author",
  {
    actor: actorArg,
    store: storeNameOption,
    filter: authorFilterOption,
    includePins: includePinsOption,
    postFilter: postFilterOption,
    postFilterJson: postFilterJsonOption,
    quiet: quietOption
  },
  ({ actor, filter, includePins, postFilter, postFilterJson, store, quiet }) =>
    Effect.gen(function* () {
      const apiFilter = Option.getOrUndefined(filter);
      const source = DataSource.author(actor, {
        ...(apiFilter !== undefined ? { filter: apiFilter } : {}),
        ...(includePins ? { includePins: true } : {})
      });
      const run = makeSyncCommandBody("author", () => source, {
        actor,
        ...(apiFilter !== undefined ? { filter: apiFilter } : {}),
        ...(includePins ? { includePins: true } : {})
      });
      return yield* run({
        store,
        filter: postFilter,
        filterJson: postFilterJson,
        quiet
      });
    })
).pipe(
  Command.withDescription(
    withExamples(
      "Sync posts from a specific author",
      [
        "skygent sync author alice.bsky.social --store my-store",
        "skygent sync author did:plc:example --store my-store --filter posts_no_replies --include-pins"
      ],
      ["Tip: use --post-filter to apply the DSL filter to synced posts."]
    )
  )
);

const threadCommand = Command.make(
  "thread",
  {
    uri: postUriArg,
    store: storeNameOption,
    depth: depthOption,
    parentHeight: parentHeightOption,
    filter: filterOption,
    filterJson: filterJsonOption,
    quiet: quietOption
  },
  ({ uri, depth, parentHeight, filter, filterJson, store, quiet }) =>
    Effect.gen(function* () {
      const parsedDepth = yield* parseBoundedIntOption(depth, "depth", 0, 1000);
      const parsedParentHeight = yield* parseBoundedIntOption(
        parentHeight,
        "parent-height",
        0,
        1000
      );
      const depthValue = Option.getOrUndefined(parsedDepth);
      const parentHeightValue = Option.getOrUndefined(parsedParentHeight);
      const source = DataSource.thread(uri, {
        ...(depthValue !== undefined ? { depth: depthValue } : {}),
        ...(parentHeightValue !== undefined ? { parentHeight: parentHeightValue } : {})
      });
      const run = makeSyncCommandBody("thread", () => source, {
        uri,
        ...(depthValue !== undefined ? { depth: depthValue } : {}),
        ...(parentHeightValue !== undefined ? { parentHeight: parentHeightValue } : {})
      });
      return yield* run({ store, filter, filterJson, quiet });
    })
).pipe(
  Command.withDescription(
    withExamples(
      "Sync a post thread (parents + replies) into a store",
      [
        "skygent sync thread at://did:plc:example/app.bsky.feed.post/xyz --store my-store",
        "skygent sync thread at://did:plc:example/app.bsky.feed.post/xyz --store my-store --depth 10 --parent-height 5"
      ],
      ["Tip: use --filter to apply the DSL filter to thread posts."]
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
      const storeLock = yield* StoreLock;
      const monitor = yield* ResourceMonitor;
      const output = yield* CliOutput;
      const outputManager = yield* OutputManager;
      const storeRef = yield* storeOptions.loadStoreRef(store);
      const expr = yield* parseFilterExpr(filter, filterJson);
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
      return yield* storeLock.withStoreLock(
        storeRef,
        Effect.gen(function* () {
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
      );
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
    authorCommand,
    threadCommand,
    jetstreamCommand
  ]),
  Command.withDescription(
    withExamples("Sync content into stores", [
      "skygent sync timeline --store my-store"
    ])
  )
);
