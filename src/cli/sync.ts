import { Command, Options } from "@effect/cli";
import { Chunk, Effect, Layer, Option, Stream } from "effect";
import { Jetstream } from "effect-jetstream";
import { filterExprSignature } from "../domain/filter.js";
import type { FilterExpr } from "../domain/filter.js";
import { DataSource, SyncError, SyncResult, SyncResultMonoid } from "../domain/sync.js";
import { JetstreamSyncEngine } from "../services/jetstream-sync.js";
import { storeOptions } from "./store.js";
import { logInfo, logWarn, makeSyncReporter } from "./logging.js";
import { SyncReporter } from "../services/sync-reporter.js";
import { ResourceMonitor } from "../services/resource-monitor.js";
import { OutputManager } from "../services/output-manager.js";
import { StoreIndex } from "../services/store-index.js";
import { StoreSources } from "../services/store-sources.js";
import { SyncEngine } from "../services/sync-engine.js";
import { SyncSettings } from "../services/sync-settings.js";
import { BskyClient } from "../services/bsky-client.js";
import { CliOutput, writeJson } from "./output.js";
import { parseFilterExpr } from "./filter-input.js";
import { withExamples } from "./help.js";
import { buildJetstreamSelection, jetstreamOptions } from "./jetstream.js";
import { CliInputError } from "./errors.js";
import { makeSyncCommandBody, resolveCacheLimit, resolveCacheMode } from "./sync-factory.js";
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
  noCacheImagesThumbnailsOption,
  strictOption,
  maxErrorsOption
} from "./shared-options.js";
import { storeSourceId } from "../domain/store-sources.js";
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

const syncLimitOption = Options.integer("limit").pipe(
  Options.withSchema(PositiveInt),
  Options.withDescription("Maximum number of posts to sync"),
  Options.optional
);
const jetstreamLimitOption = Options.integer("limit").pipe(
  Options.withSchema(PositiveInt),
  Options.withDescription("Maximum number of Jetstream events to process"),
  Options.optional
);
const durationOption = Options.text("duration").pipe(
  Options.withSchema(DurationInput),
  Options.withDescription("Stop after a duration (e.g. \"2 minutes\")"),
  Options.optional
);
const depthOption = threadDepthOption(
  "Thread reply depth to include (0-1000, default 6)"
);
const parentHeightOption = threadParentHeightOption(
  "Thread parent height to include (0-1000, default 80)"
);

const authorsOnlyOption = Options.boolean("authors-only").pipe(
  Options.withDescription("Sync only author sources from the store registry")
);
const feedsOnlyOption = Options.boolean("feeds-only").pipe(
  Options.withDescription("Sync only feed sources from the store registry")
);
const listsOnlyOption = Options.boolean("lists-only").pipe(
  Options.withDescription("Sync only list sources from the store registry")
);


