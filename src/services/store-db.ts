import { FileSystem, Path } from "@effect/platform";
import { Context, Effect, Exit, Layer, Ref, Scope } from "effect";
import * as Reactivity from "@effect/experimental/Reactivity";
import * as Migrator from "@effect/sql/Migrator";
import * as MigratorFileSystem from "@effect/sql/Migrator/FileSystem";
import * as SqlClient from "@effect/sql/SqlClient";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { StoreIoError } from "../domain/errors.js";
import type { StoreRef } from "../domain/store.js";
import type { StorePath } from "../domain/primitives.js";
import { AppConfigService } from "./app-config.js";

/**
 * Store Database Connection Management Service
 *
 * This module provides a centralized SQLite database connection manager for store indexes.
 * It implements a connection caching/pooling pattern to efficiently manage database connections
 * across multiple stores while ensuring proper resource cleanup.
 *
 * Key features:
 * - Connection caching: Reuses existing connections to the same store
 * - Thread-safe client access using semaphores for concurrent operations
 * - Automatic migration execution on first connection to each store
 * - Optimized SQLite pragmas for performance (WAL mode, memory-mapped I/O, cache sizing)
 * - Graceful cleanup on service shutdown via finalizers
 *
 * @example
 * ```typescript
 * import { Effect } from "effect";
 * import { StoreDb } from "./services/store-db.js";
 * import type { StoreRef } from "./domain/store.js";
 *
 * const program = Effect.gen(function* () {
 *   const storeDb = yield* StoreDb;
 *   const store: StoreRef = { name: "myStore", root: "stores/myStore" };
 *
 *   // Execute queries with automatic connection management
 *   const result = yield* storeDb.withClient(store, (client) =>
 *     client`SELECT * FROM posts WHERE id = ${postId}`
 *   );
 *
 *   // Remove a store's connection when done
 *   yield* storeDb.removeClient(store.name);
 * });
 *
 * const runnable = program.pipe(Effect.provide(StoreDb.layer));
 * ```
 *
 * @module services/store-db
 */

const migrationsDir = decodeURIComponent(
  new URL("../db/migrations/store-index", import.meta.url).pathname
);

const toStoreIoError = (path: StorePath) => (cause: unknown) =>
  StoreIoError.make({ path, cause });

/**
 * Service for managing SQLite database connections to store indexes.
 *
 * Provides connection pooling/caching, automatic migrations, and optimized
 * SQLite configuration for each store. Connections are lazily created and
 * cached for reuse, with proper cleanup on service termination.
 *
 * @example
 * ```typescript
 * // Basic usage - execute a query
 * const result = yield* storeDb.withClient(store, (client) =>
 *   client`SELECT COUNT(*) as count FROM posts`
 * );
 *
 * // Batch operations with the same connection
 * const results = yield* storeDb.withClient(store, (client) =>
 *   Effect.gen(function* () {
 *     yield* client`INSERT INTO posts (id, content) VALUES (${id1}, ${content1})`;
 *     yield* client`INSERT INTO posts (id, content) VALUES (${id2}, ${content2})`;
 *     return yield* client`SELECT * FROM posts`;
 *   })
 * );
 * ```
 */
export class StoreDb extends Context.Tag("@skygent/StoreDb")<
  StoreDb,
  {
    /**
     * Execute a database operation with a cached client for the specified store.
     *
     * This method automatically retrieves an existing connection or creates a new one,
     * runs the provided operation, and keeps the connection cached for future use.
     * The connection remains open until explicitly removed via `removeClient` or
     * service shutdown.
     *
     * @param store - Store reference containing name and root path
     * @param run - Effect function that receives the SQL client and returns a result
     * @returns Effect containing the operation result, potentially failing with StoreIoError
     * @example
     * ```typescript
     * const posts = yield* storeDb.withClient(store, (client) =>
     *   client`SELECT * FROM posts LIMIT 10`
     * );
     * ```
     */
    readonly withClient: <A, E>(
      store: StoreRef,
      run: (client: SqlClient.SqlClient) => Effect.Effect<A, E>
    ) => Effect.Effect<A, StoreIoError | E>;

    /**
     * Remove a cached database connection for a store.
     *
     * Closes the connection gracefully (running PRAGMA optimize first) and
     * removes it from the cache. Subsequent calls to `withClient` for this
     * store will create a new connection.
     *
     * @param storeName - The name of the store whose connection should be removed
     * @returns Effect that completes when the connection is closed
     * @example
     * ```typescript
     * // Clean up a store's connection when no longer needed
     * yield* storeDb.removeClient("myStore");
     * ```
     */
    readonly removeClient: (storeName: string) => Effect.Effect<void>;
  }
