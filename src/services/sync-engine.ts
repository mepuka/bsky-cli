import { Context, Duration, Effect, Layer, Option, Schedule, Schema, Stream } from "effect";
import { FilterRuntime } from "./filter-runtime.js";
import { PostParser } from "./post-parser.js";
import { StoreIndex } from "./store-index.js";
import { StoreWriter } from "./store-writer.js";
import { BskyClient } from "./bsky-client.js";
import type { FilterExpr } from "../domain/filter.js";
import { filterExprSignature } from "../domain/filter.js";
import { EventMeta, PostUpsert } from "../domain/events.js";
import type { LlmDecisionMeta } from "../domain/llm.js";
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
      const writer = yield* StoreWriter;
      const index = yield* StoreIndex;
      const checkpoints = yield* SyncCheckpointStore;
      const reporter = yield* SyncReporter;

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

            const makeMeta = (llmMeta: ReadonlyArray<LlmDecisionMeta>) =>
              Schema.decodeUnknown(Timestamp)(new Date().toISOString()).pipe(
                Effect.mapError(
                  toSyncError("store", "Failed to create event metadata")
                ),
                Effect.map((createdAt) =>
                  EventMeta.make({
                    source: sourceLabel(source),
                    command: commandForSource(source),
                    filterExprHash: filterHash,
                    model: llmMeta[0]?.modelId,
                    promptHash: llmMeta[0]?.promptHash,
                    llm: llmMeta.length > 0 ? llmMeta : undefined,
                    createdAt
                  })
                )
              );

            const storePost = (post: Post, llmMeta: ReadonlyArray<LlmDecisionMeta>) =>
              Effect.gen(function* () {
                const meta = yield* makeMeta(llmMeta);
                const event = PostUpsert.make({ post, meta });
                const record = yield* writer
                  .append(target, event)
                  .pipe(
                    Effect.mapError(
                      toSyncError("store", "Failed to append event")
                    )
                  );
                yield* index
                  .apply(target, record)
                  .pipe(
                    Effect.mapError(
                      toSyncError("store", "Failed to update index")
                    )
                  );
                return record.id;
              });

            const processRaw = (raw: RawPost): Effect.Effect<SyncOutcome, SyncError> =>
              parser.parsePost(raw).pipe(
                Effect.mapError(toSyncError("parse", "Failed to parse post")),
                Effect.flatMap((post) =>
                  index.hasUri(target, post.uri).pipe(
                    Effect.mapError(
                      toSyncError("store", "Failed to check store index")
                    ),
                    Effect.flatMap((exists) =>
                      exists
                        ? Effect.succeed(skippedOutcome)
                        : predicate(post).pipe(
                            Effect.mapError(
                              toSyncError("filter", "Filter evaluation failed")
                            ),
                            Effect.flatMap(({ ok, llm }) =>
                              ok
                                ? storePost(post, llm).pipe(
                                    Effect.map(
                                      (eventId): SyncOutcome => ({
                                        _tag: "Stored",
                                        eventId
                                      })
                                    )
                                  )
                                : Effect.succeed(skippedOutcome)
                            )
                          )
                    )
                  )
                ),
                Effect.catchAll((error) =>
                  error.stage === "store"
                    ? Effect.fail(error)
                    : Effect.succeed({ _tag: "Error", error } as const)
                )
              );

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

            const startTime = Date.now();
            const state = yield* stream.pipe(
              Stream.mapError(toSyncError("source", "Source stream failed")),
              Stream.mapEffect(processRaw),
              Stream.runFoldEffect(
                {
                  result: initial,
                  lastEventId: Option.none<EventId>(),
                  processed: 0,
                  stored: 0,
                  skipped: 0,
                  errors: 0,
                  lastReportAt: startTime
                },
                (state, outcome) =>
                  Effect.gen(function* () {
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
                  const stored = state.stored + (outcome._tag === "Stored" ? 1 : 0);
                  const skipped =
                    state.skipped + (outcome._tag === "Skipped" ? 1 : 0);
                  const errors =
                    state.errors + (outcome._tag === "Error" ? 1 : 0);
                  const now = Date.now();
                  const shouldReport =
                    processed % 100 === 0 || now - state.lastReportAt >= 5000;
                  if (shouldReport) {
                    const elapsedMs = now - startTime;
                    const rate = elapsedMs > 0 ? processed / (elapsedMs / 1000) : 0;
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

                  return {
                    result: SyncResultMonoid.combine(state.result, delta),
                    lastEventId:
                      outcome._tag === "Stored"
                        ? Option.some(outcome.eventId)
                        : state.lastEventId,
                    processed,
                    stored,
                    skipped,
                    errors,
                    lastReportAt: shouldReport ? now : state.lastReportAt
                  };
                })
              )
            );

            const lastEventId = Option.match(state.lastEventId, {
              onNone: () =>
                Option.flatMap(activeCheckpoint, (value) =>
                  Option.fromNullable(value.lastEventId)
                ),
              onSome: Option.some
            });

            const shouldSave = Option.isSome(lastEventId) || Option.isSome(activeCheckpoint);
            if (shouldSave) {
              const updatedAt = yield* Schema.decodeUnknown(Timestamp)(
                new Date().toISOString()
              ).pipe(
                Effect.mapError(
                  toSyncError("store", "Failed to create checkpoint timestamp")
                )
              );
              const checkpoint = SyncCheckpoint.make({
                source,
                cursor: Option.getOrUndefined(cursorOption),
                lastEventId: Option.getOrUndefined(lastEventId),
                filterHash,
                updatedAt
              });
              yield* checkpoints
                .save(target, checkpoint)
                .pipe(Effect.mapError(toSyncError("store", "Failed to save checkpoint")));
            }

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
