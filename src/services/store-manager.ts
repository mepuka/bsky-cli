/**
 * Store Manager Service
 *
 * Manages the lifecycle of content stores for Bluesky data.
 * Stores are SQLite databases that persist filtered posts and metadata.
 *
 * **Responsibilities:**
 * - Create new stores with configuration
 * - List all existing stores
 * - Retrieve store references and metadata
 * - Delete stores and clean up resources
 * - Manage store catalog database (SQLite)
 *
 * **Store Catalog:**
 * Each store is tracked in a central catalog database (catalog.sqlite)
 * with metadata: name, root path, creation date, optional description, config JSON.
 *
 * **Store Root:**
 * Stores are organized under `{storeRoot}/stores/{storeName}/` with:
 * - posts.sqlite - Main content database
 * - Additional store-specific files
 *
 * **Database Schema:**
 * The catalog database runs migrations from `../db/migrations/store-catalog`
 * to maintain the stores table schema.
 *
 * @module services/store-manager
 *
 * @example
 * ```typescript
 * import { StoreManager } from "./services/store-manager.js";
 * import { Effect } from "effect";
 *
 * const program = Effect.gen(function* () {
 *   const manager = yield* StoreManager;
 *
 *   // Create a new store
 *   const storeRef = yield* manager.createStore("my-feed", {
 *     filter: { _tag: "Contains", text: "tech" },
 *     errorPolicy: { _tag: "Exclude" }
 *   });
 *
 *   // List all stores
 *   const stores = yield* manager.listStores();
 *   for (const store of stores) {
 *     console.log(`${store.name}: ${store.root}`);
 *   }
 *
 *   // Get store reference
 *   const ref = yield* manager.getStore("my-feed");
 *   if (Option.isSome(ref)) {
 *     console.log(`Store at: ${ref.value.root}`);
 *   }
 * }).pipe(Effect.provide(StoreManager.layer));
 * ```
 */

import { FileSystem, Path } from "@effect/platform";
import { Chunk, Clock, Effect, Exit, Option, Schema, Scope } from "effect";
import * as Reactivity from "@effect/experimental/Reactivity";
import * as Migrator from "@effect/sql/Migrator";
import { storeCatalogMigrations } from "../db/migrations/store-catalog/index.js";
import * as SqlClient from "@effect/sql/SqlClient";
import * as SqlSchema from "@effect/sql/SqlSchema";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { StoreAlreadyExists, StoreIoError, StoreNotFound } from "../domain/errors.js";
import { StoreConfig, StoreMetadata, StoreRef } from "../domain/store.js";
import { StoreName, StorePath } from "../domain/primitives.js";
import { AppConfigService } from "./app-config.js";

const privateDirMode = 0o700;
const privateFileMode = 0o600;


const storeRootKey = (name: StoreName) => `stores/${name}`;
const manifestPath = Schema.decodeUnknownSync(StorePath)("stores");

const storeRow = Schema.Struct({
  name: StoreName,
  root: StorePath,
  created_at: Schema.String,
  updated_at: Schema.String,
  description: Schema.NullOr(Schema.String),
  config_json: Schema.String
});

const toStoreIoError = (path: StorePath) => (cause: unknown) =>
  StoreIoError.make({ path, cause });

const decodeStorePath = (path: string) =>
  Schema.decodeUnknown(StorePath)(path).pipe(
    Effect.mapError(toStoreIoError(manifestPath))
  );

const storeRefFromMetadata = (metadata: StoreMetadata) =>
  StoreRef.make({ name: metadata.name, root: metadata.root });

/**
 * Context tag and Layer implementation for the store manager service.
 * Provides CRUD operations for content stores with SQLite persistence.
 *
 * **Methods:**
 * - createStore: Creates a new store or returns existing if name exists
 * - getStore: Retrieves store reference by name
 * - listStores: Returns all stores sorted by name
 * - getConfig: Gets configuration for a specific store
 * - deleteStore: Removes a store from the catalog
 *
 * **Idempotency:**
 * createStore is idempotent - if a store with the given name already exists,
 * it returns the existing store reference instead of failing.
 *
 * **Error Handling:**
 * All methods return StoreIoError for filesystem or database issues.
 *
 * @example
 * ```typescript
 * // Create and use a store
 * const storeRef = yield* manager.createStore("tech-posts", {
 *   filter: { _tag: "Hashtag", tag: "tech" },
 *   errorPolicy: { _tag: "Retry", maxRetries: 3, baseDelay: Duration.seconds(1) }
 * });
 *
 * // Check if store exists before creating
 * const existing = yield* manager.getStore("tech-posts");
 * if (Option.isNone(existing)) {
 *   yield* manager.createStore("tech-posts", config);
 * }
 *
 * // Cleanup
 * yield* manager.deleteStore("old-store");
 * ```
 */
