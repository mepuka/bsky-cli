import { Clock, Context, Duration, Effect, Layer, Option, Ref, Schedule, Schema, Stream } from "effect";
import { FilterRuntime } from "./filter-runtime.js";
import { PostParser } from "./post-parser.js";
import { StoreCommitter } from "./store-commit.js";
import { BskyClient } from "./bsky-client.js";
import type { FilterExpr } from "../domain/filter.js";
import { filterExprSignature } from "../domain/filter.js";
import { EventMeta, PostUpsert } from "../domain/events.js";
import type { Post } from "../domain/post.js";
import { EventId, Timestamp } from "../domain/primitives.js";
import type { RawPost } from "../domain/raw.js";
import type { StoreRef } from "../domain/store.js";
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
  | { readonly _tag: "Stored"; readonly eventId: EventId }
  | { readonly _tag: "Skipped" }
  | { readonly _tag: "Error"; readonly error: SyncError };

const skippedOutcome: SyncOutcome = { _tag: "Skipped" };

const messageFromCause = (fallback: string, cause: unknown) => {
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    const message = (cause as { readonly message?: unknown }).message;
    if (typeof message === "string" && message.length > 0) {
      return message;
    }
  }
  return fallback;
};

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
    case "Notifications":
      return "notifications";
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
    case "Notifications":
      return "sync notifications";
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
      filter: FilterExpr
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
        (source: DataSource, target: StoreRef, filter: FilterExpr) =>
          Effect.gen(function* () {
            const predicate = yield* runtime
              .evaluateWithMetadata(filter)
              .pipe(
                Effect.mapError(
                  toSyncError("filter", "Filter compilation failed")
                )
              );

            const filterHash = filterExprSignature(filter);

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
                const stored = yield* committer
                  .appendUpsertIfMissing(target, event)
                  .pipe(
                    Effect.mapError(
                      toSyncError("store", "Failed to append event")
                    )
                  );
                return Option.map(stored, (record) => record.id);
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
                      onSome: (eventId) => ({ _tag: "Stored", eventId } as const)
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
                  return client.getFeed(source.uri);
                case "Notifications":
                  return client.getNotifications();
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
              readonly lastEventId: Option.Option<EventId>;
              readonly latestCursor: Option.Option<string>;
              readonly processed: number;
              readonly stored: number;
              readonly skipped: number;
              readonly errors: number;
              readonly lastReportAt: number;
              readonly lastCheckpointAt: number;
            };

            const resolveLastEventId = (candidate: Option.Option<EventId>) =>
              Option.match(candidate, {
                onNone: () =>
                  Option.flatMap(activeCheckpoint, (value) =>
                    Option.fromNullable(value.lastEventId)
                  ),
                onSome: Option.some
              });

            const saveCheckpoint = (state: SyncState, now: number) => {
              const lastEventId = resolveLastEventId(state.lastEventId);
              const shouldSave =
                Option.isSome(lastEventId) || Option.isSome(activeCheckpoint);
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
                    lastEventId: Option.getOrUndefined(lastEventId),
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
              lastEventId: Option.none<EventId>(),
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
              Stream.mapEffect(prepareRaw, { concurrency: settings.concurrency }),
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
                            postsSkipped: 0,
                            errors: []
                          });
                        case "Skipped":
                          return SyncResult.make({
                            postsAdded: 0,
                            postsSkipped: 1,
                            errors: []
                          });
                        case "Error":
                          return SyncResult.make({
                            postsAdded: 0,
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
                      lastEventId:
                        outcome._tag === "Stored"
                          ? Option.some(outcome.eventId)
                          : state.lastEventId,
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
        return Stream.repeatEffectWithSchedule(
          sync(config.source, config.store, config.filter),
          Schedule.spaced(interval)
        ).pipe(Stream.map((result) => SyncEvent.make({ result })));
      };

      return SyncEngine.of({ sync, watch });
    })
  );
}
