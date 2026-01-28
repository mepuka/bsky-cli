import { Clock, Context, Effect, Layer, Option, ParseResult, Schema, Stream } from "effect";
import { StoreEventLog } from "./store-event-log.js";
import { StoreIndex } from "./store-index.js";
import { StoreCommitter } from "./store-commit.js";
import { FilterRuntime } from "./filter-runtime.js";
import { FilterCompiler } from "./filter-compiler.js";
import { ViewCheckpointStore } from "./view-checkpoint-store.js";
import { LineageStore } from "./lineage-store.js";
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
import { EventMeta, PostDelete, PostUpsert } from "../domain/events.js";
import { EventId, Timestamp } from "../domain/primitives.js";
import type { FilterCompileError, FilterEvalError, StoreIndexError, StoreIoError } from "../domain/errors.js";

export interface DerivationOptions {
  readonly mode: FilterEvaluationMode;
  readonly reset: boolean;
}

export class DerivationEngine extends Context.Tag("@skygent/DerivationEngine")<
  DerivationEngine,
  {
    readonly derive: (
      sourceRef: StoreRef,
      targetRef: StoreRef,
      filterExpr: FilterExpr,
      options: DerivationOptions
    ) => Effect.Effect<
      DerivationResult,
      DerivationError | StoreIoError | StoreIndexError | FilterCompileError | FilterEvalError | ParseResult.ParseError
    >;
  }
>() {
  static readonly layer = Layer.effect(
    DerivationEngine,
    Effect.gen(function* () {
      const eventLog = yield* StoreEventLog;
      const index = yield* StoreIndex;
      const committer = yield* StoreCommitter;
      const compiler = yield* FilterCompiler;
      const runtime = yield* FilterRuntime;
      const checkpoints = yield* ViewCheckpointStore;
      const lineageStore = yield* LineageStore;

      const derive = Effect.fn("DerivationEngine.derive")(
        (sourceRef, targetRef, filterExpr, options) =>
          Effect.gen(function* () {
            if (sourceRef.name === targetRef.name) {
              return yield* DerivationError.make({
                reason: "Source and target stores must be different.",
                sourceStore: sourceRef.name,
                targetStore: targetRef.name
              });
            }
            // EventTime mode guard: reject effectful filters
            // Defense-in-depth: CLI validates for UX (user-friendly errors),
            // service validates for safety (in case called from other contexts)
            if (options.mode === "EventTime" && isEffectfulFilter(filterExpr)) {
              return yield* DerivationError.make({
                reason:
                  "EventTime mode only supports pure filters. Use --mode derive-time for Llm/Trending/HasValidLinks.",
                sourceStore: sourceRef.name,
                targetStore: targetRef.name
              });
            }

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
            if (options.reset) {
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
              const lastTargetId = yield* eventLog.getLastEventId(targetRef);
              if (Option.isSome(lastTargetId)) {
                return yield* DerivationError.make({
                  reason:
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
                  reason:
                    "Derivation settings have changed since last run. Use --reset to rebuild or choose a new target store.",
                  sourceStore: sourceRef.name,
                  targetStore: targetRef.name
                });
              }
            }

            // Check if checkpoint is valid (matching filter and mode)
            // Schema.optional makes lastSourceEventId EventId | undefined
            const startAfter: Option.Option<EventId> = Option.flatMap(checkpointOption, (cp) => {
              if (cp.filterHash === filterHash && cp.evaluationMode === options.mode) {
                return Option.fromNullable(cp.lastSourceEventId);
              }
              return Option.none();
            });

            // Event streaming with runFoldEffect
            const result = yield* eventLog.stream(sourceRef).pipe(
              Stream.filter((record) =>
                Option.match(startAfter, {
                  onNone: () => true,
                  onSome: (id: EventId) => record.id.localeCompare(id) > 0
                })
              ),
              Stream.runFoldEffect(
                {
                  processed: 0,
                  matched: 0,
                  skipped: 0,
                  deletes: 0,
                  lastSourceId: Option.none<EventId>()
                },
                (state, record) =>
                  Effect.gen(function* () {
                    const event = record.event;
                    const nextLast = Option.some(record.id);

                    // PostDelete: propagate ALL unfiltered
                    if (event._tag === "PostDelete") {
                      const derivedMeta = EventMeta.make({
                        ...event.meta,
                        sourceStore: sourceRef.name
                      });
                      const derivedEvent = PostDelete.make({ ...event, meta: derivedMeta });
                      yield* committer.appendDelete(targetRef, derivedEvent);
                      return {
                        processed: state.processed + 1,
                        matched: state.matched,
                        skipped: state.skipped,
                        deletes: state.deletes + 1,
                        lastSourceId: nextLast
                      };
                    }

                    // URI deduplication: check if post already exists
                    const exists = yield* index.hasUri(targetRef, event.post.uri);
                    if (exists) {
                      return {
                        processed: state.processed + 1,
                        matched: state.matched,
                        skipped: state.skipped + 1,
                        deletes: state.deletes,
                        lastSourceId: nextLast
                      };
                    }

                    // Filter evaluation: failures propagate to caller
                    const matches = yield* predicate(event.post);

                    if (matches) {
                      const derivedMeta = EventMeta.make({
                        ...event.meta,
                        sourceStore: sourceRef.name
                      });
                      const derivedEvent = PostUpsert.make({ post: event.post, meta: derivedMeta });
                      const stored = yield* committer.appendUpsertIfMissing(
                        targetRef,
                        derivedEvent
                      );
                      return Option.match(stored, {
                        onNone: () => ({
                          processed: state.processed + 1,
                          matched: state.matched,
                          skipped: state.skipped + 1,
                          deletes: state.deletes,
                          lastSourceId: nextLast
                        }),
                        onSome: () => ({
                          processed: state.processed + 1,
                          matched: state.matched + 1,
                          skipped: state.skipped,
                          deletes: state.deletes,
                          lastSourceId: nextLast
                        })
                      });
                    }

                    return {
                      processed: state.processed + 1,
                      matched: state.matched,
                      skipped: state.skipped + 1,
                      deletes: state.deletes,
                      lastSourceId: nextLast
                    };
                  })
              )
            );

            // Timestamp creation using Clock
            const endTimeMillis = yield* Clock.currentTimeMillis;
            const timestamp = yield* Schema.decodeUnknown(Timestamp)(
              new Date(endTimeMillis).toISOString()
            );

            // Checkpoint saving: always record materialization attempt
            const lastSourceIdOption = Option.isSome(result.lastSourceId)
              ? result.lastSourceId
              : yield* eventLog.getLastEventId(sourceRef);
            const checkpoint = DerivationCheckpoint.make({
              viewName: targetRef.name,
              sourceStore: sourceRef.name,
              targetStore: targetRef.name,
              filterHash,
              evaluationMode: options.mode,
              lastSourceEventId: Option.getOrUndefined(lastSourceIdOption),
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

      return DerivationEngine.of({ derive });
    })
  );
}
