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

import * as KeyValueStore from "@effect/platform/KeyValueStore";
import type { PlatformError } from "@effect/platform/Error";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { DerivationCheckpoint } from "../domain/derivation.js";
import { StoreName, StorePath } from "../domain/primitives.js";
import { StoreIoError } from "../domain/errors.js";

/**
 * Generates the storage key for a view derivation checkpoint.
 * @param viewName - The name of the derived store (view)
 * @param sourceName - The name of the source store
 * @returns The storage key string
 */
const checkpointKey = (viewName: StoreName, sourceName: StoreName) =>
  `stores/${viewName}/checkpoints/derivation/${sourceName}`;

/**
 * Converts an error to a StoreIoError with context for the checkpoint path.
 * @param viewName - The name of the derived store
 * @param sourceName - The name of the source store
 * @returns A function that creates StoreIoError from any cause
 */
const toStoreIoError = (viewName: StoreName, sourceName: StoreName) => (cause: unknown) => {
  const path = Schema.decodeUnknownSync(StorePath)(
    `stores/${viewName}/checkpoints/derivation/${sourceName}`
  );
  return StoreIoError.make({ path, cause });
};

/**
 * Service for managing derivation (view) checkpoints.
 *
 * This service tracks the processing progress when deriving one store from
 * another, storing checkpoints that record which events from the source store
 * have been processed. This enables efficient incremental derivation.
 */
export class ViewCheckpointStore extends Context.Tag("@skygent/ViewCheckpointStore")<
  ViewCheckpointStore,
  {
    /**
     * Loads the derivation checkpoint for a view and its source store.
     *
     * @param viewName - The name of the derived store
     * @param sourceName - The name of the source store
     * @returns Effect resolving to Option of DerivationCheckpoint, or StoreIoError on failure
     */
    readonly load: (
      viewName: StoreName,
      sourceName: StoreName
    ) => Effect.Effect<Option.Option<DerivationCheckpoint>, StoreIoError>;

    /**
     * Saves a derivation checkpoint.
     *
     * @param checkpoint - The checkpoint data to persist
     * @returns Effect resolving to void, or StoreIoError on failure
     */
    readonly save: (
      checkpoint: DerivationCheckpoint
    ) => Effect.Effect<void, StoreIoError>;

    /**
     * Removes a derivation checkpoint.
     *
     * @param viewName - The name of the derived store
     * @param sourceName - The name of the source store
     * @returns Effect resolving to void, or StoreIoError on failure
     */
    readonly remove: (
      viewName: StoreName,
      sourceName: StoreName
    ) => Effect.Effect<void, StoreIoError>;
  }
>() {
  static readonly layer = Layer.effect(
    ViewCheckpointStore,
    Effect.gen(function* () {
      const kv = yield* KeyValueStore.KeyValueStore;
      const checkpoints = kv.forSchema(DerivationCheckpoint);

      const load = Effect.fn("ViewCheckpointStore.load")(
        (viewName: StoreName, sourceName: StoreName) =>
          checkpoints.get(checkpointKey(viewName, sourceName)).pipe(
            Effect.mapError(toStoreIoError(viewName, sourceName))
          )
      );

      const save = Effect.fn("ViewCheckpointStore.save")(
        (checkpoint: DerivationCheckpoint) =>
          checkpoints
            .set(
              checkpointKey(checkpoint.viewName, checkpoint.sourceStore),
              checkpoint
            )
            .pipe(
              Effect.mapError(
                toStoreIoError(checkpoint.viewName, checkpoint.sourceStore)
              )
            )
      );

      const remove = Effect.fn("ViewCheckpointStore.remove")(
        (viewName: StoreName, sourceName: StoreName) =>
          checkpoints
            .remove(checkpointKey(viewName, sourceName))
            .pipe(
              Effect.catchAll((error: PlatformError) =>
                error._tag === "SystemError" && error.reason === "NotFound"
                  ? Effect.void
                  : Effect.fail(error)
              ),
              Effect.mapError(toStoreIoError(viewName, sourceName))
            )
      );

      return ViewCheckpointStore.of({ load, save, remove });
    })
  );
}