export class StoreManager extends Effect.Service<StoreManager>()("@skygent/StoreManager", {
  dependencies: [Reactivity.layer],
  scoped: Effect.gen(function* () {
      const appConfig = yield* AppConfigService;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const reactivity = yield* Reactivity.Reactivity;

      const scope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));

      const dbPath = path.join(appConfig.storeRoot, "catalog.sqlite");
      const dbDir = path.dirname(dbPath);
      yield* fs.makeDirectory(dbDir, { recursive: true, mode: privateDirMode });

      const client = yield* SqliteClient.make({ filename: dbPath }).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.provideService(Reactivity.Reactivity, reactivity)
      );
      yield* fs
        .chmod(dbPath, privateFileMode)
        .pipe(Effect.catchAll(() => Effect.void));

      const migrate = Migrator.make({})({
        loader: Migrator.fromRecord(storeCatalogMigrations)
      });
      yield* migrate.pipe(
        Effect.provideService(SqlClient.SqlClient, client)
      );

      const decodeMetadataRow = (row: typeof storeRow.Type) =>
        Schema.decodeUnknown(StoreMetadata)({
          name: row.name,
          root: row.root,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          ...(row.description !== null ? { description: row.description } : {})
        }).pipe(Effect.mapError(toStoreIoError(manifestPath)));

      const decodeConfigRow = (row: typeof storeRow.Type) =>
        Schema.decodeUnknown(Schema.parseJson(StoreConfig))(row.config_json).pipe(
          Effect.mapError(toStoreIoError(manifestPath))
        );

      const encodeConfigJson = (config: StoreConfig) =>
        Schema.encode(Schema.parseJson(StoreConfig))(config).pipe(
          Effect.mapError(toStoreIoError(manifestPath))
        );

      const findStore = SqlSchema.findAll({
        Request: StoreName,
        Result: storeRow,
        execute: (name) =>
          client`SELECT name, root, created_at, updated_at, description, config_json FROM stores WHERE name = ${name}`
      });

      const listStoresSql = SqlSchema.findAll({
        Request: Schema.Void,
        Result: storeRow,
        execute: () =>
          client`SELECT name, root, created_at, updated_at, description, config_json FROM stores ORDER BY name ASC`
      });

      const insertStore = SqlSchema.void({
        Request: storeRow,
        execute: (row) =>
          client`INSERT INTO stores ${client.insert(row)}`
      });

      const deleteStoreSql = SqlSchema.void({
        Request: StoreName,
        execute: (name) =>
          client`DELETE FROM stores WHERE name = ${name}`
      });

      const renameStoreSql = SqlSchema.void({
        Request: Schema.Struct({
          oldName: StoreName,
          newName: StoreName,
          root: StorePath,
          updatedAt: Schema.String
        }),
        execute: ({ oldName, newName, root, updatedAt }) =>
          client`UPDATE stores
            SET name = ${newName},
                root = ${root},
                updated_at = ${updatedAt}
            WHERE name = ${oldName}`
      });

      const updateDescriptionSql = SqlSchema.void({
        Request: Schema.Struct({
          name: StoreName,
          description: Schema.NullOr(Schema.String),
          updatedAt: Schema.String
        }),
        execute: ({ name, description, updatedAt }) =>
          client`UPDATE stores
            SET description = ${description},
                updated_at = ${updatedAt}
            WHERE name = ${name}`
      });

      const createStore = Effect.fn("StoreManager.createStore")(
        (name: StoreName, config: StoreConfig, description?: string) =>
          decodeStorePath(storeRootKey(name)).pipe(
            Effect.flatMap((root) =>
              Effect.gen(function* () {
                const existingRows = yield* findStore(name);
                if (existingRows.length > 0) {
                  const existing = yield* decodeMetadataRow(existingRows[0]!);
                  return storeRefFromMetadata(existing);
                }

                const nowMillis = yield* Clock.currentTimeMillis;
                const now = new Date(nowMillis).toISOString();
                const configJson = yield* encodeConfigJson(config);
                yield* insertStore({
                  name,
                  root,
                  created_at: now,
                  updated_at: now,
                  description: description ?? null,
                  config_json: configJson
                });

                return StoreRef.make({ name, root });
              }).pipe(Effect.mapError(toStoreIoError(root)))
            )
          )
      );

      const getStore = Effect.fn("StoreManager.getStore")((name: StoreName) => {
        return decodeStorePath(storeRootKey(name)).pipe(
          Effect.flatMap((root) =>
            findStore(name).pipe(
              Effect.flatMap((rows) =>
                rows.length === 0
                  ? Effect.succeed(Option.none())
                  : decodeMetadataRow(rows[0]!).pipe(
                      Effect.map((metadata) =>
                        Option.some(storeRefFromMetadata(metadata))
                      )
                    )
              ),
              Effect.mapError(toStoreIoError(root))
            )
          )
        );
      });

      const getConfig = Effect.fn("StoreManager.getConfig")((name: StoreName) => {
        return decodeStorePath(storeRootKey(name)).pipe(
          Effect.flatMap((root) =>
            findStore(name).pipe(
              Effect.flatMap((rows) =>
                rows.length === 0
                  ? Effect.succeed(Option.none())
                  : decodeConfigRow(rows[0]!).pipe(Effect.map(Option.some))
              ),
              Effect.mapError(toStoreIoError(root))
            )
          )
        );
      });

      const getMetadata = Effect.fn("StoreManager.getMetadata")((name: StoreName) => {
        return decodeStorePath(storeRootKey(name)).pipe(
          Effect.flatMap((root) =>
            findStore(name).pipe(
              Effect.flatMap((rows) =>
                rows.length === 0
                  ? Effect.succeed(Option.none())
                  : decodeMetadataRow(rows[0]!).pipe(Effect.map(Option.some))
              ),
              Effect.mapError(toStoreIoError(root))
            )
          )
        );
      });

      const deleteStore = Effect.fn("StoreManager.deleteStore")((name: StoreName) => {
        return decodeStorePath(storeRootKey(name)).pipe(
          Effect.flatMap((root) =>
            deleteStoreSql(name).pipe(Effect.mapError(toStoreIoError(root)))
          )
        );
      });

      const renameStore = Effect.fn("StoreManager.renameStore")(
        (from: StoreName, to: StoreName) =>
          Effect.gen(function* () {
            const newRoot = yield* decodeStorePath(storeRootKey(to));
            const existing = yield* findStore(from).pipe(
              Effect.mapError(toStoreIoError(manifestPath))
            );
            if (existing.length === 0) {
              return yield* StoreNotFound.make({ name: from });
            }
            const conflict = yield* findStore(to).pipe(
              Effect.mapError(toStoreIoError(manifestPath))
            );
            if (conflict.length > 0) {
              return yield* StoreAlreadyExists.make({ name: to });
            }
            const nowMillis = yield* Clock.currentTimeMillis;
            const now = new Date(nowMillis).toISOString();
            yield* renameStoreSql({
              oldName: from,
              newName: to,
              root: newRoot,
              updatedAt: now
            }).pipe(Effect.mapError(toStoreIoError(manifestPath)));
            return StoreRef.make({ name: to, root: newRoot });
          })
      );

      const updateDescription = Effect.fn("StoreManager.updateDescription")(
        (name: StoreName, description: string | null) =>
          Effect.gen(function* () {
            const existingRows = yield* findStore(name).pipe(
              Effect.mapError(toStoreIoError(manifestPath))
            );
            if (existingRows.length === 0) {
              return yield* StoreNotFound.make({ name });
            }
            const nowMillis = yield* Clock.currentTimeMillis;
            const now = new Date(nowMillis).toISOString();
            yield* updateDescriptionSql({
              name,
              description,
              updatedAt: now
            }).pipe(Effect.mapError(toStoreIoError(manifestPath)));
            const base = existingRows[0]!;
            return yield* decodeMetadataRow({
              ...base,
              description,
              updated_at: now
            });
          })
      );

      const listStores = Effect.fn("StoreManager.listStores")(() =>
        Effect.gen(function* () {
          const rows = yield* listStoresSql(undefined);
          if (rows.length === 0) {
            return Chunk.empty<StoreMetadata>();
          }
          const decoded = yield* Effect.forEach(
            rows,
            (row) => decodeMetadataRow(row),
            { discard: false }
          );
          return Chunk.fromIterable(decoded);
        }).pipe(Effect.mapError(toStoreIoError(manifestPath)))
      );

      return {
        createStore,
        getStore,
        listStores,
        getMetadata,
        getConfig,
        deleteStore,
        renameStore,
        updateDescription
      };
    })
}) {
  static readonly layer = StoreManager.Default;
}
