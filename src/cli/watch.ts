import { Command, Options } from "@effect/cli";
import { Chunk, Effect, Layer, Option, Ref, Schedule, Stream } from "effect";
import { Jetstream } from "effect-jetstream";
import { filterExprSignature } from "../domain/filter.js";
import type { FilterExpr } from "../domain/filter.js";
import { DataSource, SyncError, SyncResult, SyncResultMonoid } from "../domain/sync.js";
import { SyncReporter } from "../services/sync-reporter.js";
import { JetstreamSyncEngine } from "../services/jetstream-sync.js";
import { SyncEngine } from "../services/sync-engine.js";
import { SyncSettings } from "../services/sync-settings.js";
import { BskyClient } from "../services/bsky-client.js";
import { parseFilterExpr } from "./filter-input.js";
import { CliOutput, writeJsonStream, writeText } from "./output.js";
import { storeOptions } from "./store.js";
import { logInfo, logWarn, makeSyncReporter } from "./logging.js";
import { ResourceMonitor } from "../services/resource-monitor.js";
import { withExamples } from "./help.js";
import { filterHelpText } from "./filter-help.js";
import { buildJetstreamSelection, jetstreamOptions } from "./jetstream.js";
import { CliInputError } from "./errors.js";
import { makeWatchCommandBody, resolveCacheLimit, resolveCacheMode } from "./sync-factory.js";
import { parseInterval, parseOptionalDuration } from "./interval.js";
import { cacheStoreImages } from "./image-cache.js";
import {
  feedUriArg,
  listUriArg,
  postUriArg,
  actorArg,
  storeNameArg,
  storeNameOption,
  filterOption,
  filterJsonOption,
  filterHelpOption,
  postFilterOption,
  postFilterJsonOption,
  authorFilterOption,
  includePinsOption,
  quietOption,
  refreshOption,
  cacheImagesOption,
  cacheImagesModeOption,
  cacheImagesLimitOption,
  noCacheImagesThumbnailsOption,
  strictOption,
  maxErrorsOption,
  resolveStoreName
} from "./shared-options.js";
import { storeSourceId, type StoreSource } from "../domain/store-sources.js";
import { StoreSources } from "../services/store-sources.js";
import {
  resolveStoreSources,
  loadListMembers,
  storeSourceDataSource,
  storeSourceFilterExpr
} from "./store-source-helpers.js";
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

const authorsOnlyOption = Options.boolean("authors-only").pipe(
  Options.withDescription("Watch only author sources from the store registry")
);
const feedsOnlyOption = Options.boolean("feeds-only").pipe(
  Options.withDescription("Watch only feed sources from the store registry")
);
const listsOnlyOption = Options.boolean("lists-only").pipe(
  Options.withDescription("Watch only list sources from the store registry")
);

