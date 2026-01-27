import * as KeyValueStore from "@effect/platform/KeyValueStore";
import type { PlatformError } from "@effect/platform/Error";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { DerivationCheckpoint } from "../domain/derivation.js";
import { StoreName, StorePath } from "../domain/primitives.js";
import { StoreIoError } from "../domain/errors.js";

const checkpointKey = (viewName: StoreName, sourceName: StoreName) =>
  `stores/${viewName}/checkpoints/derivation/${sourceName}`;

const toStoreIoError = (viewName: StoreName, sourceName: StoreName) => (cause: unknown) => {
  const path = Schema.decodeUnknownSync(StorePath)(
    `stores/${viewName}/checkpoints/derivation/${sourceName}`
  );
  return StoreIoError.make({ path, cause });
};

export class ViewCheckpointStore extends Context.Tag("@skygent/ViewCheckpointStore")<
  ViewCheckpointStore,
  {
    readonly load: (
      viewName: StoreName,
      sourceName: StoreName
    ) => Effect.Effect<Option.Option<DerivationCheckpoint>, StoreIoError>;
    readonly save: (
      checkpoint: DerivationCheckpoint
    ) => Effect.Effect<void, StoreIoError>;
    readonly remove: (
      viewName: StoreName,
      sourceName: StoreName
    ) => Effect.Effect<void, StoreIoError>;
  }
>() {
  static readonly layer = Layer.effect(
    ViewCheckpointStore,
    Effect.gen(function* () {
      const kv = yield* KeyValueStore.KeyValueStore;
      const checkpoints = kv.forSchema(DerivationCheckpoint);

      const load = Effect.fn("ViewCheckpointStore.load")(
        (viewName: StoreName, sourceName: StoreName) =>
          checkpoints.get(checkpointKey(viewName, sourceName)).pipe(
            Effect.mapError(toStoreIoError(viewName, sourceName))
          )
      );

      const save = Effect.fn("ViewCheckpointStore.save")(
        (checkpoint: DerivationCheckpoint) =>
          checkpoints
            .set(
              checkpointKey(checkpoint.viewName, checkpoint.sourceStore),
              checkpoint
            )
            .pipe(
              Effect.mapError(
                toStoreIoError(checkpoint.viewName, checkpoint.sourceStore)
              )
            )
      );

      const remove = Effect.fn("ViewCheckpointStore.remove")(
        (viewName: StoreName, sourceName: StoreName) =>
          checkpoints
            .remove(checkpointKey(viewName, sourceName))
            .pipe(
              Effect.catchAll((error: PlatformError) =>
                error._tag === "SystemError" && error.reason === "NotFound"
                  ? Effect.void
                  : Effect.fail(error)
              ),
              Effect.mapError(toStoreIoError(viewName, sourceName))
            )
      );

      return ViewCheckpointStore.of({ load, save, remove });
    })
  );
}
