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

import { Clock, Context, Duration, Effect, Layer, Option, Ref, Schedule, Schema, Stream } from "effect";
import { messageFromCause } from "./shared.js";
import { FilterRuntime } from "./filter-runtime.js";
import { PostParser } from "./post-parser.js";
import { StoreCommitter } from "./store-commit.js";
import { BskyClient } from "./bsky-client.js";
import type { FilterExpr } from "../domain/filter.js";
import { filterExprSignature } from "../domain/filter.js";
import { EventMeta, PostUpsert } from "../domain/events.js";
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


const toSyncError =
  (stage: SyncStage, fallback: string) => (cause: unknown) =>
    SyncError.make({
      stage,
      message: messageFromCause(fallback, cause),
      cause
    });

const sourceLabel = (source: DataSource) => {
  switch (source._tag) {
    case "Timeline":
      return "timeline";
    case "Feed":
      return "feed";
    case "List":
      return "list";
    case "Notifications":
      return "notifications";
    case "Author":
      return "author";
    case "Thread":
      return "thread";
    case "Jetstream":
      return "jetstream";
  }
};

const commandForSource = (source: DataSource) => {
  switch (source._tag) {
    case "Timeline":
      return "sync timeline";
    case "Feed":
      return `sync feed ${source.uri}`;
    case "List":
      return `sync list ${source.uri}`;
    case "Notifications":
      return "sync notifications";
    case "Author":
      return `sync author ${source.actor}`;
    case "Thread":
      return `sync thread ${source.uri}`;
    case "Jetstream":
      return "sync jetstream";
  }
};

