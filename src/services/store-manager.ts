import { FileSystem, Path } from "@effect/platform";
import { Chunk, Context, Effect, Exit, Layer, Option, Schema, Scope } from "effect";
import * as Reactivity from "@effect/experimental/Reactivity";
import * as Migrator from "@effect/sql/Migrator";
import * as MigratorFileSystem from "@effect/sql/Migrator/FileSystem";
import * as SqlClient from "@effect/sql/SqlClient";
import * as SqlSchema from "@effect/sql/SqlSchema";
import { SqliteClient } from "@effect/sql-sqlite-bun";
import { StoreIoError } from "../domain/errors.js";
import { StoreConfig, StoreMetadata, StoreRef } from "../domain/store.js";
import { StoreName, StorePath } from "../domain/primitives.js";
import { AppConfigService } from "./app-config.js";

const migrationsDir = decodeURIComponent(
  new URL("../db/migrations/store-catalog", import.meta.url).pathname
);

const storeRootKey = (name: StoreName) => `stores/${name}`;
const manifestPath = Schema.decodeUnknownSync(StorePath)("stores");

const storeRow = Schema.Struct({
  name: StoreName,
  root: StorePath,
  created_at: Schema.String,
  updated_at: Schema.String,
  config_json: Schema.String
});

const toStoreIoError = (path: StorePath) => (cause: unknown) =>
  StoreIoError.make({ path, cause });

const storeRefFromMetadata = (metadata: StoreMetadata) =>
  StoreRef.make({ name: metadata.name, root: metadata.root });

export class StoreManager extends Context.Tag("@skygent/StoreManager")<
  StoreManager,
  {
    readonly createStore: (
      name: StoreName,
      config: StoreConfig
    ) => Effect.Effect<StoreRef, StoreIoError>;
    readonly getStore: (
      name: StoreName
    ) => Effect.Effect<Option.Option<StoreRef>, StoreIoError>;
    readonly listStores: () => Effect.Effect<Chunk.Chunk<StoreMetadata>, StoreIoError>;
    readonly getConfig: (
      name: StoreName
    ) => Effect.Effect<Option.Option<StoreConfig>, StoreIoError>;
    readonly deleteStore: (
      name: StoreName
    ) => Effect.Effect<void, StoreIoError>;
  }
>() {
  static readonly layer = Layer.scoped(
    StoreManager,
    Effect.gen(function* () {
      const appConfig = yield* AppConfigService;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const reactivity = yield* Reactivity.Reactivity;

      const scope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));

      const dbPath = path.join(appConfig.storeRoot, "catalog.sqlite");
      const dbDir = path.dirname(dbPath);
      yield* fs.makeDirectory(dbDir, { recursive: true });

      const client = yield* SqliteClient.make({ filename: dbPath }).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.provideService(Reactivity.Reactivity, reactivity)
      );

      const migrate = Migrator.make({})({
        loader: MigratorFileSystem.fromFileSystem(migrationsDir)
      });
      yield* migrate.pipe(
        Effect.provideService(SqlClient.SqlClient, client),
        Effect.provideService(FileSystem.FileSystem, fs)
      );

      const decodeMetadataRow = (row: typeof storeRow.Type) =>
        Schema.decodeUnknown(StoreMetadata)({
          name: row.name,
          root: row.root,
          createdAt: row.created_at,
          updatedAt: row.updated_at
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
          client`SELECT name, root, created_at, updated_at, config_json FROM stores WHERE name = ${name}`
      });

      const listStoresSql = SqlSchema.findAll({
        Request: Schema.Void,
        Result: storeRow,
        execute: () =>
          client`SELECT name, root, created_at, updated_at, config_json FROM stores ORDER BY name ASC`
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

      const createStore = Effect.fn("StoreManager.createStore")(
        (name: StoreName, config: StoreConfig) => {
          const root = Schema.decodeUnknownSync(StorePath)(storeRootKey(name));
          return Effect.gen(function* () {
            const existingRows = yield* findStore(name);
            if (existingRows.length > 0) {
              const existing = yield* decodeMetadataRow(existingRows[0]!);
              return storeRefFromMetadata(existing);
            }

            const now = new Date().toISOString();
            const configJson = yield* encodeConfigJson(config);
            yield* insertStore({
              name,
              root,
              created_at: now,
              updated_at: now,
              config_json: configJson
            });

            return StoreRef.make({ name, root });
          }).pipe(Effect.mapError(toStoreIoError(root)));
        }
      );

      const getStore = Effect.fn("StoreManager.getStore")((name: StoreName) => {
        const root = Schema.decodeUnknownSync(StorePath)(storeRootKey(name));
        return findStore(name).pipe(
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
        );
      });

      const getConfig = Effect.fn("StoreManager.getConfig")((name: StoreName) => {
        const root = Schema.decodeUnknownSync(StorePath)(storeRootKey(name));
        return findStore(name).pipe(
          Effect.flatMap((rows) =>
            rows.length === 0
              ? Effect.succeed(Option.none())
              : decodeConfigRow(rows[0]!).pipe(Effect.map(Option.some))
          ),
          Effect.mapError(toStoreIoError(root))
        );
      });

      const deleteStore = Effect.fn("StoreManager.deleteStore")((name: StoreName) => {
        const root = Schema.decodeUnknownSync(StorePath)(storeRootKey(name));
        return deleteStoreSql(name).pipe(Effect.mapError(toStoreIoError(root)));
      });

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

      return StoreManager.of({ createStore, getStore, listStores, getConfig, deleteStore });
    })
  ).pipe(Layer.provide(Reactivity.layer));
}
