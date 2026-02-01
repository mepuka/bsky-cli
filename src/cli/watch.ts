import { Command, Options } from "@effect/cli";
import { Effect, Layer, Option, Stream } from "effect";
import { Jetstream } from "effect-jetstream";
import { filterExprSignature } from "../domain/filter.js";
import { DataSource } from "../domain/sync.js";
import { SyncReporter } from "../services/sync-reporter.js";
import { JetstreamSyncEngine } from "../services/jetstream-sync.js";
import { parseFilterExpr } from "./filter-input.js";
import { CliOutput, writeJsonStream } from "./output.js";
import { storeOptions } from "./store.js";
import { logInfo, logWarn, makeSyncReporter } from "./logging.js";
import { ResourceMonitor } from "../services/resource-monitor.js";
import { withExamples } from "./help.js";
import { buildJetstreamSelection, jetstreamOptions } from "./jetstream.js";
import { makeWatchCommandBody, resolveCacheLimit, resolveCacheMode } from "./sync-factory.js";
import { parseOptionalDuration } from "./interval.js";
import { cacheStoreImages } from "./image-cache.js";
import {
  feedUriArg,
  listUriArg,
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
  refreshOption,
  cacheImagesOption,
  cacheImagesModeOption,
  cacheImagesLimitOption,
  strictOption,
  maxErrorsOption
} from "./shared-options.js";
import {
  depthOption as threadDepthOption,
  parentHeightOption as threadParentHeightOption,
  parseThreadDepth
} from "./thread-options.js";
import { DurationInput, PositiveInt } from "./option-schemas.js";

const intervalOption = Options.text("interval").pipe(
  Options.withSchema(DurationInput),
  Options.withDescription(
    "Polling interval (e.g. \"30 seconds\", \"500 millis\") (default: 30 seconds)"
  ),
  Options.optional
);
const maxCyclesOption = Options.integer("max-cycles").pipe(
  Options.withSchema(PositiveInt),
  Options.withDescription("Stop after N watch cycles"),
  Options.optional
);
const untilOption = Options.text("until").pipe(
  Options.withSchema(DurationInput),
  Options.withDescription("Stop after a duration (e.g. \"10 minutes\")"),
  Options.optional
);
const depthOption = threadDepthOption(
  "Thread reply depth to include (0-1000, default 6)"
);
const parentHeightOption = threadParentHeightOption(
  "Thread parent height to include (0-1000, default 80)"
);

