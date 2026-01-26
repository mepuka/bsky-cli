import * as KeyValueStore from "@effect/platform/KeyValueStore";
import { Context, Effect, Layer, Option, Schema, Stream } from "effect";
import { StoreIoError } from "../domain/errors.js";
import { PostEventRecord } from "../domain/events.js";
import { EventId } from "../domain/primitives.js";
import type { StorePath } from "../domain/primitives.js";
import type { StoreRef } from "../domain/store.js";
import { storePrefix } from "./store-keys.js";

const manifestKey = "events/manifest";
const lastEventIdKey = "events/last-id";

const toStoreIoError = (path: StorePath) => (cause: unknown) =>
  StoreIoError.make({ path, cause });

export class StoreEventLog extends Context.Tag("@skygent/StoreEventLog")<
  StoreEventLog,
  {
    readonly stream: (
      store: StoreRef
    ) => Stream.Stream<PostEventRecord, StoreIoError>;
    readonly clear: (store: StoreRef) => Effect.Effect<void, StoreIoError>;
    readonly getLastEventId: (
      store: StoreRef
    ) => Effect.Effect<Option.Option<EventId>, StoreIoError>;
  }
>() {
  static readonly layer = Layer.effect(
    StoreEventLog,
    Effect.gen(function* () {
      const kv = yield* KeyValueStore.KeyValueStore;
      const events = kv.forSchema(PostEventRecord);
      const manifest = kv.forSchema(Schema.Array(Schema.String));
      const lastEventId = kv.forSchema(EventId);

      const stream = (store: StoreRef) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const prefix = storePrefix(store);
            const storeManifest = KeyValueStore.prefix(manifest, prefix);
            const storeEvents = KeyValueStore.prefix(events, prefix);
            const keysOption = yield* storeManifest
              .get(manifestKey)
              .pipe(Effect.mapError(toStoreIoError(store.root)));
            if (Option.isNone(keysOption)) {
              return Stream.empty;
            }
            return Stream.fromIterable(keysOption.value).pipe(
              Stream.mapEffect((key) =>
                storeEvents.get(key).pipe(Effect.mapError(toStoreIoError(store.root)))
              ),
              Stream.filterMap((record) => record)
            );
          })
        );

      const clear = Effect.fn("StoreEventLog.clear")((store: StoreRef) =>
        Effect.gen(function* () {
          const prefix = storePrefix(store);
          const storeManifest = KeyValueStore.prefix(manifest, prefix);
          const storeEvents = KeyValueStore.prefix(events, prefix);
          const storeLastEventId = KeyValueStore.prefix(lastEventId, prefix);
          const keysOption = yield* storeManifest
            .get(manifestKey)
            .pipe(Effect.mapError(toStoreIoError(store.root)));
          if (Option.isSome(keysOption)) {
            yield* Effect.forEach(
              keysOption.value,
              (key) => storeEvents.remove(key),
              { discard: true }
            );
          }
          yield* storeManifest.remove(manifestKey);
          yield* storeLastEventId.remove(lastEventIdKey);
        }).pipe(Effect.mapError(toStoreIoError(store.root)))
      );

      const getLastEventId = Effect.fn("StoreEventLog.getLastEventId")(
        (store: StoreRef) =>
          KeyValueStore.prefix(lastEventId, storePrefix(store))
            .get(lastEventIdKey)
            .pipe(Effect.mapError(toStoreIoError(store.root)))
      );

      return StoreEventLog.of({ stream, clear, getLastEventId });
    })
  );
}