export class SyncEngine extends Context.Tag("@skygent/SyncEngine")<
  SyncEngine,
  {
    readonly sync: (
      source: DataSource,
      target: StoreRef,
      filter: FilterExpr,
      options?: { readonly policy?: SyncUpsertPolicy }
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

      const sync = Effect.fn("SyncEngine.sync")(
        (source: DataSource, target: StoreRef, filter: FilterExpr, options?: { readonly policy?: SyncUpsertPolicy }) =>
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

            const storePost = (post: Post) =>
              Effect.gen(function* () {
                const meta = yield* makeMeta();
                const event = PostUpsert.make({ post, meta });
                if (policy === "refresh") {
                  const record = yield* committer
                    .appendUpsert(target, event)
                    .pipe(
                      Effect.mapError(
                        toSyncError("store", "Failed to append event")
                      )
                    );
                  return Option.some(record.seq);
                }
                const stored = yield* committer
                  .appendUpsertIfMissing(target, event)
                  .pipe(
                    Effect.mapError(
                      toSyncError("store", "Failed to append event")
                    )
                  );
                return Option.map(stored, (entry) => entry.seq);
              });

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

            const applyPrepared = (
              prepared: PreparedOutcome
            ): Effect.Effect<SyncOutcome, SyncError> =>
              Effect.gen(function* () {
                switch (prepared._tag) {
                  case "Skip":
                    return skippedOutcome;
                  case "Error":
                    return { _tag: "Error", error: prepared.error } as const;
                  case "Store": {
                    const stored = yield* storePost(prepared.post);
                    return Option.match(stored, {
                      onNone: () => skippedOutcome,
                      onSome: (eventSeq) => ({ _tag: "Stored", eventSeq } as const)
                    });
                  }
                }
              });

            const initial = SyncResultMonoid.empty;
            const previousCheckpoint = yield* checkpoints.load(target, source).pipe(
              Effect.mapError(toSyncError("store", "Failed to load sync checkpoint"))
            );
            const activeCheckpoint = Option.filter(previousCheckpoint, (value) =>
              value.filterHash ? value.filterHash === filterHash : true
            );
            const cursorOption = Option.flatMap(activeCheckpoint, (value) =>
              Option.fromNullable(value.cursor)
            );

            const stream = (() => {
              switch (source._tag) {
                case "Timeline":
                  return client.getTimeline(
                    Option.match(cursorOption, {
                      onNone: () => undefined,
                      onSome: (value) => ({ cursor: value })
                    })
                  );
                case "Feed":
                  return client.getFeed(
                    source.uri,
                    Option.match(cursorOption, {
                      onNone: () => undefined,
                      onSome: (value) => ({ cursor: value })
                    })
                  );
                case "List":
                  return client.getListFeed(
                    source.uri,
                    Option.match(cursorOption, {
                      onNone: () => undefined,
                      onSome: (value) => ({ cursor: value })
                    })
                  );
                case "Notifications":
                  return client.getNotifications(
                    Option.match(cursorOption, {
                      onNone: () => undefined,
                      onSome: (value) => ({ cursor: value })
                    })
                  );
                case "Author":
                  const authorOptions = {
                    ...(source.filter !== undefined
                      ? { filter: source.filter }
                      : {}),
                    ...(source.includePins !== undefined
                      ? { includePins: source.includePins }
                      : {})
                  };
                  return client.getAuthorFeed(
                    source.actor,
                    Option.match(cursorOption, {
                      onNone: () => authorOptions,
                      onSome: (value) => ({
                        ...authorOptions,
                        cursor: value
                      })
                    })
                  );
                case "Thread":
                  return Stream.unwrap(
                    client
                      .getPostThread(source.uri, {
                        ...(source.depth !== undefined
                          ? { depth: source.depth }
                          : {}),
                        ...(source.parentHeight !== undefined
                          ? { parentHeight: source.parentHeight }
                          : {})
                      })
                      .pipe(Effect.map((posts) => Stream.fromIterable(posts)))
                  );
                case "Jetstream":
                  return Stream.fail(
                    SyncError.make({
                      stage: "source",
                      message: "Jetstream sources require the jetstream sync engine."
                    })
                  );
              }
            })();

            type SyncState = {
              readonly result: SyncResult;
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
            const initialState: SyncState = {
              result: initial,
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

            const state = yield* stream.pipe(
              Stream.mapError(toSyncError("source", "Source stream failed")),
              Stream.mapEffect(prepareRaw, {
                concurrency: settings.concurrency,
                unordered: false
              }),
              Stream.runFoldEffect(
                initialState,
                (state, prepared) =>
                  Effect.gen(function* () {
                    const outcome = yield* applyPrepared(prepared);
                    const delta = (() => {
                      switch (outcome._tag) {
                        case "Stored":
                          return SyncResult.make({
                            postsAdded: 1,
                            postsDeleted: 0,
                            postsSkipped: 0,
                            errors: []
                          });
                        case "Skipped":
                          return SyncResult.make({
                            postsAdded: 0,
                            postsDeleted: 0,
                            postsSkipped: 1,
                            errors: []
                          });
                        case "Error":
                          return SyncResult.make({
                            postsAdded: 0,
                            postsDeleted: 0,
                            postsSkipped: 1,
                            errors: [outcome.error]
                          });
                      }
                    })();

                    const processed = state.processed + 1;
                    const stored =
                      state.stored + (outcome._tag === "Stored" ? 1 : 0);
                    const skipped =
                      state.skipped + (outcome._tag === "Skipped" ? 1 : 0);
                    const errors =
                      state.errors + (outcome._tag === "Error" ? 1 : 0);
                    const now = yield* Clock.currentTimeMillis;
                    const shouldReport =
                      processed % 100 === 0 || now - state.lastReportAt >= 5000;
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

                    const nextCursor = prepared.pageCursor
                      ? Option.some(prepared.pageCursor)
                      : state.latestCursor;

                    const nextState: SyncState = {
                      result: SyncResultMonoid.combine(state.result, delta),
                      lastEventSeq:
                        outcome._tag === "Stored"
                          ? Option.some(outcome.eventSeq)
                          : state.lastEventSeq,
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
                      return updated;
                    }

                    yield* Ref.set(stateRef, nextState);
                    return nextState;
                  })
              ),
              Effect.withRequestBatching(true),
              Effect.ensuring(
                Ref.get(stateRef).pipe(
                  Effect.flatMap((state) =>
                    Clock.currentTimeMillis.pipe(
                      Effect.flatMap((now) => saveCheckpoint(state, now))
                    )
                  ),
                  Effect.catchAll(() => Effect.void)
                )
              )
            );

            return state.result;
          })
      );

      const watch = (config: WatchConfig) => {
        const interval = config.interval ?? Duration.seconds(30);
        const syncOptions = config.policy ? { policy: config.policy } : undefined;
        return Stream.repeatEffectWithSchedule(
          sync(config.source, config.store, config.filter, syncOptions),
          Schedule.spaced(interval)
        ).pipe(Stream.map((result) => SyncEvent.make({ result })));
      };

      return SyncEngine.of({ sync, watch });
    })
  );
}
