import { Context, Effect, Layer, Option, Schema } from "effect";
import type { StoreRef } from "../domain/store.js";
import { StoreSourcesError, isStoreSourcesError } from "../domain/errors.js";
import type { StoreIoError } from "../domain/errors.js";
import { StoreSourceSchema, type StoreSource, storeSourceId } from "../domain/store-sources.js";
import { Timestamp } from "../domain/primitives.js";
import { StoreDb } from "./store-db.js";
import { messageFromCause } from "./shared.js";

const toStoreSourcesError = (message: string, operation?: string) => (cause: unknown) => {
  if (isStoreSourcesError(cause)) {
    return cause;
  }
  return StoreSourcesError.make({
    message: messageFromCause(message, cause),
    cause,
    ...(operation ? { operation } : {})
  });
};

const toIso = (value: Date | string) =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const decodeSource = (raw: string) =>
  Schema.decodeUnknown(Schema.parseJson(StoreSourceSchema))(raw).pipe(
    Effect.mapError(toStoreSourcesError("StoreSources decode failed", "storeSourcesDecode"))
  );

const encodeSource = (source: StoreSource) =>
  Schema.encode(Schema.parseJson(StoreSourceSchema))(source).pipe(
    Effect.mapError(toStoreSourcesError("StoreSources encode failed", "storeSourcesEncode"))
  );

const sourceType = (source: StoreSource) => source._tag;

const sourceValue = (source: StoreSource) => {
  switch (source._tag) {
    case "AuthorSource":
      return source.actor;
    case "FeedSource":
      return source.uri;
    case "ListSource":
      return source.uri;
    case "TimelineSource":
      return "timeline";
    case "JetstreamSource":
      return "jetstream";
  }
};

export class StoreSources extends Context.Tag("@skygent/StoreSources")<
  StoreSources,
  {
    readonly list: (store: StoreRef) => Effect.Effect<ReadonlyArray<StoreSource>, StoreIoError | StoreSourcesError>;
    readonly get: (store: StoreRef, id: string) => Effect.Effect<Option.Option<StoreSource>, StoreIoError | StoreSourcesError>;
    readonly add: (store: StoreRef, source: StoreSource) => Effect.Effect<StoreSource, StoreIoError | StoreSourcesError>;
    readonly remove: (store: StoreRef, id: string) => Effect.Effect<void, StoreIoError | StoreSourcesError>;
    readonly setEnabled: (store: StoreRef, id: string, enabled: boolean) => Effect.Effect<void, StoreIoError | StoreSourcesError>;
    readonly markSynced: (store: StoreRef, id: string, at: Date) => Effect.Effect<void, StoreIoError | StoreSourcesError>;
  }
