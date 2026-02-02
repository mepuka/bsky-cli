/**
 * Sync engine service for orchestrating data synchronization from Bluesky to stores.
 *
 * This service provides the core synchronization logic for fetching posts from various
 * Bluesky sources (timeline, feeds, lists, etc.), filtering them, and persisting them
 * to a store. It supports both one-time sync operations and continuous watch mode.
 *
 * ## Features
 *
 * - **Multiple data sources**: Timeline, custom feeds, lists, notifications, author feeds, threads, Jetstream
 * - **Filter-based storage**: Only matching posts are stored based on filter expressions
 * - **Deduplication**: Configurable upsert policies (dedupe vs refresh)
 * - **Incremental sync**: Resumable sync with checkpoint support
 * - **Watch mode**: Continuous streaming sync with progress tracking
 * - **Error handling**: Comprehensive error tracking and reporting
 *
 * ## Architecture
 *
 * The sync process follows these stages:
 * 1. **Fetch**: Retrieve posts from the configured data source
 * 2. **Parse**: Convert raw Bluesky posts to normalized Post objects
 * 3. **Filter**: Evaluate posts against the filter expression
 * 4. **Store**: Persist matching posts to the store's event log
 * 5. **Checkpoint**: Save progress for resumable sync
 *
 * ## Dependencies
 *
 * - `BskyClient`: For API access
 * - `PostParser`: For post normalization
 * - `FilterRuntime`: For filter evaluation
 * - `StoreCommitter`: For event persistence
 * - `SyncCheckpointStore`: For progress tracking
 * - `SyncReporter`: For progress reporting
 * - `SyncSettings`: For configuration
 *
 * @example
 * ```ts
 * import { Effect } from "effect";
 * import { SyncEngine } from "./services/sync-engine.js";
 * import { DataSource } from "./domain/sync.js";
 * import { StoreRef } from "./domain/store.js";
 * import { hashtag } from "./domain/filter.js";
 *
 * const program = Effect.gen(function* () {
 *   const engine = yield* SyncEngine;
 *
 *   // Sync a feed to a store
 *   const result = yield* engine.sync(
 *     DataSource.Feed({ uri: "at://did:plc:abc/app.bsky.feed.generator/tech" }),
 *     StoreRef.make({ name: "tech-posts", root: "/path/to/.skygent" }),
 *     hashtag("javascript"),
 *     { policy: "dedupe" }
 *   );
 *
 *   console.log(`Synced ${result.stored} posts`);
 * });
 * ```
 *
 * @module services/sync-engine
 */

import { Chunk, Clock, Context, Duration, Effect, Fiber, Layer, Match, Option, Predicate, Ref, Schedule, Schema, Stream } from "effect";
import { messageFromCause } from "./shared.js";
import type { BskyError } from "../domain/errors.js";
import { FilterRuntime } from "./filter-runtime.js";
import { PostParser } from "./post-parser.js";
import { StoreCommitter } from "./store-commit.js";
import { BskyClient } from "./bsky-client.js";
import type { FilterExpr } from "../domain/filter.js";
import { filterExprSignature } from "../domain/filter.js";
import { EventMeta, PostUpsert } from "../domain/events.js";
import type { EventLogEntry } from "../domain/events.js";
import type { Post } from "../domain/post.js";
import { EventSeq, Timestamp } from "../domain/primitives.js";
import type { RawPost } from "../domain/raw.js";
import type { StoreRef, SyncUpsertPolicy } from "../domain/store.js";
import {
  DataSource,
  SyncCheckpoint,
  SyncError,
  SyncEvent,
  SyncProgress,
  SyncResult,
  SyncResultMonoid,
  SyncStage,
  WatchConfig
} from "../domain/sync.js";
import { SyncCheckpointStore } from "./sync-checkpoint-store.js";
import { SyncReporter } from "./sync-reporter.js";
import { SyncSettings } from "./sync-settings.js";

type PreparedOutcome =
  | { readonly _tag: "Store"; readonly post: Post; readonly pageCursor?: string }
  | { readonly _tag: "Skip"; readonly pageCursor?: string }
  | { readonly _tag: "Error"; readonly error: SyncError; readonly pageCursor?: string };


type SyncOutcome =
  | { readonly _tag: "Stored"; readonly eventSeq: EventSeq }
  | { readonly _tag: "Skipped" }
  | { readonly _tag: "Error"; readonly error: SyncError };

const skippedOutcome: SyncOutcome = { _tag: "Skipped" };

