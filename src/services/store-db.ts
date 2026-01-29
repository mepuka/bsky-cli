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

const migrationsDir = decodeURIComponent(
  new URL("../db/migrations/store-index", import.meta.url).pathname
);

const toStoreIoError = (path: StorePath) => (cause: unknown) =>
  StoreIoError.make({ path, cause });

export class StoreDb extends Context.Tag("@skygent/StoreDb")<
  StoreDb,
  {
    readonly withClient: <A, E>(
      store: StoreRef,
      run: (client: SqlClient.SqlClient) => Effect.Effect<A, E>
    ) => Effect.Effect<A, StoreIoError | E>;
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