const timelineCommand = Command.make(
  "timeline",
  {
    storeName: storeNameArg,
    store: storeNameOption,
    filter: filterOption,
    filterJson: filterJsonOption,
    filterHelp: filterHelpOption,
    interval: intervalOption,
    maxCycles: maxCyclesOption,
    until: untilOption,
    quiet: quietOption,
    refresh: refreshOption,
    cacheImages: cacheImagesOption,
    cacheImagesMode: cacheImagesModeOption,
    cacheImagesLimit: cacheImagesLimitOption,
    noCacheImagesThumbnails: noCacheImagesThumbnailsOption
  },
  ({ store, storeName, filterHelp, ...input }) =>
    Effect.gen(function* () {
      if (filterHelp) {
        yield* writeText(filterHelpText());
        return;
      }
      const resolvedStore = yield* resolveStoreName(storeName, store);
      return yield* makeWatchCommandBody("timeline", () => DataSource.timeline())({
        ...input,
        store: resolvedStore
      });
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

const feedCommand = Command.make(
  "feed",
  {
    uri: feedUriArg,
    storeName: storeNameArg,
    store: storeNameOption,
    filter: filterOption,
    filterJson: filterJsonOption,
    filterHelp: filterHelpOption,
    interval: intervalOption,
    maxCycles: maxCyclesOption,
    until: untilOption,
    quiet: quietOption,
    refresh: refreshOption,
    cacheImages: cacheImagesOption,
    cacheImagesMode: cacheImagesModeOption,
    cacheImagesLimit: cacheImagesLimitOption,
    noCacheImagesThumbnails: noCacheImagesThumbnailsOption
  },
  ({ uri, store, storeName, filterHelp, ...rest }) =>
    Effect.gen(function* () {
      if (filterHelp) {
        yield* writeText(filterHelpText());
        return;
      }
      const resolvedStore = yield* resolveStoreName(storeName, store);
      return yield* makeWatchCommandBody("feed", () => DataSource.feed(uri), { uri })({
        ...rest,
        store: resolvedStore
      });
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

const listCommand = Command.make(
  "list",
  {
    uri: listUriArg,
    storeName: storeNameArg,
    store: storeNameOption,
    filter: filterOption,
    filterJson: filterJsonOption,
    filterHelp: filterHelpOption,
    interval: intervalOption,
    maxCycles: maxCyclesOption,
    until: untilOption,
    quiet: quietOption,
    refresh: refreshOption,
    cacheImages: cacheImagesOption,
    cacheImagesMode: cacheImagesModeOption,
    cacheImagesLimit: cacheImagesLimitOption,
    noCacheImagesThumbnails: noCacheImagesThumbnailsOption
  },
  ({ uri, store, storeName, filterHelp, ...rest }) =>
    Effect.gen(function* () {
      if (filterHelp) {
        yield* writeText(filterHelpText());
        return;
      }
      const resolvedStore = yield* resolveStoreName(storeName, store);
      return yield* makeWatchCommandBody("list", () => DataSource.list(uri), { uri })({
        ...rest,
        store: resolvedStore
      });
    })
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
    storeName: storeNameArg,
    store: storeNameOption,
    filter: filterOption,
    filterJson: filterJsonOption,
    filterHelp: filterHelpOption,
    interval: intervalOption,
    maxCycles: maxCyclesOption,
    until: untilOption,
    quiet: quietOption,
    refresh: refreshOption,
    cacheImages: cacheImagesOption,
    cacheImagesMode: cacheImagesModeOption,
    cacheImagesLimit: cacheImagesLimitOption,
    noCacheImagesThumbnails: noCacheImagesThumbnailsOption
  },
  ({ store, storeName, filterHelp, ...input }) =>
    Effect.gen(function* () {
      if (filterHelp) {
        yield* writeText(filterHelpText());
        return;
      }
      const resolvedStore = yield* resolveStoreName(storeName, store);
      return yield* makeWatchCommandBody("notifications", () => DataSource.notifications())({
        ...input,
        store: resolvedStore
      });
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

const authorCommand = Command.make(
  "author",
  {
    actor: actorArg,
    storeName: storeNameArg,
    store: storeNameOption,
    filter: authorFilterOption,
    includePins: includePinsOption,
    postFilter: postFilterOption,
    postFilterJson: postFilterJsonOption,
    filterHelp: filterHelpOption,
    interval: intervalOption,
    maxCycles: maxCyclesOption,
    until: untilOption,
    quiet: quietOption,
    refresh: refreshOption,
    cacheImages: cacheImagesOption,
    cacheImagesMode: cacheImagesModeOption,
    cacheImagesLimit: cacheImagesLimitOption,
    noCacheImagesThumbnails: noCacheImagesThumbnailsOption
  },
  ({ actor, filter, includePins, postFilter, postFilterJson, filterHelp, interval, maxCycles, until, store, storeName, quiet, refresh, cacheImages, cacheImagesMode, cacheImagesLimit, noCacheImagesThumbnails }) =>
    Effect.gen(function* () {
      if (filterHelp) {
        yield* writeText(filterHelpText());
        return;
      }
      const resolvedStore = yield* resolveStoreName(storeName, store);
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
        store: resolvedStore,
        filter: postFilter,
        filterJson: postFilterJson,
        interval,
        maxCycles,
        until,
        quiet,
        refresh,
        cacheImages,
        cacheImagesMode,
        cacheImagesLimit,
        noCacheImagesThumbnails
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
    storeName: storeNameArg,
    store: storeNameOption,
    depth: depthOption,
    parentHeight: parentHeightOption,
    filter: filterOption,
    filterJson: filterJsonOption,
    filterHelp: filterHelpOption,
    interval: intervalOption,
    maxCycles: maxCyclesOption,
    until: untilOption,
    quiet: quietOption,
    refresh: refreshOption,
    cacheImages: cacheImagesOption,
    cacheImagesMode: cacheImagesModeOption,
    cacheImagesLimit: cacheImagesLimitOption,
    noCacheImagesThumbnails: noCacheImagesThumbnailsOption
  },
  ({ uri, depth, parentHeight, filter, filterJson, filterHelp, interval, maxCycles, until, store, storeName, quiet, refresh, cacheImages, cacheImagesMode, cacheImagesLimit, noCacheImagesThumbnails }) =>
    Effect.gen(function* () {
      if (filterHelp) {
        yield* writeText(filterHelpText());
        return;
      }
      const resolvedStore = yield* resolveStoreName(storeName, store);
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
      return yield* run({
        store: resolvedStore,
        filter,
        filterJson,
        interval,
        maxCycles,
        until,
        quiet,
        refresh,
        cacheImages,
        cacheImagesMode,
        cacheImagesLimit,
        noCacheImagesThumbnails
      });
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
    storeName: storeNameArg,
    store: storeNameOption,
    filter: filterOption,
    filterJson: filterJsonOption,
    filterHelp: filterHelpOption,
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
    noCacheImagesThumbnails: noCacheImagesThumbnailsOption,
    strict: strictOption,
    maxErrors: maxErrorsOption
  },
  ({
    store,
    storeName,
    filter,
    filterJson,
    filterHelp,
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
    noCacheImagesThumbnails,
    strict,
    maxErrors
  }) =>
    Effect.gen(function* () {
      if (filterHelp) {
        yield* writeText(filterHelpText());
        return;
      }
      const resolvedStore = yield* resolveStoreName(storeName, store);
      const monitor = yield* ResourceMonitor;
      const output = yield* CliOutput;
      const storeRef = yield* storeOptions.loadStoreRef(resolvedStore);
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
            includeThumbnails: !noCacheImagesThumbnails,
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
                        includeThumbnails: !noCacheImagesThumbnails,
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

const watchStoreCommand = Command.make(
  "watch",
  {
    storeName: storeNameArg,
    store: storeNameOption,
    authorsOnly: authorsOnlyOption,
    feedsOnly: feedsOnlyOption,
    listsOnly: listsOnlyOption,
    interval: intervalOption,
    maxCycles: maxCyclesOption,
    until: untilOption,
    quiet: quietOption,
    refresh: refreshOption,
    cacheImages: cacheImagesOption,
    cacheImagesMode: cacheImagesModeOption,
    cacheImagesLimit: cacheImagesLimitOption,
    noCacheImagesThumbnails: noCacheImagesThumbnailsOption
  },
  ({
    store,
    storeName,
    authorsOnly,
    feedsOnly,
    listsOnly,
    interval,
    maxCycles,
    until,
    quiet,
    refresh,
    cacheImages,
    cacheImagesMode,
    cacheImagesLimit,
    noCacheImagesThumbnails
  }) =>
    Effect.gen(function* () {
      const sync = yield* SyncEngine;
      const monitor = yield* ResourceMonitor;
      const output = yield* CliOutput;
      const storeSources = yield* StoreSources;
      const settings = yield* SyncSettings;
      const resolvedStore = yield* resolveStoreName(storeName, store);
      const storeRef = yield* storeOptions.loadStoreRef(resolvedStore);
      const storeConfig = yield* storeOptions.loadStoreConfig(resolvedStore);
      const warnedJetstreamRef = yield* Ref.make(false);
      const filterJetstreamSources = (sources: ReadonlyArray<StoreSource>) =>
        Effect.gen(function* () {
          const jetstreamSources = sources.filter(
            (source) => source._tag === "JetstreamSource"
          );
          if (jetstreamSources.length === 0) {
            return sources;
          }
          const warned = yield* Ref.get(warnedJetstreamRef);
          if (!warned) {
            yield* logWarn(
              "Jetstream sources are not yet supported in store watch; skipping them.",
              {
                store: storeRef.name,
                sources: jetstreamSources.map((source) => storeSourceId(source))
              }
            );
            yield* Ref.set(warnedJetstreamRef, true);
          }
          const filtered = sources.filter(
            (source) => source._tag !== "JetstreamSource"
          );
          if (filtered.length === 0) {
            return yield* CliInputError.make({
              message:
                "Jetstream sources are not yet supported in store watch. Use watch jetstream for streaming.",
              cause: { store: storeRef.name }
            });
          }
          return filtered;
        });
      const loadSources = () =>
        storeSources
          .list(storeRef)
          .pipe(
            Effect.flatMap((list) =>
              resolveStoreSources(list, { authorsOnly, feedsOnly, listsOnly })
            ),
            Effect.flatMap(filterJetstreamSources)
          );
      const initialSources = yield* loadSources();
      const basePolicy = storeConfig.syncPolicy ?? "dedupe";
      const policy = refresh ? "refresh" : basePolicy;
      const parsedInterval = parseInterval(interval);
      const parsedUntil = parseOptionalDuration(until);
      const reporter = makeSyncReporter(quiet, monitor, output);
      const cacheMode = cacheImages ? resolveCacheMode(cacheImagesMode) : "new";

      yield* logInfo("Starting watch", {
        source: "store",
        store: storeRef.name,
        sources: initialSources.length
      });

      if (policy === "refresh") {
        yield* logWarn("Refresh mode updates existing posts and may grow the event log.", {
          source: "store",
          store: storeRef.name
        });
      }

      if (cacheImages && cacheMode === "full") {
        yield* Effect.gen(function* () {
          yield* logWarn("Running full image cache scan", {
            store: storeRef.name,
            source: "store"
          });
          const cacheResult = yield* cacheStoreImages(storeRef, {
            includeThumbnails: !noCacheImagesThumbnails,
            ...(Option.isSome(cacheImagesLimit)
              ? { limit: cacheImagesLimit.value }
              : {})
          });
          yield* logInfo("Image cache complete", cacheResult);
        }).pipe(
          Effect.catchAll((error) =>
            logWarn("Image cache failed", {
              store: storeRef.name,
              source: "store",
              error
            }).pipe(Effect.orElseSucceed(() => undefined))
          )
        );
      }

      const runCycle = Effect.gen(function* () {
        const sources = yield* loadSources();
        const combineResults = (acc: SyncResult, result: SyncResult) =>
          SyncResultMonoid.combine(acc, result);
        const runSync = (dataSource: DataSource, expr: FilterExpr) =>
          sync
            .stream(dataSource, storeRef, expr, { policy, concurrency: 1 })
            .pipe(
              Stream.runFold(SyncResultMonoid.empty, combineResults),
              Effect.withRequestBatching(true),
              Effect.provideService(SyncReporter, reporter)
            );
        const runSource = (source: (typeof sources)[number]) => {
          const id = storeSourceId(source);
          return Effect.gen(function* () {
            const expr = yield* storeSourceFilterExpr(source, id);
            if (source._tag === "ListSource" && source.expandMembers) {
              const client = yield* BskyClient;
              const members = yield* loadListMembers(
                client,
                source.uri,
                settings.pageLimit
              );

              yield* logInfo("Expanding list members", {
                store: storeRef.name,
                source: id,
                list: source.uri,
                members: members.length
              });

              const combinedMembers = yield* Stream.fromIterable(members).pipe(
                Stream.mapEffect(
                  (member) =>
                    runSync(DataSource.author(member), expr).pipe(
                      Effect.catchAll((error) => {
                        const message =
                          error instanceof Error ? error.message : String(error);
                        const syncError = SyncError.make({
                          stage: "source",
                          message: `List member ${member} failed: ${message}`,
                          cause: error
                        });
                        const failure = SyncResult.make({
                          postsAdded: 0,
                          postsDeleted: 0,
                          postsSkipped: 0,
                          errors: [syncError]
                        });
                        return logWarn("List member sync failed", {
                          store: storeRef.name,
                          list: source.uri,
                          member,
                          error: message
                        }).pipe(Effect.orElseSucceed(() => undefined), Effect.as(failure));
                      })
                    ),
                  {
                    concurrency: Math.min(settings.concurrency, members.length || 1)
                  }
                ),
                Stream.runFold(SyncResultMonoid.empty, combineResults)
              );

              if (combinedMembers.errors.length === 0) {
                yield* storeSources.markSynced(storeRef, id, new Date());
              } else {
                yield* logWarn("List sync completed with errors; lastSyncedAt not updated", {
                  store: storeRef.name,
                  source: id,
                  list: source.uri,
                  errors: combinedMembers.errors.length
                });
              }
              return { id, type: source._tag, result: combinedMembers };
            }

            const dataSource = storeSourceDataSource(source);

            yield* logInfo("Starting sync", {
              source: id,
              type: source._tag,
              store: storeRef.name
            });

            const syncResult = yield* runSync(dataSource, expr);

            if (syncResult.errors.length === 0) {
              yield* storeSources.markSynced(storeRef, id, new Date());
            } else {
              yield* logWarn("Sync completed with errors; lastSyncedAt not updated", {
                store: storeRef.name,
                source: id,
                type: source._tag,
                errors: syncResult.errors.length
              });
            }
            return { id, type: source._tag, result: syncResult };
          }).pipe(
            Effect.catchAll((error) => {
              const message = error instanceof Error ? error.message : String(error);
              const syncError = SyncError.make({ stage: "source", message, cause: error });
              const failure = SyncResult.make({
                postsAdded: 0,
                postsDeleted: 0,
                postsSkipped: 0,
                errors: [syncError]
              });
              return logWarn("Source sync failed", {
                store: storeRef.name,
                source: id,
                type: source._tag,
                error: message
              }).pipe(
                Effect.orElseSucceed(() => undefined),
                Effect.as({ id, type: source._tag, result: failure })
              );
            })
          );
        };

        const resultsChunk = yield* Stream.fromIterable(sources).pipe(
          Stream.mapEffect(runSource, {
            concurrency: Math.min(settings.concurrency, sources.length || 1)
          }),
          Stream.runCollect
        );
        const results = Chunk.toReadonlyArray(resultsChunk);

        const combined = results.reduce(
          (acc, entry) => SyncResultMonoid.combine(acc, entry.result),
          SyncResultMonoid.empty
        );

        return {
          store: storeRef.name,
          sources: results,
          ...(combined as SyncResult)
        };
      }).pipe(
        Effect.catchAll((error) => {
          const message = error instanceof Error ? error.message : String(error);
          const syncError = SyncError.make({ stage: "source", message, cause: error });
          const failure = SyncResult.make({
            postsAdded: 0,
            postsDeleted: 0,
            postsSkipped: 0,
            errors: [syncError]
          });
          return logWarn("Source registry sync failed", {
            store: storeRef.name,
            error: message
          }).pipe(
            Effect.orElseSucceed(() => undefined),
            Effect.as({
              store: storeRef.name,
              sources: [] as ReadonlyArray<{
                readonly id: string;
                readonly type: string;
                readonly result: SyncResult;
              }>,
              ...(failure as SyncResult)
            })
          );
        })
      );

      const baseStream = Stream.repeatEffectWithSchedule(
        runCycle,
        Schedule.spaced(parsedInterval)
      );

      let outputStream = cacheImages
        ? baseStream.pipe(
            Stream.mapEffect((result) =>
              result.postsAdded > 0
                ? Effect.gen(function* () {
                    const cacheLimit = resolveCacheLimit(
                      "new",
                      result.postsAdded,
                      cacheImagesLimit
                    );
                    yield* logInfo("Caching image embeds", {
                      store: storeRef.name,
                      source: "store",
                      postsAdded: result.postsAdded
                    });
                    const cacheResult = yield* cacheStoreImages(storeRef, {
                      includeThumbnails: !noCacheImagesThumbnails,
                      ...(cacheLimit !== undefined && cacheLimit > 0
                        ? { limit: cacheLimit }
                        : {})
                    });
                    yield* logInfo("Image cache complete", cacheResult);
                  }).pipe(
                    Effect.catchAll((error) =>
                      logWarn("Image cache failed", {
                        store: storeRef.name,
                        source: "store",
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
    })
);

export const watchCommand = watchStoreCommand.pipe(
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
      "skygent watch my-store --interval \"5 minutes\"",
      "skygent watch timeline --store my-store --interval \"2 minutes\""
    ])
  )
);
