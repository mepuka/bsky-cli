/**
 * DerivationEngine - Creates derived stores by filtering posts from a source store.
 *
 * ## Purpose and Use Cases
 *
 * The DerivationEngine enables creation of filtered views (derived stores) from source stores.
 * Common use cases include:
 * - Creating topic-specific feeds (e.g., "tech news", "sports")
 * - Filtering by content criteria (e.g., posts with images, posts from specific authors)
 * - Building trend-based feeds using time-windowed filters like Trending
 * - Creating hierarchical store relationships where derived stores become sources for further derivation
 *
 * ## Evaluation Modes
 *
 * The engine supports two evaluation modes that determine when and how filters are applied:
 *
 * ### EventTime Mode
 * - **When to use**: For pure filters that operate solely on event data
 * - **Characteristics**: Processes historical events from the source store
 * - **Limitations**: Only supports pure filters; effectful filters (Trending, HasValidLinks) are rejected
 * - **Use case**: Static filtering based on post content, author, hashtags, etc.
 *
 * ### DeriveTime Mode
 * - **When to use**: For effectful filters that require external data or time-based calculations
 * - **Characteristics**: Supports filters like Trending (which needs current time context) and HasValidLinks (which may fetch external metadata)
 * - **Use case**: Dynamic feeds that depend on current state or external conditions
 *
 * ## Incremental Derivation with Checkpoints
 *
 * The engine supports incremental derivation for efficiency:
 *
 * 1. **Checkpoint Persistence**: After each derivation run, the engine saves a checkpoint containing:
 *    - The last processed source event ID
 *    - Filter hash (to detect filter changes)
 *    - Evaluation mode
 *    - Event processing statistics
 *
 * 2. **Resumption**: Subsequent runs resume from the last checkpoint, processing only new events
 *    since the previous run
 *
 * 3. **Validation**: If filter or mode changes are detected, derivation fails unless `--reset` is used
 *
 * 4. **Periodic Checkpoints**: Checkpoints are saved periodically during long-running derivations based on
 *    settings (`checkpointEvery` events or `checkpointIntervalMs`)
 *
 * ## Event Replay and Propagation
 *
 * - **PostUpsert events**: Evaluated against the filter; matching posts are added to the target store
 * - **PostDelete events**: All deletes are propagated to maintain consistency between source and derived stores
 * - **URI deduplication**: Posts already in the target store are skipped to prevent duplicates
 *
 * ## Dependencies
 *
 * The DerivationEngine depends on:
 * - StoreEventLog: Streams events from the source store
 * - StoreIndex: Checks for existing posts and clears target store on reset
 * - StoreCommitter: Appends matched posts and propagated deletes to the target store
 * - FilterCompiler: Compiles and validates filter expressions
 * - FilterRuntime: Evaluates filters against posts
 * - ViewCheckpointStore: Persists and loads derivation checkpoints
 * - LineageStore: Records derivation metadata and store relationships
 * - DerivationSettings: Configures checkpoint frequency and intervals
 */

import { Clock, Effect, Exit, Option, Ref, Schema, Stream } from "effect";
import { StoreEventLog } from "./store-event-log.js";
import { StoreIndex } from "./store-index.js";
import { StoreCommitter } from "./store-commit.js";
import { FilterRuntime } from "./filter-runtime.js";
import { FilterCompiler } from "./filter-compiler.js";
import { ViewCheckpointStore } from "./view-checkpoint-store.js";
import { LineageStore } from "./lineage-store.js";
import { DerivationSettings } from "./derivation-settings.js";
import { FilterOutput, FilterSpec } from "../domain/store.js";
import type { StoreRef } from "../domain/store.js";
import { filterExprSignature, isEffectfulFilter } from "../domain/filter.js";
import type { FilterExpr } from "../domain/filter.js";
import {
  DerivationCheckpoint,
  DerivationError,
  DerivationResult,
  FilterEvaluationMode,
  StoreLineage,
  StoreSource
} from "../domain/derivation.js";
import { EventMeta, PostDelete, PostUpsert, isPostDelete } from "../domain/events.js";
import type { EventLogEntry } from "../domain/events.js";
import { EventSeq, Timestamp } from "../domain/primitives.js";

