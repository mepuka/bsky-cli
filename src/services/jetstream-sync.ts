import {
  Chunk,
  Clock,
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Ref,
  Schema,
  Stream
} from "effect";
import { Jetstream, JetstreamMessage } from "effect-jetstream";
import { messageFromCause } from "./shared.js";
import { FilterRuntime } from "./filter-runtime.js";
import { PostParser } from "./post-parser.js";
import { StoreCommitter } from "./store-commit.js";
import { SyncCheckpointStore } from "./sync-checkpoint-store.js";
import { SyncReporter } from "./sync-reporter.js";
import { ProfileResolver } from "./profile-resolver.js";
import { EventMeta, PostDelete, PostUpsert } from "../domain/events.js";
import type { FilterExpr } from "../domain/filter.js";
import { filterExprSignature } from "../domain/filter.js";
import type { Post } from "../domain/post.js";
import { EventId, PostCid, PostUri, Timestamp } from "../domain/primitives.js";
import type { StoreRef } from "../domain/store.js";
import {
  DataSource,
  SyncCheckpoint,
  SyncError,
  SyncEvent,
  SyncProgress,
  SyncResult,
  SyncResultMonoid,
  SyncStage
} from "../domain/sync.js";

type CommitMessage =
  | JetstreamMessage.CommitCreate
  | JetstreamMessage.CommitUpdate
  | JetstreamMessage.CommitDelete;

export type JetstreamSyncConfig = {
  readonly source: Extract<DataSource, { _tag: "Jetstream" }>;
  readonly store: StoreRef;
  readonly filter: FilterExpr;
  readonly command: string;
  readonly limit?: number;
  readonly duration?: Duration.Duration;
  readonly cursor?: string;
  readonly strict?: boolean;
  readonly maxErrors?: number;
};

type SyncOutcome =
  | { readonly _tag: "Stored"; readonly eventId: EventId }
  | { readonly _tag: "Skipped" }
  | { readonly _tag: "Error"; readonly error: SyncError };

type PreparedOutcome =
  | {
      readonly _tag: "Upsert";
      readonly post: Post;
      readonly checkExists: boolean;
    }
  | { readonly _tag: "Delete"; readonly uri: PostUri; readonly cid: PostCid | undefined }
  | { readonly _tag: "Skip" }
  | { readonly _tag: "Error"; readonly error: SyncError };

type SyncProgressState = {
  readonly processed: number;
  readonly stored: number;
  readonly skipped: number;
  readonly errors: number;
  readonly lastReportAt: number;
  readonly lastEventId: Option.Option<EventId>;
  readonly lastCursor: Option.Option<string>;
};

const skippedOutcome: SyncOutcome = { _tag: "Skipped" };


const toSyncError =
  (stage: SyncStage, fallback: string) => (cause: unknown) =>
    SyncError.make({
      stage,
      message: messageFromCause(fallback, cause),
      cause
    });

const isCommitMessage = (
  message: JetstreamMessage.JetstreamMessage
): message is CommitMessage =>
  message._tag === "CommitCreate" ||
  message._tag === "CommitUpdate" ||
  message._tag === "CommitDelete";

const isPostCommit = (message: CommitMessage) =>
  message.commit.collection === "app.bsky.feed.post";

const postUriFor = (message: CommitMessage) =>
  `at://${message.did}/${message.commit.collection}/${message.commit.rkey}`;

const indexedAtFor = (message: CommitMessage) =>
  new Date(Math.floor(message.time_us / 1000)).toISOString();

export class JetstreamSyncEngine extends Context.Tag("@skygent/JetstreamSyncEngine")<
  JetstreamSyncEngine,
  {
    readonly sync: (config: JetstreamSyncConfig) => Effect.Effect<SyncResult, SyncError>;
    readonly watch: (
      config: Omit<JetstreamSyncConfig, "limit" | "duration">
    ) => Stream.Stream<SyncEvent, SyncError>;
  }
