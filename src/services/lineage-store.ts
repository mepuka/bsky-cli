import * as KeyValueStore from "@effect/platform/KeyValueStore";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { StoreLineage } from "../domain/derivation.js";
import { StoreName, StorePath } from "../domain/primitives.js";
import { StoreIoError } from "../domain/errors.js";

const lineageKey = (storeName: StoreName) => `stores/${storeName}/lineage`;

const toStoreIoError = (storeName: StoreName) => (cause: unknown) => {
  const path = Schema.decodeUnknownSync(StorePath)(`stores/${storeName}/lineage`);
  return StoreIoError.make({ path, cause });
};

export class LineageStore extends Context.Tag("@skygent/LineageStore")<
  LineageStore,
  {
    readonly get: (
      storeName: StoreName
    ) => Effect.Effect<Option.Option<StoreLineage>, StoreIoError>;
    readonly save: (lineage: StoreLineage) => Effect.Effect<void, StoreIoError>;
  }
>() {
  static readonly layer = Layer.effect(
    LineageStore,
    Effect.gen(function* () {
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

      return LineageStore.of({ get, save });
    })
  );
}
