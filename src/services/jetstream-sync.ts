import { Chunk, Context, Duration, Effect, Layer, Option, Ref, Schema, Stream } from "effect";
import { Jetstream, JetstreamMessage } from "effect-jetstream";
import { FilterRuntime } from "./filter-runtime.js";
import { PostParser } from "./post-parser.js";
import { StoreIndex } from "./store-index.js";
import { StoreWriter } from "./store-writer.js";
import { SyncCheckpointStore } from "./sync-checkpoint-store.js";
import { SyncReporter } from "./sync-reporter.js";
import { ProfileResolver } from "./profile-resolver.js";
import { EventMeta, PostDelete, PostUpsert } from "../domain/events.js";
import type { FilterExpr } from "../domain/filter.js";
import { filterExprSignature } from "../domain/filter.js";
import type { LlmDecisionMeta } from "../domain/llm.js";
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
};

type SyncOutcome =
  | { readonly _tag: "Stored"; readonly eventId: EventId }
  | { readonly _tag: "Skipped" }
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
      const writer = yield* StoreWriter;
      const index = yield* StoreIndex;
      const checkpoints = yield* SyncCheckpointStore;
      const reporter = yield* SyncReporter;
      const profiles = yield* ProfileResolver;

      const makeMeta = (
        command: string,
        filterHash: string,
        llmMeta: ReadonlyArray<LlmDecisionMeta>
      ) =>
        Schema.decodeUnknown(Timestamp)(new Date().toISOString()).pipe(
          Effect.mapError(toSyncError("store", "Failed to create event metadata")),
          Effect.map((createdAt) =>
            EventMeta.make({
              source: "jetstream",
              command,
              filterExprHash: filterHash,
              model: llmMeta[0]?.modelId,
              promptHash: llmMeta[0]?.promptHash,
              llm: llmMeta.length > 0 ? llmMeta : undefined,
              createdAt
            })
          )
        );

      const storePost = (
        target: StoreRef,
        command: string,
        filterHash: string,
        post: Post,
        llmMeta: ReadonlyArray<LlmDecisionMeta>
      ) =>
        Effect.gen(function* () {
          const meta = yield* makeMeta(command, filterHash, llmMeta);
          const event = PostUpsert.make({ post, meta });
          const record = yield* writer
            .append(target, event)
            .pipe(Effect.mapError(toSyncError("store", "Failed to append event")));
          yield* index
            .apply(target, record)
            .pipe(Effect.mapError(toSyncError("store", "Failed to update index")));
          return record.id;
        });

      const storeDelete = (
        target: StoreRef,
        command: string,
        filterHash: string,
        uri: string,
        cid: string | undefined
      ) =>
        Effect.gen(function* () {
          const parsedUri = yield* Schema.decodeUnknown(PostUri)(uri).pipe(
            Effect.mapError(toSyncError("parse", "Invalid post uri"))
          );
          const parsedCid =
            typeof cid === "string"
              ? yield* Schema.decodeUnknown(PostCid)(cid).pipe(
                  Effect.mapError(toSyncError("parse", "Invalid post cid"))
                )
              : undefined;
          const meta = yield* makeMeta(command, filterHash, []);
          const event = PostDelete.make({ uri: parsedUri, cid: parsedCid, meta });
          const record = yield* writer
            .append(target, event)
            .pipe(Effect.mapError(toSyncError("store", "Failed to append event")));
          yield* index
            .apply(target, record)
            .pipe(Effect.mapError(toSyncError("store", "Failed to update index")));
          return record.id;
        });

      const processPost = (
        target: StoreRef,
        command: string,
        filterHash: string,
        predicate: (post: Post) => Effect.Effect<
          { readonly ok: boolean; readonly llm: ReadonlyArray<LlmDecisionMeta> },
          unknown
        >,
        post: Post,
        checkExists: boolean
      ): Effect.Effect<SyncOutcome, SyncError> =>
        (checkExists
          ? index.hasUri(target, post.uri).pipe(
              Effect.mapError(toSyncError("store", "Failed to check store index"))
            )
          : Effect.succeed(false)
        ).pipe(
          Effect.flatMap((exists) =>
            exists
              ? Effect.succeed(skippedOutcome)
              : predicate(post).pipe(
                  Effect.mapError(toSyncError("filter", "Filter evaluation failed")),
                  Effect.flatMap(({ ok, llm }) =>
                    ok
                      ? storePost(target, command, filterHash, post, llm).pipe(
                          Effect.map(
                            (eventId): SyncOutcome => ({ _tag: "Stored", eventId })
                          )
                        )
                      : Effect.succeed(skippedOutcome)
                  )
                )
          ),
          Effect.catchAll((error) =>
            error.stage === "store"
              ? Effect.fail(error)
              : Effect.succeed({ _tag: "Error", error } as const)
          )
        );

      const processCommit = (
        target: StoreRef,
        command: string,
        filterHash: string,
        predicate: (post: Post) => Effect.Effect<
          { readonly ok: boolean; readonly llm: ReadonlyArray<LlmDecisionMeta> },
          unknown
        >,
        message: CommitMessage
      ): Effect.Effect<SyncOutcome, SyncError> =>
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
                .pipe(Effect.mapError(toSyncError("parse", "Failed to parse post")));
              return yield* processPost(
                target,
                command,
                filterHash,
                predicate,
                post,
                message._tag === "CommitCreate"
              );
            }
            case "CommitDelete": {
              const eventId = yield* storeDelete(
                target,
                command,
                filterHash,
                uri,
                undefined
              );
              return { _tag: "Stored", eventId } as const;
            }
          }
        }).pipe(
          Effect.catchAll((error) =>
            error.stage === "store"
              ? Effect.fail(error)
              : Effect.succeed({ _tag: "Error", error } as const)
          )
        );

      const processStream = Effect.fn("JetstreamSyncEngine.processStream")(
        (
          config: JetstreamSyncConfig,
          predicate: (post: Post) => Effect.Effect<
            { readonly ok: boolean; readonly llm: ReadonlyArray<LlmDecisionMeta> },
            unknown
          >,
          activeCheckpoint: Option.Option<SyncCheckpoint>
        ) =>
          Effect.gen(function* () {
            const filterHash = filterExprSignature(config.filter);
            const startTime = Date.now();
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

            const baseStream = jetstream.stream.pipe(
              Stream.mapError(toSyncError("source", "Jetstream stream failed")),
              Stream.filter(isCommitMessage),
              Stream.filter(isPostCommit)
            );

            const limited = typeof config.limit === "number"
              ? baseStream.pipe(Stream.take(config.limit))
              : baseStream;

            const bounded = config.duration
              ? limited.pipe(Stream.interruptAfter(config.duration))
              : limited;

            const processBatch = (batch: Chunk.Chunk<CommitMessage>) =>
              Effect.gen(function* () {
                const messages = Chunk.toReadonlyArray(batch);
                if (messages.length === 0) {
                  return SyncResultMonoid.empty;
                }

                const outcomes = yield* Effect.forEach(
                  messages,
                  (message) =>
                    processCommit(
                      config.store,
                      config.command,
                      filterHash,
                      predicate,
                      message
                    ),
                  { concurrency: "unbounded", batching: true }
                ).pipe(Effect.withRequestBatching(true));

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
                const now = Date.now();
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

                const cursorValue = Option.getOrUndefined(state.lastCursor);
                const shouldSave =
                  cursorValue !== undefined || Option.isSome(activeCheckpoint);
                if (shouldSave) {
                  const updatedAt = yield* Schema.decodeUnknown(Timestamp)(
                    new Date().toISOString()
                  ).pipe(
                    Effect.mapError(
                      toSyncError("store", "Failed to create checkpoint timestamp")
                    )
                  );
                  const checkpoint = SyncCheckpoint.make({
                    source: config.source,
                    cursor: cursorValue,
                    lastEventId: Option.getOrUndefined(state.lastEventId),
                    filterHash,
                    updatedAt
                  });
                  yield* checkpoints
                    .save(config.store, checkpoint)
                    .pipe(
                      Effect.mapError(
                        toSyncError("store", "Failed to save checkpoint")
                      )
                    );
                }

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

            return stream;
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
          return yield* stream.pipe(
            Stream.runFold(SyncResultMonoid.empty, SyncResultMonoid.combine)
          );
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
