/**
 * Sync Checkpoint Store Service
 *
 * Manages checkpoints for sync operations to enable resumable data synchronization.
 * Stores the last sync position (cursor/timestamp) for each data source, allowing
 * sync operations to resume from where they left off rather than starting over.
 *
 * Checkpoints are stored per-store and per-data-source combination, using a
 * prefixed key-value store structure for isolation.
 *
 * @module services/sync-checkpoint-store
 */

import * as KeyValueStore from "@effect/platform/KeyValueStore";
import { Context, Effect, Layer, Option } from "effect";
import { StoreIoError } from "../domain/errors.js";
import { SyncCheckpoint, type DataSource, dataSourceKey } from "../domain/sync.js";
import type { StorePath } from "../domain/primitives.js";
import type { StoreRef } from "../domain/store.js";
import { storePrefix } from "./store-keys.js";

/**
 * Generates the storage key for a sync checkpoint based on the data source.
 * @param source - The data source identifier
 * @returns The storage key string
 */
const checkpointKey = (source: DataSource) =>
  `checkpoints/sync/${dataSourceKey(source)}`;

/**
 * Converts an error to a StoreIoError with the given path.
 * @param path - The store path for error context
 * @returns A function that creates StoreIoError from any cause
 */
const toStoreIoError = (path: StorePath) => (cause: unknown) =>
  StoreIoError.make({ path, cause });

/**
 * Service for managing sync operation checkpoints.
 *
 * This service provides methods to load and save sync checkpoints, which track
 * the last successfully processed position for each data source. This enables
 * resumable sync operations that can pick up where they left off.
 */
export class SyncCheckpointStore extends Context.Tag("@skygent/SyncCheckpointStore")<
  SyncCheckpointStore,
  {
    /**
     * Loads the sync checkpoint for a given store and data source.
     *
     * @param store - The store reference to load from
     * @param source - The data source to get checkpoint for
     * @returns Effect resolving to Option of SyncCheckpoint, or StoreIoError on failure
     */
    readonly load: (
      store: StoreRef,
      source: DataSource
    ) => Effect.Effect<Option.Option<SyncCheckpoint>, StoreIoError>;

    /**
     * Saves a sync checkpoint for resumable operations.
     *
     * @param store - The store reference to save to
     * @param checkpoint - The checkpoint data to persist
     * @returns Effect resolving to void, or StoreIoError on failure
     */
    readonly save: (
      store: StoreRef,
      checkpoint: SyncCheckpoint
    ) => Effect.Effect<void, StoreIoError>;
  }
>() {
  static readonly layer = Layer.effect(
    SyncCheckpointStore,
    Effect.gen(function* () {
      const kv = yield* KeyValueStore.KeyValueStore;
      const checkpoints = kv.forSchema(SyncCheckpoint);

      const load = Effect.fn("SyncCheckpointStore.load")(
        (store: StoreRef, source: DataSource) => {
          const prefix = storePrefix(store);
          const storeCheckpoints = KeyValueStore.prefix(checkpoints, prefix);
          return storeCheckpoints
            .get(checkpointKey(source))
            .pipe(Effect.mapError(toStoreIoError(store.root)));
        }
      );

      const save = Effect.fn("SyncCheckpointStore.save")(
        (store: StoreRef, checkpoint: SyncCheckpoint) => {
          const prefix = storePrefix(store);
          const storeCheckpoints = KeyValueStore.prefix(checkpoints, prefix);
          return storeCheckpoints
            .set(checkpointKey(checkpoint.source), checkpoint)
            .pipe(Effect.mapError(toStoreIoError(store.root)));
        }
      );

      return SyncCheckpointStore.of({ load, save });
    })
  );
}
