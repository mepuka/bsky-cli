import * as KeyValueStore from "@effect/platform/KeyValueStore";
import { Chunk, Context, Effect, Layer, Option, Schema } from "effect";
import { StoreIoError } from "../domain/errors.js";
import { StoreConfig, StoreMetadata, StoreRef } from "../domain/store.js";
import { StoreName, StorePath, Timestamp } from "../domain/primitives.js";

const manifestKey = "stores/manifest";
const metadataKey = (name: StoreName) => `stores/${name}/meta`;
const configKey = (name: StoreName) => `stores/${name}/config`;
const storeRootKey = (name: StoreName) => `stores/${name}`;
const manifestPath = Schema.decodeUnknownSync(StorePath)("stores");

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
  static readonly layer = Layer.effect(
    StoreManager,
    Effect.gen(function* () {
      const kv = yield* KeyValueStore.KeyValueStore;
      const metadata = kv.forSchema(StoreMetadata);
      const configs = kv.forSchema(StoreConfig);
      const manifest = kv.forSchema(Schema.Array(StoreName));
      const createStore = Effect.fn("StoreManager.createStore")(
        (name: StoreName, config: StoreConfig) => {
          const root = Schema.decodeUnknownSync(StorePath)(storeRootKey(name));
          return Effect.gen(function* () {
            const existing = yield* metadata.get(metadataKey(name));
            if (Option.isSome(existing)) {
              const existingConfig = yield* configs.get(configKey(name));
              if (Option.isNone(existingConfig)) {
                yield* configs.set(configKey(name), config);
              }
              return storeRefFromMetadata(existing.value);
            }

            const now = yield* Schema.decodeUnknown(Timestamp)(
              new Date().toISOString()
            );
            const next = StoreMetadata.make({
              name,
              root,
              createdAt: now,
              updatedAt: now
            });
            yield* metadata.set(metadataKey(name), next);
            yield* configs.set(configKey(name), config);

            const updated = yield* manifest.modify(manifestKey, (names) =>
              names.includes(name) ? names : [...names, name]
            );
            if (Option.isNone(updated)) {
              yield* manifest.set(manifestKey, [name]);
            }

            return StoreRef.make({ name, root });
          }).pipe(Effect.mapError(toStoreIoError(root)));
        }
      );

      const getStore = Effect.fn("StoreManager.getStore")((name: StoreName) => {
        const root = Schema.decodeUnknownSync(StorePath)(storeRootKey(name));
        return metadata
          .get(metadataKey(name))
          .pipe(
            Effect.map(Option.map(storeRefFromMetadata)),
            Effect.mapError(toStoreIoError(root))
          );
      });

      const getConfig = Effect.fn("StoreManager.getConfig")((name: StoreName) => {
        const root = Schema.decodeUnknownSync(StorePath)(storeRootKey(name));
        return configs
          .get(configKey(name))
          .pipe(Effect.mapError(toStoreIoError(root)));
      });

      const deleteStore = Effect.fn("StoreManager.deleteStore")((name: StoreName) => {
        const root = Schema.decodeUnknownSync(StorePath)(storeRootKey(name));
        return Effect.gen(function* () {
          yield* metadata.remove(metadataKey(name));
          yield* configs.remove(configKey(name));
          const updated = yield* manifest.modify(manifestKey, (names) =>
            names.filter((entry) => entry !== name)
          );
          if (Option.isNone(updated)) {
            yield* manifest.remove(manifestKey);
          }
        }).pipe(Effect.mapError(toStoreIoError(root)));
      });

      const listStores = Effect.fn("StoreManager.listStores")(() =>
        Effect.gen(function* () {
          const namesOption = yield* manifest.get(manifestKey);
          if (Option.isNone(namesOption)) {
            return Chunk.empty<StoreMetadata>();
          }

          const entries = yield* Effect.forEach(
            namesOption.value,
            (name) => metadata.get(metadataKey(name)),
            { discard: false }
          );

          const present = entries.filter(Option.isSome).map((entry) => entry.value);
          return Chunk.fromIterable(present);
        }).pipe(Effect.mapError(toStoreIoError(manifestPath)))
      );

      return StoreManager.of({ createStore, getStore, listStores, getConfig, deleteStore });
    })
  );
}