type SourceLabel =
  | "timeline"
  | "feed"
  | "list"
  | "notifications"
  | "author"
  | "thread"
  | "jetstream";

const toSyncError =
  (stage: SyncStage, fallback: string) => (cause: unknown) =>
    cause instanceof SyncError
      ? cause
      : SyncError.make({
          stage,
          message: messageFromCause(fallback, cause),
          cause
        });

const sourceLabel = (source: DataSource): SourceLabel => {
  return Match.type<DataSource>().pipe(
    Match.withReturnType<SourceLabel>(),
    Match.tagsExhaustive({
      Timeline: () => "timeline",
      Feed: () => "feed",
      List: () => "list",
      Notifications: () => "notifications",
      Author: () => "author",
      Thread: () => "thread",
      Jetstream: () => "jetstream"
    })
  )(source);
};

const commandForSource = (source: DataSource) => {
  return Match.type<DataSource>().pipe(
    Match.tagsExhaustive({
      Timeline: () => "sync timeline",
      Feed: (feed) => `sync feed ${feed.uri}`,
      List: (list) => `sync list ${list.uri}`,
      Notifications: () => "sync notifications",
      Author: (author) => `sync author ${author.actor}`,
      Thread: (thread) => `sync thread ${thread.uri}`,
      Jetstream: () => "sync jetstream"
    })
  )(source);
};

export class SyncEngine extends Context.Tag("@skygent/SyncEngine")<
  SyncEngine,
  {
    readonly stream: (
      source: DataSource,
      target: StoreRef,
      filter: FilterExpr,
      options?: {
        readonly policy?: SyncUpsertPolicy;
        readonly limit?: number;
        readonly concurrency?: number;
      }
    ) => Stream.Stream<SyncResult, SyncError>;
    readonly sync: (
      source: DataSource,
      target: StoreRef,
      filter: FilterExpr,
      options?: { readonly policy?: SyncUpsertPolicy; readonly limit?: number }
    ) => Effect.Effect<SyncResult, SyncError>;
    readonly watch: (config: WatchConfig) => Stream.Stream<SyncEvent, SyncError>;
  }