const timelineCommand = Command.make(
  "timeline",
  {
    store: storeNameOption,
    filter: filterOption,
    filterJson: filterJsonOption,
    interval: intervalOption,
    maxCycles: maxCyclesOption,
    until: untilOption,
    quiet: quietOption,
    refresh: refreshOption,
    cacheImages: cacheImagesOption,
    cacheImagesMode: cacheImagesModeOption,
    cacheImagesLimit: cacheImagesLimitOption
  },
  makeWatchCommandBody("timeline", () => DataSource.timeline())
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

const feedCommand = Command.make(
  "feed",
  {
    uri: feedUriArg,
    store: storeNameOption,
    filter: filterOption,
    filterJson: filterJsonOption,
    interval: intervalOption,
    maxCycles: maxCyclesOption,
    until: untilOption,
    quiet: quietOption,
    refresh: refreshOption,
    cacheImages: cacheImagesOption,
    cacheImagesMode: cacheImagesModeOption,
    cacheImagesLimit: cacheImagesLimitOption
  },
  ({ uri, ...rest }) => makeWatchCommandBody("feed", () => DataSource.feed(uri), { uri })(rest)
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

const listCommand = Command.make(
  "list",
  {
    uri: listUriArg,
    store: storeNameOption,
    filter: filterOption,
    filterJson: filterJsonOption,
    interval: intervalOption,
    maxCycles: maxCyclesOption,
    until: untilOption,
    quiet: quietOption,
    refresh: refreshOption,
    cacheImages: cacheImagesOption,
    cacheImagesMode: cacheImagesModeOption,
    cacheImagesLimit: cacheImagesLimitOption
  },
  ({ uri, ...rest }) => makeWatchCommandBody("list", () => DataSource.list(uri), { uri })(rest)
).pipe(
  Command.withDescription(
    withExamples(
      "Watch a list feed URI and emit sync results",
      [
        "skygent watch list at://did:plc:example/app.bsky.graph.list/xyz --store my-store --interval \"2 minutes\""
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
    maxCycles: maxCyclesOption,
    until: untilOption,
    quiet: quietOption,
    refresh: refreshOption,
    cacheImages: cacheImagesOption,
    cacheImagesMode: cacheImagesModeOption,
    cacheImagesLimit: cacheImagesLimitOption
  },
  makeWatchCommandBody("notifications", () => DataSource.notifications())
).pipe(
  Command.withDescription(
    withExamples(
      "Watch notifications and emit sync results",
      ["skygent watch notifications --store my-store --interval \"1 minute\" --quiet"],
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
    interval: intervalOption,
    maxCycles: maxCyclesOption,
    until: untilOption,
    quiet: quietOption,
    refresh: refreshOption,
    cacheImages: cacheImagesOption,
    cacheImagesMode: cacheImagesModeOption,
    cacheImagesLimit: cacheImagesLimitOption
  },
  ({ actor, filter, includePins, postFilter, postFilterJson, interval, maxCycles, until, store, quiet, refresh, cacheImages, cacheImagesMode, cacheImagesLimit }) =>
    Effect.gen(function* () {
      const apiFilter = Option.getOrUndefined(filter);
      const source = DataSource.author(actor, {
        ...(apiFilter !== undefined ? { filter: apiFilter } : {}),
        ...(includePins ? { includePins: true } : {})
      });
      const run = makeWatchCommandBody("author", () => source, {
        actor,
        ...(apiFilter !== undefined ? { filter: apiFilter } : {}),
        ...(includePins ? { includePins: true } : {})
      });
      return yield* run({
        store,
        filter: postFilter,
        filterJson: postFilterJson,
        interval,
        maxCycles,
        until,
        quiet,
        refresh,
        cacheImages,
        cacheImagesMode,
        cacheImagesLimit
      });
    })
).pipe(
  Command.withDescription(
    withExamples(
      "Watch an author's feed and emit sync results",
      [
        "skygent watch author alice.bsky.social --store my-store",
        "skygent watch author did:plc:example --store my-store --filter posts_no_replies --include-pins"
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
    interval: intervalOption,
    maxCycles: maxCyclesOption,
    until: untilOption,
    quiet: quietOption,
    refresh: refreshOption,
    cacheImages: cacheImagesOption,
    cacheImagesMode: cacheImagesModeOption,
    cacheImagesLimit: cacheImagesLimitOption
  },
  ({ uri, depth, parentHeight, filter, filterJson, interval, maxCycles, until, store, quiet, refresh, cacheImages, cacheImagesMode, cacheImagesLimit }) =>
    Effect.gen(function* () {
      const { depth: depthValue, parentHeight: parentHeightValue } =
        parseThreadDepth(depth, parentHeight);
      const source = DataSource.thread(uri, {
        ...(depthValue !== undefined ? { depth: depthValue } : {}),
        ...(parentHeightValue !== undefined ? { parentHeight: parentHeightValue } : {})
      });
      const run = makeWatchCommandBody("thread", () => source, {
        uri,
        ...(depthValue !== undefined ? { depth: depthValue } : {}),
        ...(parentHeightValue !== undefined ? { parentHeight: parentHeightValue } : {})
      });
      return yield* run({ store, filter, filterJson, interval, maxCycles, until, quiet, refresh, cacheImages, cacheImagesMode, cacheImagesLimit });
    })
).pipe(
  Command.withDescription(
    withExamples(
      "Watch a thread and emit sync results",
      [
        "skygent watch thread at://did:plc:example/app.bsky.feed.post/xyz --store my-store",
        "skygent watch thread at://did:plc:example/app.bsky.feed.post/xyz --store my-store --depth 10 --parent-height 5"
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
    maxCycles: maxCyclesOption,
    until: untilOption,
    cacheImages: cacheImagesOption,
    cacheImagesMode: cacheImagesModeOption,
    cacheImagesLimit: cacheImagesLimitOption,
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
    maxCycles,
    until,
    cacheImages,
    cacheImagesMode,
    cacheImagesLimit,
    strict,
    maxErrors
  }) =>
    Effect.gen(function* () {
      const monitor = yield* ResourceMonitor;
      const output = yield* CliOutput;
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
      const parsedUntil = parseOptionalDuration(until);
      const cacheMode = cacheImages ? resolveCacheMode(cacheImagesMode) : "new";
      const resolveNewCacheLimit = (postsAdded: number) =>
        resolveCacheLimit("new", postsAdded, cacheImagesLimit);
      const engineLayer = JetstreamSyncEngine.layer.pipe(
        Layer.provideMerge(Jetstream.live(selection.config))
      );
      yield* logInfo("Starting watch", { source: "jetstream", store: storeRef.name });
      if (cacheImages && cacheMode === "full") {
        yield* Effect.gen(function* () {
          yield* logWarn("Running full image cache scan", {
            store: storeRef.name,
            source: "jetstream"
          });
          const cacheResult = yield* cacheStoreImages(storeRef, {
            includeThumbnails: true,
            ...(Option.isSome(cacheImagesLimit)
              ? { limit: cacheImagesLimit.value }
              : {})
          });
          yield* logInfo("Image cache complete", cacheResult);
        }).pipe(
          Effect.catchAll((error) =>
            logWarn("Image cache failed", {
              store: storeRef.name,
              source: "jetstream",
              error
            }).pipe(Effect.orElseSucceed(() => undefined))
          )
        );
      }
      yield* Effect.gen(function* () {
        const engine = yield* JetstreamSyncEngine;
        const maxErrorsValue = Option.getOrUndefined(maxErrors);
        const stream = engine.watch({
          source: selection.source,
          store: storeRef,
          filter: expr,
          command: "watch jetstream",
          ...(selection.cursor !== undefined ? { cursor: selection.cursor } : {}),
          ...(strict ? { strict } : {}),
          ...(maxErrorsValue !== undefined ? { maxErrors: maxErrorsValue } : {})
        });
        const baseStream = stream.pipe(
          Stream.map((event) => event.result),
          Stream.provideService(
            SyncReporter,
            makeSyncReporter(quiet, monitor, output)
          )
        );
        const outputStream = cacheImages
          ? baseStream.pipe(
              Stream.mapEffect((result) =>
                result.postsAdded > 0
                  ? Effect.gen(function* () {
                      const cacheLimit = resolveNewCacheLimit(result.postsAdded);
                      yield* logInfo("Caching image embeds", {
                        store: storeRef.name,
                        source: "jetstream",
                        postsAdded: result.postsAdded
                      });
                      const cacheResult = yield* cacheStoreImages(storeRef, {
                        includeThumbnails: true,
                        ...(cacheLimit !== undefined && cacheLimit > 0
                          ? { limit: cacheLimit }
                          : {})
                      });
                      yield* logInfo("Image cache complete", cacheResult);
                    }).pipe(
                      Effect.catchAll((error) =>
                        logWarn("Image cache failed", {
                          store: storeRef.name,
                          source: "jetstream",
                          error
                        }).pipe(Effect.orElseSucceed(() => undefined))
                      ),
                      Effect.as(result)
                    )
                  : Effect.succeed(result)
              )
            )
          : baseStream;
        const limited = Option.isSome(maxCycles)
          ? outputStream.pipe(Stream.take(maxCycles.value))
          : outputStream;
        const timed = Option.isSome(parsedUntil)
          ? limited.pipe(Stream.interruptWhen(Effect.sleep(parsedUntil.value)))
          : limited;
        return yield* writeJsonStream(timed);
      }).pipe(Effect.provide(engineLayer));
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
    listCommand,
    notificationsCommand,
    authorCommand,
    threadCommand,
    jetstreamCommand
  ]),
  Command.withDescription(
    withExamples("Continuously sync and emit results", [
      "skygent watch timeline --store my-store --interval \"2 minutes\""
    ])
  )
);