>() {
  static readonly layer = Layer.scoped(
    StoreDb,
    Effect.gen(function* () {
      const config = yield* AppConfigService;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const reactivity = yield* Reactivity.Reactivity;

      type CachedClient = {
        readonly client: SqlClient.SqlClient;
        readonly scope: Scope.CloseableScope;
      };
      const clients = yield* Ref.make(new Map<string, CachedClient>());
      const clientLock = yield* Effect.makeSemaphore(1);

      const migrate = Migrator.make({})({
        loader: MigratorFileSystem.fromFileSystem(migrationsDir)
      });

      const optimizeClient = (client: SqlClient.SqlClient) =>
        client`PRAGMA optimize`.pipe(Effect.catchAll(() => Effect.void));

      const closeCachedClient = ({ client, scope }: CachedClient) =>
        optimizeClient(client).pipe(Effect.zipRight(Scope.close(scope, Exit.void)));

      const closeAllClients = () =>
        Ref.get(clients).pipe(
          Effect.flatMap((current) =>
            Effect.forEach(current.values(), closeCachedClient, { discard: true })
          )
        );

      yield* Effect.addFinalizer(() => closeAllClients());

      const openClient = (store: StoreRef) =>
        Effect.gen(function* () {
          const dbPath = path.join(config.storeRoot, store.root, "index.sqlite");
          const dbDir = path.dirname(dbPath);
          yield* fs.makeDirectory(dbDir, { recursive: true });

          const clientScope = yield* Scope.make();
          const client = yield* SqliteClient.make({ filename: dbPath }).pipe(
            Effect.provideService(Scope.Scope, clientScope),
            Effect.provideService(Reactivity.Reactivity, reactivity)
          );

          // Configure SQLite for optimal performance
          yield* client`PRAGMA journal_mode = WAL`;
          yield* client`PRAGMA synchronous = NORMAL`;
          yield* client`PRAGMA temp_store = MEMORY`;
          yield* client`PRAGMA cache_size = -64000`;
          yield* client`PRAGMA mmap_size = 30000000000`;
          yield* client`PRAGMA optimize=0x10002`;
          yield* client`PRAGMA foreign_keys = ON`;
          yield* migrate.pipe(
            Effect.provideService(SqlClient.SqlClient, client),
            Effect.provideService(FileSystem.FileSystem, fs)
          );

          return { client, scope: clientScope };
        });

      const getClient = (store: StoreRef) =>
        Effect.gen(function* () {
          const cached = (yield* Ref.get(clients)).get(store.name);
          if (cached) {
            return cached.client;
          }

          return yield* clientLock.withPermits(1)(
            Effect.gen(function* () {
              const current = yield* Ref.get(clients);
              const existing = current.get(store.name);
              if (existing) {
                return existing.client;
              }

              const created = yield* openClient(store);

              const next = new Map(current);
              next.set(store.name, created);
              yield* Ref.set(clients, next);

              return created.client;
            })
          );
        });

      const withClient = <A, E>(
        store: StoreRef,
        run: (client: SqlClient.SqlClient) => Effect.Effect<A, E>
      ) =>
        getClient(store).pipe(
          Effect.mapError(toStoreIoError(store.root)),
          Effect.flatMap(run)
        );

      const removeClient = (storeName: string) =>
        Ref.modify(clients, (current) => {
          const next = new Map(current);
          const existing = next.get(storeName);
          if (existing) {
            next.delete(storeName);
          }
          return [existing, next] as const;
        }).pipe(
          Effect.flatMap((existing) =>
            existing ? closeCachedClient(existing) : Effect.void
          )
        );

      return StoreDb.of({ withClient, removeClient });
    })
  ).pipe(Layer.provide(Reactivity.layer));
}