>() {
  static readonly layer = Layer.effect(
    SyncEngine,
    Effect.gen(function* () {
      const client = yield* BskyClient;
      const parser = yield* PostParser;
      const runtime = yield* FilterRuntime;
      const committer = yield* StoreCommitter;
      const checkpoints = yield* SyncCheckpointStore;
      const reporter = yield* SyncReporter;
      const settings = yield* SyncSettings;

      const stream = (
        source: DataSource,
        target: StoreRef,
        filter: FilterExpr,
        options?: {
          readonly policy?: SyncUpsertPolicy;
          readonly limit?: number;
          readonly concurrency?: number;
        }
      ): Stream.Stream<SyncResult, SyncError> =>
        Stream.unwrapScoped(
          Effect.gen(function* () {
              const predicate = yield* runtime
                .evaluateWithMetadata(filter)
                .pipe(
                  Effect.mapError(
                    toSyncError("filter", "Filter compilation failed")
                  )
                );

              const filterHash = filterExprSignature(filter);
              const policy = options?.policy ?? "dedupe";

              const makeMeta = () =>
                Clock.currentTimeMillis.pipe(
                  Effect.flatMap((now) => Schema.decodeUnknown(Timestamp)(new Date(now).toISOString())),
                  Effect.mapError(
                    toSyncError("store", "Failed to create event metadata")
                  ),
                  Effect.map((createdAt) =>
                    EventMeta.make({
                      source: sourceLabel(source),
                      command: commandForSource(source),
                      filterExprHash: filterHash,
                      createdAt
                    })
                  )
                );

              const buildUpsert = (post: Post) =>
                makeMeta().pipe(
                  Effect.map((meta) => PostUpsert.make({ post, meta }))
                );

              const prepareRaw = (raw: RawPost): Effect.Effect<PreparedOutcome, SyncError> =>
                parser.parsePost(raw).pipe(
                  Effect.mapError(toSyncError("parse", "Failed to parse post")),
                  Effect.flatMap((post) =>
                    predicate(post).pipe(
                      Effect.mapError(
                        toSyncError("filter", "Filter evaluation failed")
                      ),
                      Effect.map(({ ok }) =>
                        ok
                          ? ({ _tag: "Store", post, ...(raw._pageCursor !== undefined ? { pageCursor: raw._pageCursor } : {}) } as const)
                          : ({ _tag: "Skip", ...(raw._pageCursor !== undefined ? { pageCursor: raw._pageCursor } : {}) } as const)
                      )
                    )
                  ),
                  Effect.catchAll((error) =>
                    Effect.succeed({ _tag: "Error", error, ...(raw._pageCursor !== undefined ? { pageCursor: raw._pageCursor } : {}) } as const)
                  )
                );

              const commitStoreEvents = (events: ReadonlyArray<PostUpsert>) => {
                if (events.length === 0) {
                  return Effect.succeed(
                    [] as ReadonlyArray<Option.Option<EventLogEntry>>
                  );
                }
                const commit = policy === "refresh"
                  ? committer
                      .appendUpserts(target, events)
                      .pipe(Effect.map((entries) => entries.map(Option.some)))
                  : committer.appendUpsertsIfMissing(target, events);
                return commit.pipe(
                  Effect.mapError(
                    toSyncError("store", "Failed to append events")
                  )
                );
              };

              const applyPreparedBatch = (
                preparedBatch: ReadonlyArray<PreparedOutcome>
              ): Effect.Effect<ReadonlyArray<SyncOutcome>, SyncError> =>
                Effect.gen(function* () {
                  const storeItems = preparedBatch.filter(
                    (item): item is Extract<PreparedOutcome, { _tag: "Store" }> =>
                      Predicate.isTagged(item, "Store")
                  );
                  const events = yield* Effect.forEach(storeItems, (item) =>
                    buildUpsert(item.post)
                  );
                  const storedEntries = yield* commitStoreEvents(events);
                  let storeIndex = 0;
                  return preparedBatch.map((prepared) =>
                    Match.type<PreparedOutcome>().pipe(
                      Match.tagsExhaustive({
                        Skip: () => skippedOutcome,
                        Error: (error) => ({ _tag: "Error", error: error.error } as const),
                        Store: () => {
                          const entry = storedEntries[storeIndex++] ?? Option.none();
                          return Option.match(entry, {
                            onNone: () => skippedOutcome,
                            onSome: (record) =>
                              ({ _tag: "Stored", eventSeq: record.seq } as const)
                          });
                        }
                      })
                    )(prepared)
                  );
                });

              const previousCheckpoint = yield* checkpoints.load(target, source).pipe(
                Effect.mapError(toSyncError("store", "Failed to load sync checkpoint"))
              );
              const activeCheckpoint = Option.filter(previousCheckpoint, (value) =>
                value.filterHash ? value.filterHash === filterHash : true
              );
              const cursorOption = Option.flatMap(activeCheckpoint, (value) =>
                Option.fromNullable(value.cursor)
              );
              const pageLimit = settings.pageLimit;

              let rawStream = Match.type<DataSource>().pipe(
                Match.withReturnType<Stream.Stream<RawPost, BskyError | SyncError>>(),
                Match.tagsExhaustive({
                  Timeline: () =>
                    client.getTimeline(
                      Option.match(cursorOption, {
                        onNone: () => ({ limit: pageLimit }),
                        onSome: (value) => ({ cursor: value, limit: pageLimit })
                      })
                    ),
                  Feed: (feed) =>
                    client.getFeed(
                      feed.uri,
                      Option.match(cursorOption, {
                        onNone: () => ({ limit: pageLimit }),
                        onSome: (value) => ({ cursor: value, limit: pageLimit })
                      })
                    ),
                  List: (list) =>
                    client.getListFeed(
                      list.uri,
                      Option.match(cursorOption, {
                        onNone: () => ({ limit: pageLimit }),
                        onSome: (value) => ({ cursor: value, limit: pageLimit })
                      })
                    ),
                  Notifications: () =>
                    client.getNotifications(
                      Option.match(cursorOption, {
                        onNone: () => ({ limit: pageLimit }),
                        onSome: (value) => ({ cursor: value, limit: pageLimit })
                      })
                    ),
                  Author: (author) => {
                    const authorOptions = {
                      limit: pageLimit,
                      ...(author.filter !== undefined
                        ? { filter: author.filter }
                        : {}),
                      ...(author.includePins !== undefined
                        ? { includePins: author.includePins }
                        : {})
                    };
                    return client.getAuthorFeed(
                      author.actor,
                      Option.match(cursorOption, {
                        onNone: () => authorOptions,
                        onSome: (value) => ({
                          ...authorOptions,
                          cursor: value
                        })
                      })
                    );
                  },
                  Thread: (thread) =>
                    Stream.unwrap(
                      client
                        .getPostThread(thread.uri, {
                          ...(thread.depth !== undefined
                            ? { depth: thread.depth }
                            : {}),
                          ...(thread.parentHeight !== undefined
                            ? { parentHeight: thread.parentHeight }
                            : {})
                        })
                        .pipe(Effect.map((posts) => Stream.fromIterable(posts)))
                    ),
                  Jetstream: () =>
                    Stream.fail(
                      SyncError.make({
                        stage: "source",
                        message: "Jetstream sources require the jetstream sync engine."
                      })
                    )
                })
              )(source);
              if (options?.limit !== undefined) {
                rawStream = rawStream.pipe(Stream.take(options.limit));
              }

              type SyncState = {
                readonly lastEventSeq: Option.Option<EventSeq>;
                readonly latestCursor: Option.Option<string>;
                readonly processed: number;
                readonly stored: number;
                readonly skipped: number;
                readonly errors: number;
                readonly lastReportAt: number;
                readonly lastCheckpointAt: number;
              };

              const resolveLastEventSeq = (candidate: Option.Option<EventSeq>) =>
                Option.match(candidate, {
                  onNone: () =>
                    Option.flatMap(activeCheckpoint, (value) =>
                      Option.fromNullable(value.lastEventSeq)
                    ),
                  onSome: Option.some
                });

              const saveCheckpoint = (state: SyncState, now: number) => {
                const lastEventSeq = resolveLastEventSeq(state.lastEventSeq);
                const shouldSave =
                  Option.isSome(lastEventSeq) ||
                  Option.isSome(state.latestCursor) ||
                  Option.isSome(activeCheckpoint);
                if (!shouldSave) {
                  return Effect.void;
                }
                return Schema.decodeUnknown(Timestamp)(new Date(now).toISOString()).pipe(
                  Effect.mapError(
                    toSyncError("store", "Failed to create checkpoint timestamp")
                  ),
                  Effect.flatMap((updatedAt) => {
                    const effectiveCursor = Option.orElse(state.latestCursor, () => cursorOption);
                    const checkpoint = SyncCheckpoint.make({
                      source,
                      cursor: Option.getOrUndefined(effectiveCursor),
                      lastEventSeq: Option.getOrUndefined(lastEventSeq),
                      filterHash,
                      updatedAt
                    });
                    return checkpoints
                      .save(target, checkpoint)
                      .pipe(
                        Effect.mapError(
                          toSyncError("store", "Failed to save checkpoint")
                        )
                      );
                  })
                );
              };

              const startTime = yield* Clock.currentTimeMillis;
              const progressIntervalMs = 5000;
              const initialState: SyncState = {
                lastEventSeq: Option.none<EventSeq>(),
                latestCursor: Option.none<string>(),
                processed: 0,
                stored: 0,
                skipped: 0,
                errors: 0,
                lastReportAt: startTime,
                lastCheckpointAt: startTime
              };
              const stateRef = yield* Ref.make(initialState);
              const heartbeat = Effect.gen(function* () {
                while (true) {
                  yield* Effect.sleep(Duration.millis(progressIntervalMs));
                  const now = yield* Clock.currentTimeMillis;
                  const state = yield* Ref.get(stateRef);
                  if (now - state.lastReportAt < progressIntervalMs) {
                    continue;
                  }
                  const elapsedMs = now - startTime;
                  const rate = elapsedMs > 0 ? state.processed / (elapsedMs / 1000) : 0;
                  yield* reporter.report(
                    SyncProgress.make({
                      processed: state.processed,
                      stored: state.stored,
                      skipped: state.skipped,
                      errors: state.errors,
                      elapsedMs,
                      rate
                    })
                  );
                  yield* Ref.update(stateRef, (current) => ({
                    ...current,
                    lastReportAt: now
                  }));
                }
              });
              const heartbeatFiber = yield* Effect.fork(heartbeat);
              yield* Effect.addFinalizer(() =>
                Fiber.interrupt(heartbeatFiber).pipe(
                  Effect.zipRight(
                    Ref.get(stateRef).pipe(
                      Effect.flatMap((state) =>
                        Clock.currentTimeMillis.pipe(
                          Effect.flatMap((now) => saveCheckpoint(state, now))
                        )
                      ),
                      Effect.catchAll(() => Effect.void)
                    )
                  )
                )
              );

              const processBatch = (preparedChunk: Chunk.Chunk<PreparedOutcome>) =>
                Effect.gen(function* () {
                  const state = yield* Ref.get(stateRef);
                  const preparedBatch = Chunk.toReadonlyArray(preparedChunk);
                  const outcomes = yield* applyPreparedBatch(preparedBatch);
                  let storedDelta = 0;
                  let skippedDelta = 0;
                  let errorDelta = 0;
                  let lastStoredSeq = Option.none<EventSeq>();
                  const errorList: Array<SyncError> = [];
                  for (const outcome of outcomes) {
                    Match.type<SyncOutcome>().pipe(
                      Match.withReturnType<void>(),
                      Match.tagsExhaustive({
                        Stored: (stored) => {
                          storedDelta += 1;
                          lastStoredSeq = Option.some(stored.eventSeq);
                        },
                        Skipped: () => {
                          skippedDelta += 1;
                        },
                        Error: (error) => {
                          skippedDelta += 1;
                          errorDelta += 1;
                          errorList.push(error.error);
                        }
                      })
                    )(outcome);
                  }
                  const delta = SyncResult.make({
                    postsAdded: storedDelta,
                    postsDeleted: 0,
                    postsSkipped: skippedDelta,
                    errors: errorList
                  });

                  const processed = state.processed + preparedBatch.length;
                  const stored = state.stored + storedDelta;
                  const skipped = state.skipped + skippedDelta;
                  const errors = state.errors + errorDelta;
                  const now = yield* Clock.currentTimeMillis;
                  const shouldReport =
                    processed % 100 === 0 || now - state.lastReportAt >= progressIntervalMs;
                  if (shouldReport) {
                    const elapsedMs = now - startTime;
                    const rate =
                      elapsedMs > 0 ? processed / (elapsedMs / 1000) : 0;
                    yield* reporter.report(
                      SyncProgress.make({
                        processed,
                        stored,
                        skipped,
                        errors,
                        elapsedMs,
                        rate
                      })
                    );
                  }

                  const nextCursor = preparedBatch.reduce(
                    (cursor, prepared) =>
                      prepared.pageCursor
                        ? Option.some(prepared.pageCursor)
                        : cursor,
                    state.latestCursor
                  );
                  const nextLastEventSeq =
                    Option.isSome(lastStoredSeq)
                      ? lastStoredSeq
                      : state.lastEventSeq;

                  const nextState: SyncState = {
                    lastEventSeq: nextLastEventSeq,
                    latestCursor: nextCursor,
                    processed,
                    stored,
                    skipped,
                    errors,
                    lastReportAt: shouldReport ? now : state.lastReportAt,
                    lastCheckpointAt: state.lastCheckpointAt
                  };

                  const shouldCheckpoint =
                    processed > 0 &&
                    (processed % settings.checkpointEvery === 0 ||
                      (settings.checkpointIntervalMs > 0 &&
                        now - state.lastCheckpointAt >=
                          settings.checkpointIntervalMs));
                  if (shouldCheckpoint) {
                    yield* saveCheckpoint(nextState, now);
                    const updated = { ...nextState, lastCheckpointAt: now };
                    yield* Ref.set(stateRef, updated);
                  } else {
                    yield* Ref.set(stateRef, nextState);
                  }

                  return delta;
                });

              const parseConcurrency = options?.concurrency ?? settings.concurrency;
              return rawStream.pipe(
                Stream.mapError(toSyncError("source", "Source stream failed")),
                Stream.mapEffect(prepareRaw, {
                  concurrency: parseConcurrency,
                  unordered: false
                }),
                Stream.grouped(settings.batchSize),
                Stream.mapEffect(processBatch)
              );
            })
        );

      const sync = Effect.fn("SyncEngine.sync")(
        (
          source: DataSource,
          target: StoreRef,
          filter: FilterExpr,
          options?: { readonly policy?: SyncUpsertPolicy; readonly limit?: number }
        ) =>
          stream(source, target, filter, options).pipe(
            Stream.runFold(SyncResultMonoid.empty, (acc, delta) =>
              SyncResultMonoid.combine(acc, delta)
            ),
            Effect.withRequestBatching(true)
          )
      );

      const watch = (config: WatchConfig) => {
        const interval = config.interval ?? Duration.seconds(30);
        const syncOptions = config.policy ? { policy: config.policy } : undefined;
        return Stream.repeatEffectWithSchedule(
          stream(config.source, config.store, config.filter, syncOptions).pipe(
            Stream.runFold(SyncResultMonoid.empty, (acc, delta) =>
              SyncResultMonoid.combine(acc, delta)
            ),
            Effect.withRequestBatching(true)
          ),
          Schedule.spaced(interval)
        ).pipe(Stream.map((result) => SyncEvent.make({ result })));
      };

      return SyncEngine.of({ stream, sync, watch });
    })
  );
}
