import {
  Chunk,
  Clock,
  Context,
  Duration,
  Effect,
  Layer,
  Match,
  Option,
  Predicate,
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
import { StoreIndex } from "./store-index.js";
import { EventMeta, PostDelete, PostUpsert } from "../domain/events.js";
import type { FilterExpr } from "../domain/filter.js";
import { filterExprSignature } from "../domain/filter.js";
import type { Post } from "../domain/post.js";
import { EventSeq, PostCid, PostUri, Timestamp } from "../domain/primitives.js";
import type { StoreRef } from "../domain/store.js";
import {
  DataSource,
  SyncCheckpoint,
  dataSourceKey,
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
  readonly dryRun?: boolean;
};

type SyncOutcome =
  | { readonly _tag: "Stored"; readonly eventSeq: EventSeq; readonly kind: "upsert" | "delete" }
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
  readonly deleted: number;
  readonly skipped: number;
  readonly errors: number;
  readonly lastReportAt: number;
  readonly lastEventSeq: Option.Option<EventSeq>;
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
  Predicate.isTagged(message, "CommitCreate") ||
  Predicate.isTagged(message, "CommitUpdate") ||
  Predicate.isTagged(message, "CommitDelete");

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
      const index = yield* StoreIndex;
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
              Effect.map((record) => record.seq)
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
          return Option.map(stored, (entry) => entry.seq);
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
              Effect.map((record) => record.seq)
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
            const dryRun = config.dryRun ?? false;
            const totalLimit = config.limit;
            const durationMs =
              config.duration !== undefined
                ? Duration.toMillis(config.duration)
                : undefined;
            const sourceKey = dataSourceKey(config.source);
            const startTime = yield* Clock.currentTimeMillis;
            const strict = config.strict === true;
            const maxErrors = config.maxErrors;
            const initialLastEventSeq = Option.flatMap(activeCheckpoint, (value) =>
              Option.fromNullable(value.lastEventSeq)
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
              deleted: 0,
              skipped: 0,
              errors: 0,
              lastReportAt: startTime,
              lastEventSeq: initialLastEventSeq,
              lastCursor: initialCursor
            });
            const seenRef = dryRun ? yield* Ref.make(new Set<string>()) : undefined;

            const estimateEtaMs = (processed: number, rate: number, elapsedMs: number) => {
              if (typeof totalLimit === "number" && rate > 0) {
                const remaining = Math.max(0, totalLimit - processed);
                if (remaining <= 0) {
                  return 0;
                }
                return Math.round((remaining / rate) * 1000);
              }
              if (typeof durationMs === "number") {
                return Math.max(0, Math.round(durationMs - elapsedMs));
              }
              return undefined;
            };

            const saveCheckpointFromState = (state: SyncProgressState) => {
              if (dryRun) {
                return Effect.void;
              }
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
                    lastEventSeq: Option.getOrUndefined(state.lastEventSeq),
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
                const prepareUpsert = (
                  commit: JetstreamMessage.CommitCreate | JetstreamMessage.CommitUpdate,
                  checkExists: boolean
                ) =>
                  Effect.gen(function* () {
                    const handle = yield* profiles
                      .handleForDid(commit.did)
                      .pipe(
                        Effect.mapError(
                          toSyncError("source", "Failed to resolve author profile")
                        )
                      );
                    const raw = {
                      uri,
                      cid: commit.commit.cid,
                      author: handle,
                      authorDid: commit.did,
                      record: commit.commit.record,
                      indexedAt: indexedAtFor(commit)
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
                          checkExists
                        } as const)
                      : ({ _tag: "Skip" } as const);
                  });

                const prepareDelete = (commit: JetstreamMessage.CommitDelete) =>
                  Effect.gen(function* () {
                    const parsedUri = yield* Schema.decodeUnknown(PostUri)(uri).pipe(
                      Effect.mapError(toSyncError("parse", "Invalid post uri"))
                    );
                    const parsedCid =
                      "cid" in commit.commit &&
                      typeof commit.commit.cid === "string"
                        ? yield* Schema.decodeUnknown(PostCid)(commit.commit.cid).pipe(
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
                  });

                return yield* Match.type<CommitMessage>().pipe(
                  Match.withReturnType<Effect.Effect<PreparedOutcome, SyncError>>(),
                  Match.tagsExhaustive({
                    CommitCreate: (commit) => prepareUpsert(commit, true),
                    CommitUpdate: (commit) => prepareUpsert(commit, false),
                    CommitDelete: (commit) => prepareDelete(commit)
                  })
                )(message);
              }).pipe(
                Effect.catchAll((error) =>
                  Effect.succeed({ _tag: "Error", error } as const)
                )
              );

            const applyPrepared = (prepared: PreparedOutcome) => {
              if (dryRun) {
                return Match.type<PreparedOutcome>().pipe(
                  Match.withReturnType<Effect.Effect<SyncOutcome, SyncError>>(),
                  Match.tagsExhaustive({
                    Skip: () => Effect.succeed(skippedOutcome),
                    Error: (error) =>
                      strict
                        ? Effect.fail(error.error)
                        : Effect.succeed({ _tag: "Error", error: error.error } as const),
                    Delete: (del) =>
                      index
                        .hasUri(config.store, del.uri)
                        .pipe(
                          Effect.mapError(
                            toSyncError("store", "Failed to check existing post")
                          ),
                          Effect.map((exists) =>
                            exists
                              ? ({
                                  _tag: "Stored",
                                  eventSeq: 0 as EventSeq,
                                  kind: "delete"
                                } as const)
                              : skippedOutcome
                          )
                        ),
                    Upsert: (upsert) =>
                      (upsert.checkExists
                        ? Effect.gen(function* () {
                            if (!seenRef) {
                              return {
                                _tag: "Stored",
                                eventSeq: 0 as EventSeq,
                                kind: "upsert"
                              } as const;
                            }
                            const seen = yield* Ref.get(seenRef);
                            const uri = upsert.post.uri;
                            if (seen.has(uri)) {
                              return skippedOutcome;
                            }
                            const exists = yield* index
                              .hasUri(config.store, uri)
                              .pipe(
                                Effect.mapError(
                                  toSyncError("store", "Failed to check existing post")
                                )
                              );
                            if (exists) {
                              return skippedOutcome;
                            }
                            const next = new Set(seen);
                            next.add(uri);
                            yield* Ref.set(seenRef, next);
                            return {
                              _tag: "Stored",
                              eventSeq: 0 as EventSeq,
                              kind: "upsert"
                            } as const;
                          })
                        : Effect.succeed({
                            _tag: "Stored",
                            eventSeq: 0 as EventSeq,
                            kind: "upsert"
                          } as const))
                  })
                )(prepared);
              }

              return Match.type<PreparedOutcome>().pipe(
                Match.withReturnType<Effect.Effect<SyncOutcome, SyncError>>(),
                Match.tagsExhaustive({
                  Skip: () => Effect.succeed(skippedOutcome),
                  Error: (error) =>
                    strict
                      ? Effect.fail(error.error)
                      : Effect.succeed({ _tag: "Error", error: error.error } as const),
                  Delete: (del) =>
                    index
                      .hasUri(config.store, del.uri)
                      .pipe(
                        Effect.mapError(
                          toSyncError("store", "Failed to check existing post")
                        ),
                        Effect.flatMap((exists) =>
                          exists
                            ? storeDelete(
                                config.store,
                                config.command,
                                filterHash,
                                del.uri,
                                del.cid
                              ).pipe(
                                Effect.map(
                                  (eventSeq): SyncOutcome => ({
                                    _tag: "Stored",
                                    eventSeq,
                                    kind: "delete"
                                  })
                                )
                              )
                            : Effect.succeed(skippedOutcome)
                        )
                      ),
                  Upsert: (upsert) =>
                    (upsert.checkExists
                      ? storePostIfMissing(
                          config.store,
                          config.command,
                          filterHash,
                          upsert.post
                        ).pipe(
                          Effect.map((eventSeq) =>
                            Option.match(eventSeq, {
                              onNone: () => skippedOutcome,
                              onSome: (value): SyncOutcome => ({
                                _tag: "Stored",
                                eventSeq: value,
                                kind: "upsert"
                              })
                            })
                          )
                        )
                      : storePost(
                          config.store,
                          config.command,
                          filterHash,
                          upsert.post
                        ).pipe(
                          Effect.map(
                            (eventSeq): SyncOutcome => ({
                              _tag: "Stored",
                              eventSeq,
                              kind: "upsert"
                            })
                          )
                        ))
                })
              )(prepared);
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
                let deleted = 0;
                let skipped = 0;
                const errors: Array<SyncError> = [];
                let lastEventSeq = Option.none<EventSeq>();
                for (const outcome of outcomes) {
                  Match.type<SyncOutcome>().pipe(
                    Match.withReturnType<void>(),
                    Match.tagsExhaustive({
                      Stored: (stored) => {
                        if (stored.kind === "delete") {
                          deleted += 1;
                        } else {
                          added += 1;
                        }
                        if (!dryRun) {
                          lastEventSeq = Option.some(stored.eventSeq);
                        }
                      },
                      Skipped: () => {
                        skipped += 1;
                      },
                      Error: (error) => {
                        skipped += 1;
                        errors.push(error.error);
                      }
                    })
                  )(outcome);
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
                    const deletedTotal = state.deleted + deleted;
                    const skippedTotal = state.skipped + skipped;
                    const errorsTotal = state.errors + errors.length;
                    const shouldReport =
                      processed % 100 === 0 || now - state.lastReportAt >= 5000;
                    const nextState: SyncProgressState = {
                      processed,
                      stored,
                      deleted: deletedTotal,
                      skipped: skippedTotal,
                      errors: errorsTotal,
                      lastReportAt: shouldReport ? now : state.lastReportAt,
                      lastEventSeq: Option.isSome(lastEventSeq)
                        ? lastEventSeq
                        : state.lastEventSeq,
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
                  const etaMs = estimateEtaMs(state.processed, rate, elapsedMs);
                  yield* reporter.report(
                    SyncProgress.make({
                      processed: state.processed,
                      stored: state.stored,
                      deleted: state.deleted,
                      skipped: state.skipped,
                      errors: state.errors,
                      elapsedMs,
                      rate,
                      ...(typeof totalLimit === "number" ? { total: totalLimit } : {}),
                      ...(etaMs !== undefined ? { etaMs } : {}),
                      store: config.store.name,
                      source: sourceKey
                    })
                  );
                }

                yield* saveCheckpointFromState(state);

                return SyncResult.make({
                  postsAdded: added,
                  postsDeleted: deleted,
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
                      reporter.warn("Jetstream sync exceeded duration; shutting down.", {
                        durationMs: Duration.toMillis(config.duration),
                        store: config.store.name
                      })
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
