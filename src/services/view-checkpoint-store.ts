/**
 * View Checkpoint Store Service
 *
 * Manages checkpoints for store derivation (view) operations. Tracks the last
 * processed event from a source store to enable incremental derivation.
 *
 * Unlike sync checkpoints which track data sources, view checkpoints track
 * the processing progress when deriving one store from another, allowing
 * incremental updates rather than full re-derivation.
 *
 * @module services/view-checkpoint-store
 */

import { Effect, Option, Schema } from "effect";
import { DerivationCheckpoint, FilterEvaluationMode } from "../domain/derivation.js";
import { EventSeq, StoreName, storePath, Timestamp } from "../domain/primitives.js";
import { StoreIoError } from "../domain/errors.js";
import { StoreDb } from "./store-db.js";
import { StoreManager } from "./store-manager.js";

/**
 * Converts an error to a StoreIoError with context for the checkpoint path.
 * @param viewName - The name of the derived store
 * @param sourceName - The name of the source store
 * @returns A function that creates StoreIoError from any cause
 */
const toStoreIoError = (viewName: StoreName, sourceName: StoreName) => (cause: unknown) =>
  StoreIoError.make({
    path: storePath(`stores/${viewName}/checkpoints/derivation/${sourceName}`),
    cause
  });

const checkpointRow = Schema.Struct({
  view_name: StoreName,
  source_store: StoreName,
  target_store: StoreName,
  filter_hash: Schema.String,
  evaluation_mode: FilterEvaluationMode,
  last_source_event_seq: Schema.NullOr(EventSeq),
  events_processed: Schema.NonNegativeInt,
  events_matched: Schema.NonNegativeInt,
  deletes_propagated: Schema.NonNegativeInt,
  updated_at: Schema.String
});

/**
 * Service for managing derivation (view) checkpoints.
 *
 * This service tracks the processing progress when deriving one store from
 * another, storing checkpoints that record which events from the source store
 * have been processed. This enables efficient incremental derivation.
 */
export class ViewCheckpointStore extends Effect.Service<ViewCheckpointStore>()("@skygent/ViewCheckpointStore", {
  effect: Effect.gen(function* () {
    const storeDb = yield* StoreDb;
    const manager = yield* StoreManager;

    const resolveStore = (viewName: StoreName, sourceName: StoreName) =>
      manager
        .getStore(viewName)
        .pipe(Effect.mapError(toStoreIoError(viewName, sourceName)));

    const load = Effect.fn("ViewCheckpointStore.load")(
      (viewName: StoreName, sourceName: StoreName) =>
        resolveStore(viewName, sourceName).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(Option.none<DerivationCheckpoint>()),
              onSome: (storeRef) =>
                storeDb.withClient(storeRef, (client) =>
                  Effect.gen(function* () {
                    const rows = yield* client`SELECT
                        view_name,
                        source_store,
                        target_store,
                        filter_hash,
                        evaluation_mode,
                        last_source_event_seq,
                        events_processed,
                        events_matched,
                        deletes_propagated,
                        updated_at
                      FROM derivation_checkpoints
                      WHERE view_name = ${viewName} AND source_store = ${sourceName}`;
                    if (rows.length === 0) {
                      return Option.none<DerivationCheckpoint>();
                    }
                    const decoded = yield* Schema.decodeUnknown(
                      Schema.Array(checkpointRow)
                    )(rows);
                    const row = decoded[0]!;
                    const updatedAt = yield* Schema.decodeUnknown(Timestamp)(row.updated_at);
                    return Option.some(
                      DerivationCheckpoint.make({
                        viewName: row.view_name,
                        sourceStore: row.source_store,
                        targetStore: row.target_store,
                        filterHash: row.filter_hash,
                        evaluationMode: row.evaluation_mode,
                        lastSourceEventSeq: row.last_source_event_seq ?? undefined,
                        eventsProcessed: row.events_processed,
                        eventsMatched: row.events_matched,
                        deletesPropagated: row.deletes_propagated,
                        updatedAt
                      })
                    );
                  })
                )
            })
          ),
          Effect.mapError(toStoreIoError(viewName, sourceName))
        )
    );

    const save = Effect.fn("ViewCheckpointStore.save")(
      (checkpoint: DerivationCheckpoint) =>
        resolveStore(checkpoint.viewName, checkpoint.sourceStore).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(
                  toStoreIoError(checkpoint.viewName, checkpoint.sourceStore)(
                    new Error(`Store "${checkpoint.viewName}" not found`)
                  )
                ),
              onSome: (storeRef) =>
                storeDb.withClient(storeRef, (client) =>
                  Effect.gen(function* () {
                    const updatedAt = checkpoint.updatedAt.toISOString();
                    yield* client`INSERT INTO derivation_checkpoints (
                        view_name,
                        source_store,
                        target_store,
                        filter_hash,
                        evaluation_mode,
                        last_source_event_seq,
                        events_processed,
                        events_matched,
                        deletes_propagated,
                        updated_at
                      )
                      VALUES (
                        ${checkpoint.viewName},
                        ${checkpoint.sourceStore},
                        ${checkpoint.targetStore},
                        ${checkpoint.filterHash},
                        ${checkpoint.evaluationMode},
                        ${checkpoint.lastSourceEventSeq ?? null},
                        ${checkpoint.eventsProcessed},
                        ${checkpoint.eventsMatched},
                        ${checkpoint.deletesPropagated},
                        ${updatedAt}
                      )
                      ON CONFLICT(view_name, source_store) DO UPDATE SET
                        target_store = excluded.target_store,
                        filter_hash = excluded.filter_hash,
                        evaluation_mode = excluded.evaluation_mode,
                        last_source_event_seq = CASE
                          WHEN excluded.last_source_event_seq IS NULL THEN derivation_checkpoints.last_source_event_seq
                          WHEN derivation_checkpoints.last_source_event_seq IS NULL THEN excluded.last_source_event_seq
                          WHEN excluded.last_source_event_seq >= derivation_checkpoints.last_source_event_seq THEN excluded.last_source_event_seq
                          ELSE derivation_checkpoints.last_source_event_seq
                        END,
                        events_processed = excluded.events_processed,
                        events_matched = excluded.events_matched,
                        deletes_propagated = excluded.deletes_propagated,
                        updated_at = excluded.updated_at`;
                  })
                )
            })
          ),
          Effect.mapError(toStoreIoError(checkpoint.viewName, checkpoint.sourceStore))
        )
    );

    const remove = Effect.fn("ViewCheckpointStore.remove")(
      (viewName: StoreName, sourceName: StoreName) =>
        resolveStore(viewName, sourceName).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.void,
              onSome: (storeRef) =>
                storeDb.withClient(storeRef, (client) =>
                  client`DELETE FROM derivation_checkpoints
                    WHERE view_name = ${viewName} AND source_store = ${sourceName}`.pipe(
                    Effect.asVoid
                  )
                )
            })
          ),
          Effect.mapError(toStoreIoError(viewName, sourceName))
        )
    );

    return { load, save, remove };
  })
}) {
  static readonly layer = ViewCheckpointStore.Default;
}
