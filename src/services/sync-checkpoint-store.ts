/**
 * Sync Checkpoint Store Service
 *
 * Manages checkpoints for sync operations to enable resumable data synchronization.
 * Stores the last sync position (cursor/timestamp) for each data source, allowing
 * sync operations to resume from where they left off rather than starting over.
 *
 * Checkpoints are stored per-store and per-data-source combination, using a
 * prefixed key-value store structure for isolation.
 *
 * @module services/sync-checkpoint-store
 */

import { Effect, Option, Schema } from "effect";
import { StoreIoError } from "../domain/errors.js";
import { DataSourceSchema, SyncCheckpoint, type DataSource, dataSourceKey } from "../domain/sync.js";
import { EventSeq, Timestamp, type StorePath } from "../domain/primitives.js";
import type { StoreRef } from "../domain/store.js";
import { StoreDb } from "./store-db.js";

/**
 * Converts an error to a StoreIoError with the given path.
 * @param path - The store path for error context
 * @returns A function that creates StoreIoError from any cause
 */
const toStoreIoError = (path: StorePath) => (cause: unknown) =>
  StoreIoError.make({ path, cause });

const checkpointRow = Schema.Struct({
  source_key: Schema.String,
  source_json: Schema.String,
  cursor: Schema.NullOr(Schema.String),
  last_event_seq: Schema.NullOr(EventSeq),
  filter_hash: Schema.NullOr(Schema.String),
  updated_at: Schema.String
});

const decodeSource = (raw: string) =>
  Schema.decodeUnknown(Schema.parseJson(DataSourceSchema))(raw);

const encodeSource = (source: DataSource) =>
  Schema.encode(Schema.parseJson(DataSourceSchema))(source);

/**
 * Service for managing sync operation checkpoints.
 *
 * This service provides methods to load and save sync checkpoints, which track
 * the last successfully processed position for each data source. This enables
 * resumable sync operations that can pick up where they left off.
 */
export class SyncCheckpointStore extends Effect.Service<SyncCheckpointStore>()("@skygent/SyncCheckpointStore", {
  effect: Effect.gen(function* () {
      const storeDb = yield* StoreDb;

      const load = Effect.fn("SyncCheckpointStore.load")(
        (store: StoreRef, source: DataSource) => {
          const key = dataSourceKey(source);
          return storeDb
            .withClient(store, (client) =>
              Effect.gen(function* () {
                const rows = yield* client`SELECT
                    source_key,
                    source_json,
                    cursor,
                    last_event_seq,
                    filter_hash,
                    updated_at
                  FROM sync_checkpoints
                  WHERE source_key = ${key}`;
                if (rows.length === 0) {
                  return Option.none<SyncCheckpoint>();
                }
                const decodedRows = yield* Schema.decodeUnknown(
                  Schema.Array(checkpointRow)
                )(rows);
                const row = decodedRows[0]!;
                const decodedSource = yield* decodeSource(row.source_json);
                const updatedAt = yield* Schema.decodeUnknown(Timestamp)(row.updated_at);
                const checkpoint = SyncCheckpoint.make({
                  source: decodedSource,
                  cursor: row.cursor ?? undefined,
                  lastEventSeq: row.last_event_seq ?? undefined,
                  filterHash: row.filter_hash ?? undefined,
                  updatedAt
                });
                return Option.some(checkpoint);
              })
            )
            .pipe(Effect.mapError(toStoreIoError(store.root)));
        }
      );

      const save = Effect.fn("SyncCheckpointStore.save")(
        (store: StoreRef, checkpoint: SyncCheckpoint) => {
          const key = dataSourceKey(checkpoint.source);
          return storeDb
            .withClient(store, (client) =>
              Effect.gen(function* () {
                const sourceJson = yield* encodeSource(checkpoint.source);
                const updatedAt = checkpoint.updatedAt.toISOString();
                const lastSeq = checkpoint.lastEventSeq ?? null;
                const cursor = checkpoint.cursor ?? null;
                const filterHash = checkpoint.filterHash ?? null;
                yield* client`INSERT INTO sync_checkpoints (
                    source_key,
                    source_json,
                    cursor,
                    last_event_seq,
                    filter_hash,
                    updated_at
                  )
                  VALUES (
                    ${key},
                    ${sourceJson},
                    ${cursor},
                    ${lastSeq},
                    ${filterHash},
                    ${updatedAt}
                  )
                  ON CONFLICT(source_key) DO UPDATE SET
                    source_json = excluded.source_json,
                    cursor = excluded.cursor,
                    filter_hash = excluded.filter_hash,
                    updated_at = excluded.updated_at,
                    last_event_seq = CASE
                      WHEN excluded.last_event_seq IS NULL THEN sync_checkpoints.last_event_seq
                      WHEN sync_checkpoints.last_event_seq IS NULL THEN excluded.last_event_seq
                      WHEN excluded.last_event_seq >= sync_checkpoints.last_event_seq THEN excluded.last_event_seq
                      ELSE sync_checkpoints.last_event_seq
                    END`;
              })
            )
            .pipe(Effect.mapError(toStoreIoError(store.root)));
        }
      );

      return { load, save };
    })
}) {
  static readonly layer = SyncCheckpointStore.Default;
}