>() {
  static readonly layer = Layer.effect(
    StoreSources,
    Effect.gen(function* () {
      const storeDb = yield* StoreDb;

      const list = Effect.fn("StoreSources.list")((store: StoreRef) =>
        storeDb
          .withClient(store, (client) =>
            Effect.gen(function* () {
              const rows = yield* client`SELECT source_json FROM store_sources ORDER BY added_at ASC`.pipe(
                Effect.mapError(
                  toStoreSourcesError("StoreSources.list query failed", "storeSourcesList")
                )
              );
              if (rows.length === 0) {
                return [] as ReadonlyArray<StoreSource>;
              }
              const decoded = yield* Schema.decodeUnknown(Schema.Array(Schema.Struct({
                source_json: Schema.String
              })))(rows).pipe(
                Effect.mapError(toStoreSourcesError("StoreSources.list decode failed", "storeSourcesList"))
              );
              return yield* Effect.forEach(
                decoded,
                (row) => decodeSource(row.source_json),
                { discard: false }
              );
            })
          )
      );

      const get = Effect.fn("StoreSources.get")((store: StoreRef, id: string) =>
        storeDb
          .withClient(store, (client) =>
            Effect.gen(function* () {
              const rows = yield* client`SELECT source_json FROM store_sources WHERE id = ${id}`.pipe(
                Effect.mapError(
                  toStoreSourcesError("StoreSources.get query failed", "storeSourcesGet")
                )
              );
              if (rows.length === 0) {
                return Option.none<StoreSource>();
              }
              const decoded = yield* Schema.decodeUnknown(
                Schema.Array(Schema.Struct({ source_json: Schema.String }))
              )(rows).pipe(
                Effect.mapError(toStoreSourcesError("StoreSources.get decode failed", "storeSourcesGet"))
              );
              const row = decoded[0]!;
              const source = yield* decodeSource(row.source_json);
              return Option.some(source);
            })
          )
      );

      const add = Effect.fn("StoreSources.add")((store: StoreRef, source: StoreSource) =>
        storeDb
          .withClient(store, (client) =>
            Effect.gen(function* () {
              const id = storeSourceId(source);
              const payload = yield* encodeSource(source);
              const addedAt = toIso(source.addedAt);
              const lastSyncedAt = source.lastSyncedAt ? toIso(source.lastSyncedAt) : null;
              const enabled = source.enabled ? 1 : 0;
              const type = sourceType(source);
              const value = sourceValue(source);

              yield* client`INSERT INTO store_sources (id, type, source, source_json, added_at, last_synced_at, enabled)
                VALUES (${id}, ${type}, ${value}, ${payload}, ${addedAt}, ${lastSyncedAt}, ${enabled})
                ON CONFLICT(id) DO UPDATE SET
                  type = excluded.type,
                  source = excluded.source,
                  source_json = excluded.source_json,
                  added_at = excluded.added_at,
                  last_synced_at = excluded.last_synced_at,
                  enabled = excluded.enabled`.pipe(
                    Effect.mapError(
                      toStoreSourcesError("StoreSources.add failed", "storeSourcesAdd")
                    )
                  );
              return source;
            })
          )
      );

      const remove = Effect.fn("StoreSources.remove")((store: StoreRef, id: string) =>
        storeDb
          .withClient(store, (client) =>
            client`DELETE FROM store_sources WHERE id = ${id}`.pipe(
              Effect.mapError(toStoreSourcesError("StoreSources.remove failed", "storeSourcesRemove"))
            )
          )
      );

      const updateSource = (
        store: StoreRef,
        id: string,
        update: (current: StoreSource) => StoreSource
      ) =>
        storeDb
          .withClient(store, (client) =>
            Effect.gen(function* () {
              const rows = yield* client`SELECT source_json FROM store_sources WHERE id = ${id}`.pipe(
                Effect.mapError(
                  toStoreSourcesError("StoreSources.update query failed", "storeSourcesUpdate")
                )
              );
              if (rows.length === 0) {
                return yield* Effect.fail(
                  StoreSourcesError.make({
                    message: `Source not found: ${id}`,
                    operation: "storeSourcesUpdate"
                  })
                );
              }
              const decoded = yield* Schema.decodeUnknown(
                Schema.Array(Schema.Struct({ source_json: Schema.String }))
              )(rows).pipe(
                Effect.mapError(toStoreSourcesError("StoreSources.update decode failed", "storeSourcesUpdate"))
              );
              const current = yield* decodeSource(decoded[0]!.source_json);
              const next = update(current);
              const payload = yield* encodeSource(next);
              const addedAt = toIso(next.addedAt);
              const lastSyncedAt = next.lastSyncedAt ? toIso(next.lastSyncedAt) : null;
              const enabled = next.enabled ? 1 : 0;
              const type = sourceType(next);
              const value = sourceValue(next);
              yield* client`UPDATE store_sources
                SET type = ${type},
                    source = ${value},
                    source_json = ${payload},
                    added_at = ${addedAt},
                    last_synced_at = ${lastSyncedAt},
                    enabled = ${enabled}
                WHERE id = ${id}`.pipe(
                  Effect.mapError(
                    toStoreSourcesError("StoreSources.update failed", "storeSourcesUpdate")
                  )
                );
            })
          );

      const setEnabled = Effect.fn("StoreSources.setEnabled")(
        (store: StoreRef, id: string, enabled: boolean) =>
          updateSource(store, id, (source) => ({ ...source, enabled }))
      );

      const markSynced = Effect.fn("StoreSources.markSynced")(
        (store: StoreRef, id: string, at: Date) =>
          Schema.decodeUnknown(Timestamp)(at).pipe(
            Effect.mapError(
              toStoreSourcesError("StoreSources.markSynced failed", "storeSourcesMarkSynced")
            ),
            Effect.flatMap((timestamp) =>
              updateSource(store, id, (source) => ({
                ...source,
                lastSyncedAt: timestamp
              }))
            )
          )
      );

      return StoreSources.of({ list, get, add, remove, setEnabled, markSynced });
    })
  );
}