>() {
  static readonly layer = Layer.effect(
    JetstreamSyncEngine,
    Effect.gen(function* () {
      const jetstream = yield* Jetstream.Jetstream;
      const parser = yield* PostParser;
      const runtime = yield* FilterRuntime;
      const committer = yield* StoreCommitter;
      const checkpoints = yield* SyncCheckpointStore;
      const reporter = yield* SyncReporter;
      const profiles = yield* ProfileResolver;
      const safeShutdown = jetstream.shutdown.pipe(
        Effect.timeout(Duration.seconds(5)),
        Effect.catchAll(() => Effect.void)
      );

      const makeMeta = (
        command: string,
        filterHash: string
      ) =>
        Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) => Schema.decodeUnknown(Timestamp)(new Date(now).toISOString())),
          Effect.mapError(toSyncError("store", "Failed to create event metadata")),
          Effect.map((createdAt) =>
            EventMeta.make({
              source: "jetstream",
              command,
              filterExprHash: filterHash,
              createdAt
            })
          )
        );

      const storePost = (
        target: StoreRef,
        command: string,
        filterHash: string,
        post: Post
      ) =>
        Effect.gen(function* () {
          const meta = yield* makeMeta(command, filterHash);
          const event = PostUpsert.make({ post, meta });
          return yield* committer
            .appendUpsert(target, event)
            .pipe(
              Effect.mapError(
                toSyncError("store", "Failed to append event")
              ),
              Effect.map((record) => record.id)
            );
        });

      const storePostIfMissing = (
        target: StoreRef,
        command: string,
        filterHash: string,
        post: Post
      ) =>
        Effect.gen(function* () {
          const meta = yield* makeMeta(command, filterHash);
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

      const storeDelete = (
        target: StoreRef,
        command: string,
        filterHash: string,
        uri: PostUri,
        cid: PostCid | undefined
      ) =>
        Effect.gen(function* () {
          const meta = yield* makeMeta(command, filterHash);
          const event = PostDelete.make({ uri, cid, meta });
          return yield* committer
            .appendDelete(target, event)
            .pipe(
              Effect.mapError(
                toSyncError("store", "Failed to append event")
              ),
              Effect.map((record) => record.id)
            );
        });

      const processStream = Effect.fn("JetstreamSyncEngine.processStream")(
        (
          config: JetstreamSyncConfig,
          predicate: (post: Post) => Effect.Effect<
            { readonly ok: boolean },
            unknown
          >,
          activeCheckpoint: Option.Option<SyncCheckpoint>
        ) =>
          Effect.gen(function* () {
            const filterHash = filterExprSignature(config.filter);
            const startTime = yield* Clock.currentTimeMillis;
            const strict = config.strict === true;
            const maxErrors = config.maxErrors;
            const initialLastEventId = Option.flatMap(activeCheckpoint, (value) =>
              Option.fromNullable(value.lastEventId)
            );
            const initialCursor = Option.orElse(
              Option.fromNullable(config.cursor),
              () => Option.flatMap(activeCheckpoint, (value) =>
                Option.fromNullable(value.cursor)
              )
            );
            const stateRef = yield* Ref.make<SyncProgressState>({
              processed: 0,
              stored: 0,
              skipped: 0,
              errors: 0,
              lastReportAt: startTime,
              lastEventId: initialLastEventId,
              lastCursor: initialCursor
            });

            const saveCheckpointFromState = (state: SyncProgressState) => {
              const cursorValue = Option.getOrUndefined(state.lastCursor);
              const shouldSave =
                cursorValue !== undefined || Option.isSome(activeCheckpoint);
              if (!shouldSave) {
                return Effect.void;
              }
              return Clock.currentTimeMillis.pipe(
                Effect.flatMap((now) => Schema.decodeUnknown(Timestamp)(new Date(now).toISOString())),
                Effect.mapError(
                  toSyncError("store", "Failed to create checkpoint timestamp")
                ),
                Effect.flatMap((updatedAt) => {
                  const checkpoint = SyncCheckpoint.make({
                    source: config.source,
                    cursor: cursorValue,
                    lastEventId: Option.getOrUndefined(state.lastEventId),
                    filterHash,
                    updatedAt
                  });
                  return checkpoints
                    .save(config.store, checkpoint)
                    .pipe(
                      Effect.mapError(
                        toSyncError("store", "Failed to save checkpoint")
                      )
                    );
                })
              );
            };

            const baseStream = jetstream.stream.pipe(
              Stream.mapError(toSyncError("source", "Jetstream stream failed")),
              Stream.filter(isCommitMessage),
              Stream.filter(isPostCommit)
            );

            const bounded = typeof config.limit === "number"
              ? baseStream.pipe(Stream.take(config.limit))
              : baseStream;

            const prepareCommit = (
              message: CommitMessage
            ): Effect.Effect<PreparedOutcome, SyncError> =>
              Effect.gen(function* () {
                const uri = postUriFor(message);
                switch (message._tag) {
                  case "CommitCreate":
                  case "CommitUpdate": {
                    const handle = yield* profiles
                      .handleForDid(message.did)
                      .pipe(
                        Effect.mapError(
                          toSyncError("source", "Failed to resolve author profile")
                        )
                      );
                    const raw = {
                      uri,
                      cid: message.commit.cid,
                      author: handle,
                      authorDid: message.did,
                      record: message.commit.record,
                      indexedAt: indexedAtFor(message)
                    };
                    const post = yield* parser
                      .parsePost(raw)
                      .pipe(
                        Effect.mapError(
                          toSyncError("parse", "Failed to parse post")
                        )
                      );
                    const evaluated = yield* predicate(post).pipe(
                      Effect.mapError(
                        toSyncError("filter", "Filter evaluation failed")
                      )
                    );
                    return evaluated.ok
                      ? ({
                          _tag: "Upsert",
                          post,
                          checkExists: message._tag === "CommitCreate"
                        } as const)
                      : ({ _tag: "Skip" } as const);
                  }
                  case "CommitDelete": {
                    const parsedUri = yield* Schema.decodeUnknown(PostUri)(uri).pipe(
                      Effect.mapError(toSyncError("parse", "Invalid post uri"))
                    );
                    const parsedCid =
                      "cid" in message.commit &&
                      typeof message.commit.cid === "string"
                        ? yield* Schema.decodeUnknown(PostCid)(message.commit.cid).pipe(
                            Effect.mapError(
                              toSyncError("parse", "Invalid post cid")
                            )
                          )
                        : undefined;
                    return {
                      _tag: "Delete",
                      uri: parsedUri,
                      cid: parsedCid
                    } as const;
                  }
                }
              }).pipe(
                Effect.catchAll((error) =>
                  Effect.succeed({ _tag: "Error", error } as const)
                )
              );

            const applyPrepared = (prepared: PreparedOutcome) => {
              switch (prepared._tag) {
                case "Skip":
                  return Effect.succeed(skippedOutcome);
                case "Error":
                  return strict
                    ? Effect.fail(prepared.error)
                    : Effect.succeed({ _tag: "Error", error: prepared.error } as const);
                case "Delete":
                  return storeDelete(
                    config.store,
                    config.command,
                    filterHash,
                    prepared.uri,
                    prepared.cid
                  ).pipe(
                    Effect.map(
                      (eventId): SyncOutcome => ({ _tag: "Stored", eventId })
                    )
                  );
                case "Upsert":
                  return (prepared.checkExists
                    ? storePostIfMissing(
                        config.store,
                        config.command,
                        filterHash,
                        prepared.post
                      ).pipe(
                        Effect.map((eventId) =>
                          Option.match(eventId, {
                            onNone: () => skippedOutcome,
                            onSome: (value): SyncOutcome => ({
                              _tag: "Stored",
                              eventId: value
                            })
                          })
                        )
                      )
                    : storePost(
                        config.store,
                        config.command,
                        filterHash,
                        prepared.post
                      ).pipe(
                        Effect.map(
                          (eventId): SyncOutcome => ({
                            _tag: "Stored",
                            eventId
                          })
                        )
                      )
                  );
              }
            };

            const processBatch = (batch: Chunk.Chunk<CommitMessage>) =>
              Effect.gen(function* () {
                const messages = Chunk.toReadonlyArray(batch);
                if (messages.length === 0) {
                  return SyncResultMonoid.empty;
                }

                const prepared = yield* Effect.forEach(messages, prepareCommit, {
                  concurrency: "unbounded",
                  batching: true
                }).pipe(Effect.withRequestBatching(true));

                const outcomes = yield* Effect.forEach(prepared, applyPrepared);

                let added = 0;
                let skipped = 0;
                const errors: Array<SyncError> = [];
                let lastEventId = Option.none<EventId>();
                for (const outcome of outcomes) {
                  switch (outcome._tag) {
                    case "Stored":
                      added += 1;
                      lastEventId = Option.some(outcome.eventId);
                      break;
                    case "Skipped":
                      skipped += 1;
                      break;
                    case "Error":
                      skipped += 1;
                      errors.push(outcome.error);
                      break;
                  }
                }

                let maxCursor = 0;
                for (const message of messages) {
                  if (message.time_us > maxCursor) {
                    maxCursor = message.time_us;
                  }
                }
                const cursor = String(Math.max(0, Math.trunc(maxCursor)));
                const now = yield* Clock.currentTimeMillis;
                const update = yield* Ref.modify(
                  stateRef,
                  (state): readonly [
                    { readonly nextState: SyncProgressState; readonly shouldReport: boolean },
                    SyncProgressState
                  ] => {
                    const processed = state.processed + messages.length;
                    const stored = state.stored + added;
                    const skippedTotal = state.skipped + skipped;
                    const errorsTotal = state.errors + errors.length;
                    const shouldReport =
                      processed % 100 === 0 || now - state.lastReportAt >= 5000;
                    const nextState: SyncProgressState = {
                      processed,
                      stored,
                      skipped: skippedTotal,
                      errors: errorsTotal,
                      lastReportAt: shouldReport ? now : state.lastReportAt,
                      lastEventId: Option.isSome(lastEventId)
                        ? lastEventId
                        : state.lastEventId,
                      lastCursor: Option.some(cursor)
                    };
                    return [{ nextState, shouldReport }, nextState];
                  }
                );

                const state = update.nextState;
                const shouldReport = update.shouldReport;
                const exceedsMaxErrors =
                  typeof maxErrors === "number" && state.errors > maxErrors;
                if (exceedsMaxErrors) {
                  const lastError = errors[errors.length - 1];
                  return yield* SyncError.make({
                    stage: lastError?.stage ?? "source",
                    message: `Stopped after exceeding max errors (${maxErrors}).`,
                    cause: lastError ?? { maxErrors }
                  });
                }
                if (shouldReport) {
                  const elapsedMs = now - startTime;
                  const rate =
                    elapsedMs > 0 ? state.processed / (elapsedMs / 1000) : 0;
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
                }

                yield* saveCheckpointFromState(state);

                return SyncResult.make({
                  postsAdded: added,
                  postsSkipped: skipped,
                  errors
                });
              });

            const stream = bounded.pipe(
              Stream.groupedWithin(100, Duration.seconds(1)),
              Stream.mapEffect(processBatch)
            );

            return stream.pipe(
              Stream.ensuring(
                Ref.get(stateRef).pipe(
                  Effect.flatMap(saveCheckpointFromState),
                  Effect.catchAll(() => Effect.void)
                )
              ),
              Stream.ensuring(safeShutdown)
            );
          })
      );

      const sync = Effect.fn("JetstreamSyncEngine.sync")((config: JetstreamSyncConfig) =>
        Effect.gen(function* () {
          const predicate = yield* runtime
            .evaluateWithMetadata(config.filter)
            .pipe(
              Effect.mapError(
                toSyncError("filter", "Filter compilation failed")
              )
            );

          const filterHash = filterExprSignature(config.filter);
          const previousCheckpoint = yield* checkpoints
            .load(config.store, config.source)
            .pipe(
              Effect.mapError(toSyncError("store", "Failed to load sync checkpoint"))
            );
          const activeCheckpoint = Option.filter(previousCheckpoint, (value) =>
            value.filterHash ? value.filterHash === filterHash : true
          );

          const stream = yield* processStream(config, predicate, activeCheckpoint);
          const resultRef = yield* Ref.make(SyncResultMonoid.empty);
          const tagged = stream.pipe(
            Stream.tap((result) =>
              Ref.update(resultRef, (current) =>
                SyncResultMonoid.combine(current, result)
              )
            )
          );
          const withTimeout = config.duration
            ? tagged.pipe(
                Stream.interruptWhen(
                  Effect.sleep(config.duration).pipe(
                    Effect.zipRight(
                      Effect.logWarning(
                        "Jetstream sync exceeded duration; shutting down.",
                        { durationMs: Duration.toMillis(config.duration) }
                      )
                    ),
                    Effect.zipRight(safeShutdown)
                  )
                )
              )
            : tagged;
          yield* Stream.runDrain(withTimeout);
          return yield* Ref.get(resultRef);
        })
      );

      const watch = (config: Omit<JetstreamSyncConfig, "limit" | "duration">) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const predicate = yield* runtime
              .evaluateWithMetadata(config.filter)
              .pipe(
                Effect.mapError(
                  toSyncError("filter", "Filter compilation failed")
                )
              );

            const filterHash = filterExprSignature(config.filter);
            const previousCheckpoint = yield* checkpoints
              .load(config.store, config.source)
              .pipe(
                Effect.mapError(toSyncError("store", "Failed to load sync checkpoint"))
              );
            const activeCheckpoint = Option.filter(previousCheckpoint, (value) =>
              value.filterHash ? value.filterHash === filterHash : true
            );

            const stream = yield* processStream(
              { ...config, command: config.command },
              predicate,
              activeCheckpoint
            );
            return stream.pipe(
              Stream.map((result) => SyncEvent.make({ result }))
            );
          })
        );

      return JetstreamSyncEngine.of({ sync, watch });
    })
  );
}