/**
 * Options controlling the derivation process.
 */
export interface DerivationOptions {
  /**
   * The filter evaluation mode determining when filters are applied.
   *
   * - "EventTime": For pure filters only; processes historical events. Rejects effectful filters.
   * - "DeriveTime": Supports effectful filters (Trending, HasValidLinks) that require external context.
   */
  readonly mode: FilterEvaluationMode;

  /**
   * Whether to reset the derivation, clearing all target store data and checkpoints.
   *
   * When true:
   * - Clears the target store's event log and index
   * - Removes any existing checkpoint
   * - Starts derivation from the beginning of the source store
   *
   * Use this when changing filters or recovering from inconsistent state.
   */
  readonly reset: boolean;

  /**
   * When true, perform a dry-run without writing to the target store.
   */
  readonly dryRun?: boolean;
}

/**
 * Service for creating derived stores by filtering posts from a source store.
 *
 * The DerivationEngine provides the core functionality for store derivation, including:
 * - Filter compilation and validation
 * - Incremental event processing with checkpoint support
 * - Post matching and delete propagation
 * - Lineage tracking for derived stores
 *
 * Use this service to create filtered views that automatically stay in sync with their
 * source stores through incremental updates.
 */
export class DerivationEngine extends Effect.Service<DerivationEngine>()("@skygent/DerivationEngine", {
  effect: Effect.gen(function* () {
    const eventLog = yield* StoreEventLog;
    const index = yield* StoreIndex;
    const committer = yield* StoreCommitter;
    const compiler = yield* FilterCompiler;
    const runtime = yield* FilterRuntime;
    const checkpoints = yield* ViewCheckpointStore;
    const lineageStore = yield* LineageStore;
    const settings = yield* DerivationSettings;

    const derive = Effect.fn("DerivationEngine.derive")(
      (sourceRef: StoreRef, targetRef: StoreRef, filterExpr: FilterExpr, options: DerivationOptions) =>
        Effect.gen(function* () {
            if (sourceRef.name === targetRef.name) {
              return yield* DerivationError.make({
                message: "Source and target stores must be different.",
                sourceStore: sourceRef.name,
                targetStore: targetRef.name
              });
            }
            // EventTime mode guard: reject effectful filters
            // Defense-in-depth: CLI validates for UX (user-friendly errors),
            // service validates for safety (in case called from other contexts)
            if (options.mode === "EventTime" && isEffectfulFilter(filterExpr)) {
              return yield* DerivationError.make({
                message:
                  "EventTime mode only supports pure filters. Use --mode derive-time for Trending/HasValidLinks.",
                sourceStore: sourceRef.name,
                targetStore: targetRef.name
              });
            }

            const dryRun = options.dryRun ?? false;
            const startTimeMillis = yield* Clock.currentTimeMillis;

            // Filter compilation
            const filterSpec = FilterSpec.make({
              name: "derive",
              expr: filterExpr,
              output: FilterOutput.make({ path: "derive", json: false, markdown: false })
            });
            yield* compiler.compile(filterSpec);
            const predicate = yield* runtime.evaluate(filterExpr);

            // Reset logic: clear target store + checkpoint if requested
            if (options.reset && !dryRun) {
              yield* index.clear(targetRef);
              yield* eventLog.clear(targetRef);
              yield* checkpoints.remove(targetRef.name, sourceRef.name);
            }

            // Checkpoint loading (skip when reset)
            const checkpointOption = options.reset
              ? Option.none()
              : yield* checkpoints.load(targetRef.name, sourceRef.name);
            const filterHash = filterExprSignature(filterExpr);

            if (!options.reset && Option.isNone(checkpointOption)) {
              const lastTargetSeq = yield* eventLog.getLastEventSeq(targetRef);
              if (Option.isSome(lastTargetSeq)) {
                return yield* DerivationError.make({
                  message:
                    "Target store has existing data but no derivation checkpoint. Use --reset to rebuild or choose a new target store.",
                  sourceStore: sourceRef.name,
                  targetStore: targetRef.name
                });
              }
            }

            if (!options.reset && Option.isSome(checkpointOption)) {
              const checkpoint = checkpointOption.value;
              if (checkpoint.filterHash !== filterHash || checkpoint.evaluationMode !== options.mode) {
                return yield* DerivationError.make({
                  message:
                    "Derivation settings have changed since last run. Use --reset to rebuild or choose a new target store.",
                  sourceStore: sourceRef.name,
                  targetStore: targetRef.name
                });
              }
            }

            // Check if checkpoint is valid (matching filter and mode)
            // Schema.optional makes lastSourceEventSeq EventSeq | undefined
            const startAfter: Option.Option<EventSeq> = Option.flatMap(checkpointOption, (cp) => {
              if (cp.filterHash === filterHash && cp.evaluationMode === options.mode) {
                return Option.fromNullable(cp.lastSourceEventSeq);
              }
              return Option.none();
            });

            type DerivationState = {
              readonly processed: number;
              readonly matched: number;
              readonly skipped: number;
              readonly deletes: number;
              readonly lastSourceSeq: Option.Option<EventSeq>;
              readonly lastCheckpointAt: number;
            };

            const saveCheckpointFromState = (state: DerivationState, now: number) =>
              dryRun
                ? Effect.void
                : Schema.decodeUnknown(Timestamp)(new Date(now).toISOString()).pipe(
                    Effect.flatMap((timestamp) => {
                      const checkpoint = DerivationCheckpoint.make({
                        viewName: targetRef.name,
                        sourceStore: sourceRef.name,
                        targetStore: targetRef.name,
                        filterHash,
                        evaluationMode: options.mode,
                        lastSourceEventSeq: Option.getOrUndefined(state.lastSourceSeq),
                        eventsProcessed: state.processed,
                        eventsMatched: state.matched,
                        deletesPropagated: state.deletes,
                        updatedAt: timestamp
                      });
                      return checkpoints.save(checkpoint);
                    })
                  );

            const shouldCheckpoint = (state: DerivationState, now: number) =>
              state.processed > 0 &&
              (state.processed % settings.checkpointEvery === 0 ||
                (settings.checkpointIntervalMs > 0 &&
                  now - state.lastCheckpointAt >= settings.checkpointIntervalMs));

            const initialState: DerivationState = {
              processed: 0,
              matched: 0,
              skipped: 0,
              deletes: 0,
              lastSourceSeq: Option.none<EventSeq>(),
              lastCheckpointAt: startTimeMillis
            };

            const stateRef = yield* Ref.make(initialState);
            const seenRef = dryRun ? yield* Ref.make(new Set<string>()) : undefined;

            const finalizeState = (nextState: DerivationState) =>
              Effect.gen(function* () {
                const now = yield* Clock.currentTimeMillis;
                if (shouldCheckpoint(nextState, now)) {
                  yield* saveCheckpointFromState(nextState, now);
                  const updated = { ...nextState, lastCheckpointAt: now };
                  yield* Ref.set(stateRef, updated);
                  return updated;
                }
                yield* Ref.set(stateRef, nextState);
                return nextState;
              });

            const processRecord = (state: DerivationState, entry: EventLogEntry) =>
              Effect.gen(function* () {
                const event = entry.record.event;
                const nextLast = Option.some(entry.seq);

                const baseState: DerivationState = {
                  processed: state.processed + 1,
                  matched: state.matched,
                  skipped: state.skipped,
                  deletes: state.deletes,
                  lastSourceSeq: nextLast,
                  lastCheckpointAt: state.lastCheckpointAt
                };

                // PostDelete: propagate ALL unfiltered
                if (isPostDelete(event)) {
                  if (!dryRun) {
                    const derivedMeta = EventMeta.make({
                      ...event.meta,
                      sourceStore: sourceRef.name
                    });
                    const derivedEvent = PostDelete.make({ ...event, meta: derivedMeta });
                    yield* committer.appendDelete(targetRef, derivedEvent);
                  }
                  return yield* finalizeState({
                    ...baseState,
                    deletes: baseState.deletes + 1
                  });
                }

                // URI deduplication: check if post already exists
                const uri = event.post.uri;
                const exists = yield* index.hasUri(targetRef, uri);
                if (exists) {
                  return yield* finalizeState({
                    ...baseState,
                    skipped: baseState.skipped + 1
                  });
                }
                if (dryRun && seenRef) {
                  const seen = yield* Ref.get(seenRef);
                  if (seen.has(uri)) {
                    return yield* finalizeState({
                      ...baseState,
                      skipped: baseState.skipped + 1
                    });
                  }
                }

                // Filter evaluation: failures propagate to caller
                const matches = yield* predicate(event.post);

                if (matches) {
                  if (dryRun) {
                    if (seenRef) {
                      const seen = yield* Ref.get(seenRef);
                      const next = new Set(seen);
                      next.add(uri);
                      yield* Ref.set(seenRef, next);
                    }
                    return yield* finalizeState({
                      ...baseState,
                      matched: baseState.matched + 1
                    });
                  }
                  const derivedMeta = EventMeta.make({
                    ...event.meta,
                    sourceStore: sourceRef.name
                  });
                  const derivedEvent = PostUpsert.make({ post: event.post, meta: derivedMeta });
                  const stored = yield* committer.appendUpsertIfMissing(
                    targetRef,
                    derivedEvent
                  );
                  return yield* finalizeState(
                    Option.match(stored, {
                      onNone: () => ({
                        ...baseState,
                        skipped: baseState.skipped + 1
                      }),
                      onSome: () => ({
                        ...baseState,
                        matched: baseState.matched + 1
                      })
                    })
                  );
                }

                return yield* finalizeState({
                  ...baseState,
                  skipped: baseState.skipped + 1
                });
              });

            // Event streaming with runFoldEffect + periodic checkpoints
            const fold = eventLog.stream(sourceRef).pipe(
              Stream.filter((entry) =>
                Option.match(startAfter, {
                  onNone: () => true,
                  onSome: (seq: EventSeq) => entry.seq > seq
                })
              ),
              Stream.runFoldEffect(initialState, processRecord)
            );

            const result = yield* fold.pipe(
              Effect.onExit((exit) =>
                Exit.isFailure(exit)
                  ? Ref.get(stateRef).pipe(
                      Effect.flatMap((state) =>
                        state.processed > 0
                          ? Clock.currentTimeMillis.pipe(
                              Effect.flatMap((now) =>
                                saveCheckpointFromState(state, now)
                              )
                            )
                          : Effect.void
                      ),
                      Effect.catchAll(() => Effect.void)
                    )
                  : Effect.void
              )
            );

            // Timestamp creation using Clock
            const endTimeMillis = yield* Clock.currentTimeMillis;
            const timestamp = yield* Schema.decodeUnknown(Timestamp)(
              new Date(endTimeMillis).toISOString()
            );

            // Checkpoint saving: always record materialization attempt
            const lastSourceSeqOption = Option.isSome(result.lastSourceSeq)
              ? result.lastSourceSeq
              : yield* eventLog.getLastEventSeq(sourceRef);
            if (!dryRun) {
              const checkpoint = DerivationCheckpoint.make({
                viewName: targetRef.name,
                sourceStore: sourceRef.name,
                targetStore: targetRef.name,
                filterHash,
                evaluationMode: options.mode,
                lastSourceEventSeq: Option.getOrUndefined(lastSourceSeqOption),
                eventsProcessed: result.processed,
                eventsMatched: result.matched,
                deletesPropagated: result.deletes,
                updatedAt: timestamp
              });
              yield* checkpoints.save(checkpoint);

              // Lineage saving: record derivation metadata
              const lineage = StoreLineage.make({
                storeName: targetRef.name,
                isDerived: true,
                sources: [
                  StoreSource.make({
                    storeName: sourceRef.name,
                    filter: filterExpr,
                    filterHash,
                    evaluationMode: options.mode,
                    derivedAt: timestamp
                  })
                ],
                updatedAt: timestamp
              });
              yield* lineageStore.save(lineage);
            }

            // Return DerivationResult
            return DerivationResult.make({
              eventsProcessed: result.processed,
              eventsMatched: result.matched,
              eventsSkipped: result.skipped,
              deletesPropagated: result.deletes,
              durationMs: endTimeMillis - startTimeMillis
            });
          })
      );

    return { derive };
  })
}) {
  static readonly layer = DerivationEngine.Default;
}
