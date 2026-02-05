import { FileSystem, Path } from "@effect/platform";
import { Chunk, Context, Effect, Layer, Option, Ref } from "effect";
import { StoreAlreadyExists, StoreIoError, StoreNotFound } from "../domain/errors.js";
import { StoreLineage, StoreSource } from "../domain/derivation.js";
import { StoreName, type StorePath, storePath } from "../domain/primitives.js";
import { StoreRef } from "../domain/store.js";
import { AppConfigService } from "./app-config.js";
import { LineageStore } from "./lineage-store.js";
import { StoreDb } from "./store-db.js";
import { StoreManager } from "./store-manager.js";

type StoreRenameResult = {
  readonly from: StoreName;
  readonly to: StoreName;
  readonly moved: boolean;
  readonly movedOnDisk: boolean;
  readonly lineagesUpdated: number;
  readonly checkpointsUpdated: number;
};

type RenameState = {
  readonly completed: boolean;
  readonly dirRenamed: boolean;
  readonly catalogUpdated: boolean;
  readonly checkpointsUpdated: boolean;
  readonly lineagesUpdated: boolean;
};

const storeRootKey = (name: StoreName): StorePath =>
  storePath(`stores/${name}`);

const toStoreIoError = (path: StorePath) => (cause: unknown) =>
  StoreIoError.make({ path, cause });

const toStoreRef = (metadata: { readonly name: StoreName; readonly root: StorePath }) =>
  StoreRef.make({ name: metadata.name, root: metadata.root });

const renameDirectory = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  fromPath: string,
  toPath: string
) =>
  Effect.gen(function* () {
    if (fromPath === toPath) {
      return;
    }
    const normalizedFrom = fromPath.toLowerCase();
    const normalizedTo = toPath.toLowerCase();
    if (normalizedFrom === normalizedTo) {
      const tempName = `.rename-${Date.now()}`;
      const tempPath = path.join(path.dirname(toPath), tempName);
      yield* fs.rename(fromPath, tempPath);
      yield* fs.rename(tempPath, toPath).pipe(
        Effect.catchAll((error) =>
          fs
            .rename(tempPath, fromPath)
            .pipe(Effect.catchAll(() => Effect.void), Effect.zipRight(Effect.fail(error)))
        )
      );
      return;
    }
    yield* fs.rename(fromPath, toPath);
  });

const renameLineage = (
  lineage: StoreLineage,
  from: StoreName,
  to: StoreName
) => {
  const nextStoreName = lineage.storeName === from ? to : lineage.storeName;
  let changed = nextStoreName !== lineage.storeName;
  const nextSources = lineage.sources.map((source) => {
    if (source.storeName !== from) {
      return source;
    }
    changed = true;
    return StoreSource.make({ ...source, storeName: to });
  });
  if (!changed) {
    return Option.none<StoreLineage>();
  }
  return Option.some(
    StoreLineage.make({
      ...lineage,
      storeName: nextStoreName,
      sources: nextSources
    })
  );
};

export class StoreRenamer extends Context.Tag("@skygent/StoreRenamer")<
  StoreRenamer,
  {
    readonly rename: (
      from: StoreName,
      to: StoreName
    ) => Effect.Effect<StoreRenameResult, StoreNotFound | StoreAlreadyExists | StoreIoError>;
  }
