/**
 * Store Committer Service Module
 *
 * This module provides the StoreCommitter service, which handles atomic transactions
 * for appending events to stores. It ensures data consistency by wrapping operations
 * (upserts, conditional inserts, and deletes) in SQLite transactions.
 *
 * Key responsibilities:
 * - Atomic event appending with database state changes
 * - Deduplication support via conditional insert operations
 * - Error handling and mapping to StoreIoError
 */

import { Effect, Option, SynchronizedRef } from "effect";
import type { Semaphore } from "effect/Effect";
import { StoreIoError } from "../domain/errors.js";
import type { StorePath } from "../domain/primitives.js";
import type { StoreRef } from "../domain/store.js";
import { type EventLogEntry, PostDelete, PostUpsert } from "../domain/events.js";
import { StoreDb } from "./store-db.js";
import { StoreWriter } from "./store-writer.js";
import { deletePost, insertPostIfMissing, upsertPost } from "./store-index-sql.js";

const toStoreIoError = (path: StorePath) => (cause: unknown) =>
  StoreIoError.make({ path, cause });

interface StoreCommitterService {
  readonly appendUpsert: (
    store: StoreRef,
    event: PostUpsert
  ) => Effect.Effect<EventLogEntry, StoreIoError>;
  readonly appendUpserts: (
    store: StoreRef,
    events: ReadonlyArray<PostUpsert>
  ) => Effect.Effect<ReadonlyArray<EventLogEntry>, StoreIoError>;
  readonly appendUpsertIfMissing: (
    store: StoreRef,
    event: PostUpsert
  ) => Effect.Effect<Option.Option<EventLogEntry>, StoreIoError>;
  readonly appendUpsertsIfMissing: (
    store: StoreRef,
    events: ReadonlyArray<PostUpsert>
  ) => Effect.Effect<ReadonlyArray<Option.Option<EventLogEntry>>, StoreIoError>;
  readonly appendDelete: (
    store: StoreRef,
    event: PostDelete
  ) => Effect.Effect<EventLogEntry, StoreIoError>;
}

/**
 * Service for committing events to stores with atomic transaction guarantees.
 *
 * The StoreCommitter provides three core operations for persisting post events:
 * - `appendUpsert`: Atomically upsert a post and record the event
 * - `appendUpsertIfMissing`: Insert only if the post doesn't exist (for deduplication)
 * - `appendDelete`: Atomically delete a post and record the event
 *
 * All operations are performed within SQLite transactions to maintain consistency
 * between the post index and the event log.
 *
 * @example
 * ```ts
 * const program = Effect.gen(function* () {
 *   const committer = yield* StoreCommitter;
 *   const store = { root: "/data/posts" };
 *   const event = PostUpsert.make({ ... });
 *
 *   const record = yield* committer.appendUpsert(store, event);
 *   return record;
 * });
 * ```
 */
export class StoreCommitter extends Effect.Service<StoreCommitter>()("@skygent/StoreCommitter", {
  effect: Effect.gen(function* () {
    const storeDb = yield* StoreDb;
    const writer = yield* StoreWriter;
    const locks = yield* SynchronizedRef.make(new Map<string, Semaphore>());

    const getLock = (storeName: string) =>
      SynchronizedRef.modifyEffect(locks, (current) =>
        Effect.gen(function* () {
          const existing = current.get(storeName);
          if (existing) {
            return [existing, current] as const;
          }
          const created = yield* Effect.makeSemaphore(1);
          const next = new Map(current);
          next.set(storeName, created);
          return [created, next] as const;
        })
      );

    const withStoreLock = <A, E, R>(
      store: StoreRef,
      effect: Effect.Effect<A, E, R>
    ): Effect.Effect<A, E, R> =>
      getLock(store.name).pipe(
        Effect.flatMap((semaphore) => semaphore.withPermits(1)(effect))
      );

    const appendUpsert = Effect.fn("StoreCommitter.appendUpsert")(
      (store: StoreRef, event: PostUpsert) =>
        withStoreLock(
          store,
          storeDb
            .withClient(store, (client) =>
              client.withTransaction(
                Effect.gen(function* () {
                  yield* upsertPost(client, event.post);
                  return yield* writer.appendWithClient(client, event);
                })
              )
            )
            .pipe(Effect.mapError(toStoreIoError(store.root)))
        )
    );

    const appendUpserts = Effect.fn("StoreCommitter.appendUpserts")(
      (store: StoreRef, events: ReadonlyArray<PostUpsert>) => {
        if (events.length === 0) {
          return Effect.succeed([] as ReadonlyArray<EventLogEntry>);
        }
        return withStoreLock(
          store,
          storeDb
            .withClient(store, (client) =>
              client.withTransaction(
                Effect.forEach(events, (event) =>
                  Effect.gen(function* () {
                    yield* upsertPost(client, event.post);
                    return yield* writer.appendWithClient(client, event);
                  })
                )
              )
            )
            .pipe(Effect.mapError(toStoreIoError(store.root)))
        );
      }
    );

    const appendUpsertIfMissing = Effect.fn(
      "StoreCommitter.appendUpsertIfMissing"
    )((store: StoreRef, event: PostUpsert) =>
      withStoreLock(
        store,
        storeDb
          .withClient(store, (client) =>
            client.withTransaction(
              Effect.gen(function* () {
                const inserted = yield* insertPostIfMissing(client, event.post);
                if (!inserted) {
                  return Option.none<EventLogEntry>();
                }
                const entry = yield* writer.appendWithClient(client, event);
                return Option.some(entry);
              })
            )
          )
          .pipe(Effect.mapError(toStoreIoError(store.root)))
      )
    );

    const appendUpsertsIfMissing = Effect.fn(
      "StoreCommitter.appendUpsertsIfMissing"
    )((store: StoreRef, events: ReadonlyArray<PostUpsert>) => {
      if (events.length === 0) {
        return Effect.succeed([] as ReadonlyArray<Option.Option<EventLogEntry>>);
      }
      return withStoreLock(
        store,
        storeDb
          .withClient(store, (client) =>
            client.withTransaction(
              Effect.forEach(events, (event) =>
                Effect.gen(function* () {
                  const inserted = yield* insertPostIfMissing(client, event.post);
                  if (!inserted) {
                    return Option.none<EventLogEntry>();
                  }
                  const entry = yield* writer.appendWithClient(client, event);
                  return Option.some(entry);
                })
              )
            )
          )
          .pipe(Effect.mapError(toStoreIoError(store.root)))
      );
    });

    const appendDelete = Effect.fn("StoreCommitter.appendDelete")(
      (store: StoreRef, event: PostDelete) =>
        withStoreLock(
          store,
          storeDb
            .withClient(store, (client) =>
              client.withTransaction(
                Effect.gen(function* () {
                  yield* deletePost(client, event.uri);
                  return yield* writer.appendWithClient(client, event);
                })
              )
            )
            .pipe(Effect.mapError(toStoreIoError(store.root)))
        )
    );

    const service: StoreCommitterService = {
      appendUpsert,
      appendUpserts,
      appendUpsertIfMissing,
      appendUpsertsIfMissing,
      appendDelete
    };
    return service;
  })
}) {
  static readonly layer = StoreCommitter.Default;
}