const timelineCommand = Command.make(
  "timeline",
  {
    store: storeNameOption,
    filter: filterOption,
    filterJson: filterJsonOption,
    quiet: quietOption,
    refresh: refreshOption,
    cacheImages: cacheImagesOption,
    cacheImagesMode: cacheImagesModeOption,
    cacheImagesLimit: cacheImagesLimitOption,
    noCacheImagesThumbnails: noCacheImagesThumbnailsOption,
    limit: syncLimitOption
  },
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
  {
    uri: feedUriArg,
    store: storeNameOption,
    filter: filterOption,
    filterJson: filterJsonOption,
    quiet: quietOption,
    refresh: refreshOption,
    cacheImages: cacheImagesOption,
    cacheImagesMode: cacheImagesModeOption,
    cacheImagesLimit: cacheImagesLimitOption,
    noCacheImagesThumbnails: noCacheImagesThumbnailsOption,
    limit: syncLimitOption
  },
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

const listCommand = Command.make(
  "list",
  {
    uri: listUriArg,
    store: storeNameOption,
    filter: filterOption,
    filterJson: filterJsonOption,
    quiet: quietOption,
    refresh: refreshOption,
    cacheImages: cacheImagesOption,
    cacheImagesMode: cacheImagesModeOption,
    cacheImagesLimit: cacheImagesLimitOption,
    noCacheImagesThumbnails: noCacheImagesThumbnailsOption,
    limit: syncLimitOption
  },
  ({ uri, ...rest }) => makeSyncCommandBody("list", () => DataSource.list(uri), { uri })(rest)
).pipe(
  Command.withDescription(
    withExamples(
      "Sync a list feed URI into a store",
      [
        "skygent sync list at://did:plc:example/app.bsky.graph.list/xyz --store my-store"
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
    quiet: quietOption,
    refresh: refreshOption,
    cacheImages: cacheImagesOption,
    cacheImagesMode: cacheImagesModeOption,
    cacheImagesLimit: cacheImagesLimitOption,
    noCacheImagesThumbnails: noCacheImagesThumbnailsOption,
    limit: syncLimitOption
  },
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
    quiet: quietOption,
    refresh: refreshOption,
    cacheImages: cacheImagesOption,
    cacheImagesMode: cacheImagesModeOption,
    cacheImagesLimit: cacheImagesLimitOption,
    noCacheImagesThumbnails: noCacheImagesThumbnailsOption,
    limit: syncLimitOption
  },
  ({ actor, filter, includePins, postFilter, postFilterJson, store, quiet, refresh, cacheImages, cacheImagesMode, cacheImagesLimit, noCacheImagesThumbnails, limit }) =>
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
        quiet,
        refresh,
        cacheImages,
        cacheImagesMode,
        cacheImagesLimit,
        noCacheImagesThumbnails,
        limit
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
    quiet: quietOption,
    refresh: refreshOption,
    cacheImages: cacheImagesOption,
    cacheImagesMode: cacheImagesModeOption,
    cacheImagesLimit: cacheImagesLimitOption,
    noCacheImagesThumbnails: noCacheImagesThumbnailsOption,
    limit: syncLimitOption
  },
  ({ uri, depth, parentHeight, filter, filterJson, store, quiet, refresh, cacheImages, cacheImagesMode, cacheImagesLimit, noCacheImagesThumbnails, limit }) =>
    Effect.gen(function* () {
      const { depth: depthValue, parentHeight: parentHeightValue } =
        parseThreadDepth(depth, parentHeight);
      const source = DataSource.thread(uri, {
        ...(depthValue !== undefined ? { depth: depthValue } : {}),
        ...(parentHeightValue !== undefined ? { parentHeight: parentHeightValue } : {})
      });
      const run = makeSyncCommandBody("thread", () => source, {
        uri,
        ...(depthValue !== undefined ? { depth: depthValue } : {}),
        ...(parentHeightValue !== undefined ? { parentHeight: parentHeightValue } : {})
      });
      return yield* run({
        store,
        filter,
        filterJson,
        quiet,
        refresh,
        cacheImages,
        cacheImagesMode,
        cacheImagesLimit,
        noCacheImagesThumbnails,
        limit
      });
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
    cacheImages: cacheImagesOption,
    cacheImagesMode: cacheImagesModeOption,
    cacheImagesLimit: cacheImagesLimitOption,
    noCacheImagesThumbnails: noCacheImagesThumbnailsOption,
    limit: jetstreamLimitOption,
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
    cacheImages,
    cacheImagesMode,
    cacheImagesLimit,
    noCacheImagesThumbnails,
    limit,
    duration,
    strict,
    maxErrors
  }) =>
    Effect.gen(function* () {
      const monitor = yield* ResourceMonitor;
      const output = yield* CliOutput;
      const outputManager = yield* OutputManager;
      const index = yield* StoreIndex;
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
      const parsedDuration = duration;
      if (Option.isNone(limit) && Option.isNone(parsedDuration)) {
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
        const limitValue = Option.getOrUndefined(limit);
        const durationValue = Option.getOrUndefined(parsedDuration);
        const maxErrorsValue = Option.getOrUndefined(maxErrors);
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
      const totalPosts = yield* index.count(storeRef);
      if (cacheImages) {
        const mode = resolveCacheMode(cacheImagesMode);
        const cacheLimit = resolveCacheLimit(mode, result.postsAdded, cacheImagesLimit);
        const shouldRun = mode === "full" || result.postsAdded > 0;
        if (shouldRun && cacheLimit !== 0) {
          yield* Effect.gen(function* () {
            if (mode === "full") {
              yield* logWarn("Running full image cache scan", {
                store: storeRef.name,
                source: "jetstream"
              });
            }
            yield* logInfo("Caching image embeds", {
              store: storeRef.name,
              source: "jetstream",
              postsAdded: result.postsAdded
            });
            const cacheResult = yield* cacheStoreImages(storeRef, {
              includeThumbnails: !noCacheImagesThumbnails,
              ...(cacheLimit !== undefined ? { limit: cacheLimit } : {})
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
      }
      yield* logInfo("Sync complete", { source: "jetstream", store: storeRef.name });
      yield* writeJson({ ...(result as SyncResult), totalPosts });
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

const syncStoreCommand = Command.make(
  "sync",
  {
    store: storeNameOption,
    authorsOnly: authorsOnlyOption,
    feedsOnly: feedsOnlyOption,
    listsOnly: listsOnlyOption,
    quiet: quietOption,
    refresh: refreshOption,
    cacheImages: cacheImagesOption,
    cacheImagesMode: cacheImagesModeOption,
    cacheImagesLimit: cacheImagesLimitOption,
    noCacheImagesThumbnails: noCacheImagesThumbnailsOption,
    limit: syncLimitOption
  },
  ({
    store,
    authorsOnly,
    feedsOnly,
    listsOnly,
    quiet,
    refresh,
    cacheImages,
    cacheImagesMode,
    cacheImagesLimit,
    noCacheImagesThumbnails,
    limit
  }) =>
    Effect.gen(function* () {
      const sync = yield* SyncEngine;
      const monitor = yield* ResourceMonitor;
      const output = yield* CliOutput;
      const outputManager = yield* OutputManager;
      const index = yield* StoreIndex;
      const storeSources = yield* StoreSources;
      const settings = yield* SyncSettings;

      const storeRef = yield* storeOptions.loadStoreRef(store);
      const storeConfig = yield* storeOptions.loadStoreConfig(store);
      const sources = yield* storeSources
        .list(storeRef)
        .pipe(Effect.flatMap((list) =>
          resolveStoreSources(list, { authorsOnly, feedsOnly, listsOnly })
        ));
      const basePolicy = storeConfig.syncPolicy ?? "dedupe";
      const policy = refresh ? "refresh" : basePolicy;

      yield* logInfo("Starting sync", {
        source: "store",
        store: storeRef.name,
        sources: sources.length
      });

      if (policy === "refresh") {
        yield* logWarn("Refresh mode updates existing posts and may grow the event log.", {
          source: "store",
          store: storeRef.name
        });
      }

      const reporter = makeSyncReporter(quiet, monitor, output);
      const limitValue = Option.getOrUndefined(limit);
      const combineResults = (acc: SyncResult, result: SyncResult) =>
        SyncResultMonoid.combine(acc, result);
      const runSync = (dataSource: DataSource, expr: FilterExpr, limitOverride?: number) => {
        const effectiveLimit = limitOverride ?? limitValue;
        return sync
          .stream(dataSource, storeRef, expr, {
            policy,
            ...(effectiveLimit !== undefined ? { limit: effectiveLimit } : {}),
            concurrency: 1
          })
          .pipe(
            Stream.runFold(SyncResultMonoid.empty, combineResults),
            Effect.withRequestBatching(true),
            Effect.provideService(SyncReporter, reporter)
          );
      };
      const runSource = (source: (typeof sources)[number]) => {
        const id = storeSourceId(source);
        return Effect.gen(function* () {
          const expr = yield* storeSourceFilterExpr(source, id);
          if (source._tag === "JetstreamSource") {
            if (limitValue === undefined) {
              return yield* CliInputError.make({
                message:
                  "Jetstream sources require --limit when syncing a store. Use sync jetstream for continuous streaming.",
                cause: { source: id }
              });
            }
            const filterHash = filterExprSignature(expr);
            const selection = yield* buildJetstreamSelection(
              {
                endpoint: Option.none(),
                collections: Option.none(),
                dids: Option.none(),
                cursor: Option.none(),
                compress: false,
                maxMessageSize: Option.none()
              },
              storeRef,
              filterHash
            );
            const engineLayer = JetstreamSyncEngine.layer.pipe(
              Layer.provideMerge(Jetstream.live(selection.config))
            );

            yield* logInfo("Starting sync", {
              source: id,
              type: source._tag,
              store: storeRef.name
            });

            const syncResult = yield* Effect.gen(function* () {
              const engine = yield* JetstreamSyncEngine;
              return yield* engine.sync({
                source: selection.source,
                store: storeRef,
                filter: expr,
                command: "sync jetstream",
                limit: limitValue,
                ...(selection.cursor !== undefined
                  ? { cursor: selection.cursor }
                  : {})
              });
            }).pipe(
              Effect.provide(engineLayer),
              Effect.provideService(SyncReporter, reporter)
            );

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
          }
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

            const runMemberSync = (member: (typeof members)[number], limitOverride?: number) =>
              runSync(DataSource.author(member), expr, limitOverride).pipe(
                Effect.catchAll((error) => {
                  const message = error instanceof Error ? error.message : String(error);
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
              );

            const combinedMembers =
              limitValue === undefined
                ? yield* Stream.fromIterable(members).pipe(
                    Stream.mapEffect(
                      (member) => runMemberSync(member),
                      {
                        concurrency: Math.min(settings.concurrency, members.length || 1)
                      }
                    ),
                    Stream.runFold(SyncResultMonoid.empty, combineResults)
                  )
                : yield* Effect.gen(function* () {
                    let remaining = limitValue;
                    let acc = SyncResultMonoid.empty;
                    for (const member of members) {
                      if (remaining <= 0) {
                        break;
                      }
                      const result = yield* runMemberSync(member, remaining);
                      acc = combineResults(acc, result);
                      remaining = limitValue - acc.postsAdded;
                    }
                    return acc;
                  });

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
      const sourceResults = results.map((entry) => ({
        id: entry.id,
        type: entry.type,
        result: entry.result
      }));

      const materialized = yield* outputManager.materializeStore(storeRef);
      if (materialized.filters.length > 0) {
        yield* logInfo("Materialized filter outputs", {
          store: storeRef.name,
          filters: materialized.filters.map((spec) => spec.name)
        });
      }

      const totalPosts = yield* index.count(storeRef);

      if (cacheImages) {
        const mode = resolveCacheMode(cacheImagesMode);
        const cacheLimit = resolveCacheLimit(mode, combined.postsAdded, cacheImagesLimit);
        const shouldRun = mode === "full" || combined.postsAdded > 0;
        if (shouldRun && cacheLimit !== 0) {
          yield* Effect.gen(function* () {
            if (mode === "full") {
              yield* logWarn("Running full image cache scan", {
                store: storeRef.name,
                source: "store"
              });
            }
            yield* logInfo("Caching image embeds", {
              store: storeRef.name,
              source: "store",
              postsAdded: combined.postsAdded
            });
            const cacheResult = yield* cacheStoreImages(storeRef, {
              includeThumbnails: !noCacheImagesThumbnails,
              ...(cacheLimit !== undefined ? { limit: cacheLimit } : {})
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
      }

      yield* logInfo("Sync complete", { source: "store", store: storeRef.name });

      yield* writeJson({
        store: storeRef.name,
        sources: sourceResults,
        ...(combined as SyncResult),
        totalPosts
      });
    })
);

export const syncCommand = syncStoreCommand.pipe(
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
    withExamples("Sync content into stores", [
      "skygent sync my-store",
      "skygent sync timeline --store my-store"
    ])
  )
);
