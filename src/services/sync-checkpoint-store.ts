import * as KeyValueStore from "@effect/platform/KeyValueStore";
import { Context, Effect, Layer, Option } from "effect";
import { StoreIoError } from "../domain/errors.js";
import { SyncCheckpoint, type DataSource, dataSourceKey } from "../domain/sync.js";
import type { StorePath } from "../domain/primitives.js";
import type { StoreRef } from "../domain/store.js";
import { storePrefix } from "./store-keys.js";

const checkpointKey = (source: DataSource) =>
  `checkpoints/sync/${dataSourceKey(source)}`;

const toStoreIoError = (path: StorePath) => (cause: unknown) =>
  StoreIoError.make({ path, cause });

export class SyncCheckpointStore extends Context.Tag("@skygent/SyncCheckpointStore")<
  SyncCheckpointStore,
  {
    readonly load: (
      store: StoreRef,
      source: DataSource
    ) => Effect.Effect<Option.Option<SyncCheckpoint>, StoreIoError>;
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