>() {
  static readonly layer = Layer.effect(
    StoreRenamer,
    Effect.gen(function* () {
      const manager = yield* StoreManager;
      const storeDb = yield* StoreDb;
      const lineageStore = yield* LineageStore;
      const appConfig = yield* AppConfigService;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      const updateLineages = (
        from: StoreName,
        to: StoreName,
        storeNames: ReadonlyArray<StoreName>
      ) =>
        Effect.forEach(
          storeNames,
          (storeName) =>
            lineageStore.get(storeName).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.succeed(0),
                  onSome: (lineage) =>
                    Option.match(renameLineage(lineage, from, to), {
                      onNone: () => Effect.succeed(0),
                      onSome: (updated) =>
                        Effect.gen(function* () {
                          yield* lineageStore.save(updated);
                          if (lineage.storeName === from) {
                            yield* lineageStore.remove(from);
                          }
                          return 1;
                        })
                    })
                })
              )
            ),
          { discard: false }
        ).pipe(Effect.map((updates) => updates.reduce((sum, value) => sum + value, 0)));

      const updateDerivationCheckpoints = (
        from: StoreName,
        to: StoreName,
        stores: ReadonlyArray<StoreRef>
      ) =>
        Effect.forEach(
          stores,
          (store) =>
            storeDb.withClient(store, (client) =>
              client`UPDATE derivation_checkpoints
                SET view_name = CASE WHEN view_name = ${from} THEN ${to} ELSE view_name END,
                    source_store = CASE WHEN source_store = ${from} THEN ${to} ELSE source_store END,
                    target_store = CASE WHEN target_store = ${from} THEN ${to} ELSE target_store END
                WHERE view_name = ${from}
                   OR source_store = ${from}
                   OR target_store = ${from}`.pipe(Effect.as(1))
            ).pipe(Effect.mapError(toStoreIoError(store.root))),
          { discard: false }
        ).pipe(Effect.map((updates) => updates.reduce((sum, value) => sum + value, 0)));

      const rename = Effect.fn("StoreRenamer.rename")(
        (from: StoreName, to: StoreName) =>
          Effect.gen(function* () {
            const storeOption = yield* manager.getStore(from);
            if (Option.isNone(storeOption)) {
              return yield* StoreNotFound.make({ name: from });
            }
            const targetOption = yield* manager.getStore(to);
            if (Option.isSome(targetOption)) {
              return yield* StoreAlreadyExists.make({ name: to });
            }
            const store = storeOption.value;
            const newRoot = storeRootKey(to);
            const fromPath = path.join(appConfig.storeRoot, store.root);
            const toPath = path.join(appConfig.storeRoot, newRoot);
            const fromExists = yield* fs
              .exists(fromPath)
              .pipe(Effect.mapError(toStoreIoError(store.root)));
            const toExists = yield* fs
              .exists(toPath)
              .pipe(Effect.mapError(toStoreIoError(newRoot)));
            if (toExists) {
              return yield* StoreAlreadyExists.make({ name: to });
            }

            const storesBefore = yield* manager.listStores();
            const storeNamesBefore = Chunk.toReadonlyArray(storesBefore).map(
              (entry) => entry.name
            );

            const state = yield* Ref.make<RenameState>({
              completed: false,
              dirRenamed: false,
              catalogUpdated: false,
              checkpointsUpdated: false,
              lineagesUpdated: false
            });

            const rollback = (status: RenameState) =>
              status.completed
                ? Effect.void
                : Effect.gen(function* () {
                    if (status.lineagesUpdated) {
                      const stores = yield* manager.listStores();
                      const storeNames = Chunk.toReadonlyArray(stores).map(
                        (entry) => entry.name
                      );
                      yield* updateLineages(to, from, storeNames).pipe(
                        Effect.catchAll((error) =>
                          Effect.logWarning("Rollback failed: revert lineages", { error })
                        )
                      );
                    }
                    if (status.checkpointsUpdated) {
                      const stores = yield* manager.listStores();
                      const storeRefs = Chunk.toReadonlyArray(stores).map(toStoreRef);
                      yield* updateDerivationCheckpoints(to, from, storeRefs).pipe(
                        Effect.catchAll((error) =>
                          Effect.logWarning("Rollback failed: revert checkpoints", { error })
                        )
                      );
                    }
                    if (status.dirRenamed) {
                      yield* storeDb.removeClient(to);
                      yield* renameDirectory(fs, path, toPath, fromPath).pipe(
                        Effect.catchAll((error) =>
                          Effect.logWarning("Rollback failed: revert directory rename", { error })
                        )
                      );
                    }
                    if (status.catalogUpdated) {
                      yield* manager.renameStore(to, from).pipe(
                        Effect.catchAll((error) =>
                          Effect.logWarning("Rollback failed: revert catalog rename", { error })
                        )
                      );
                    }
                  });

            const program = Effect.gen(function* () {
              yield* storeDb.removeClient(from);

              if (fromExists) {
                yield* renameDirectory(fs, path, fromPath, toPath).pipe(
                  Effect.mapError(toStoreIoError(store.root))
                );
                yield* Ref.update(state, (current) => ({ ...current, dirRenamed: true }));
              }

              yield* manager.renameStore(from, to);
              yield* Ref.update(state, (current) => ({
                ...current,
                catalogUpdated: true
              }));

              const storesAfter = yield* manager.listStores();
              const storeRefsAfter = Chunk.toReadonlyArray(storesAfter).map(toStoreRef);

              const checkpointsUpdated = yield* updateDerivationCheckpoints(
                from,
                to,
                storeRefsAfter
              );
              yield* Ref.update(state, (current) => ({
                ...current,
                checkpointsUpdated: true
              }));

              const lineagesUpdated = yield* updateLineages(from, to, storeNamesBefore);
              yield* Ref.update(state, (current) => ({
                ...current,
                lineagesUpdated: true
              }));

              yield* Ref.update(state, (current) => ({ ...current, completed: true }));

              return {
                from,
                to,
                moved: true,
                movedOnDisk: fromExists,
                lineagesUpdated,
                checkpointsUpdated
              } satisfies StoreRenameResult;
            });

            return yield* program.pipe(
              Effect.ensuring(
                Ref.get(state).pipe(
                  Effect.flatMap(rollback),
                  Effect.catchAll((error) =>
                    Effect.logWarning("Rename rollback encountered errors", { error })
                  ),
                  Effect.uninterruptible
                )
              )
            );
          })
      );

      return StoreRenamer.of({ rename });
    })
  );
}
