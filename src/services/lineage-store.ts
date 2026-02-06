/**
 * Lineage Store Service
 *
 * Tracks store derivation lineage, recording parent-child relationships between
 * stores. This enables understanding which stores are derived from others and
 * managing derivation dependencies.
 *
 * Lineage information is used to:
 * - Track which source stores a derived store depends on
 * - Validate that derivation sources haven't changed unexpectedly
 * - Rebuild derivation chains when needed
 *
 * @module services/lineage-store
 */

import * as KeyValueStore from "@effect/platform/KeyValueStore";
import { Effect } from "effect";
import { StoreLineage } from "../domain/derivation.js";
import { StoreName, storePath } from "../domain/primitives.js";
import { StoreIoError } from "../domain/errors.js";

/**
 * Generates the storage key for a store's lineage information.
 * @param storeName - The name of the store
 * @returns The storage key string
 */
const lineageKey = (storeName: StoreName) => `stores/${storeName}/lineage`;

/**
 * Converts an error to a StoreIoError with context for the lineage path.
 * @param storeName - The name of the store
 * @returns A function that creates StoreIoError from any cause
 */
const toStoreIoError = (storeName: StoreName) => (cause: unknown) =>
  StoreIoError.make({ path: storePath(`stores/${storeName}/lineage`), cause });

/**
 * Service for managing store derivation lineage.
 *
 * This service tracks parent-child relationships between stores, recording
 * which source stores were used to derive a given store. This enables
 * dependency tracking and validation of derivation chains.
 */
export class LineageStore extends Effect.Service<LineageStore>()("@skygent/LineageStore", {
  effect: Effect.gen(function* () {
    const kv = yield* KeyValueStore.KeyValueStore;
    const lineages = kv.forSchema(StoreLineage);

    const get = Effect.fn("LineageStore.get")((storeName: StoreName) =>
      lineages
        .get(lineageKey(storeName))
        .pipe(Effect.mapError(toStoreIoError(storeName)))
    );

    const save = Effect.fn("LineageStore.save")((lineage: StoreLineage) =>
      lineages
        .set(lineageKey(lineage.storeName), lineage)
        .pipe(Effect.mapError(toStoreIoError(lineage.storeName)))
    );

    const remove = Effect.fn("LineageStore.remove")((storeName: StoreName) =>
      lineages
        .remove(lineageKey(storeName))
        .pipe(Effect.mapError(toStoreIoError(storeName)))
    );

    return { get, save, remove };
  })
}) {
  static readonly layer = LineageStore.Default;
}
