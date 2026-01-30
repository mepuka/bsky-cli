import { Context, Effect, Layer, Option, ParseResult, Schema, Stream } from "effect";
import * as SqlSchema from "@effect/sql/SqlSchema";
import { StoreIoError } from "../domain/errors.js";
import { type EventLogEntry, PostEventRecord } from "../domain/events.js";
import { EventSeq } from "../domain/primitives.js";
import type { StorePath } from "../domain/primitives.js";
import type { StoreRef } from "../domain/store.js";
import { StoreDb } from "./store-db.js";

/**
 * Store Event Log Service
 *
 * This module provides event sourcing capabilities for stores by streaming events
 * from the SQLite `event_log` table. It implements an append-only event log pattern
 * for tracking all changes to a store's data, enabling event-driven architectures,
 * audit trails, and data synchronization.
 *
 * Key features:
 * - Paginated event streaming with configurable batch size (500 events per page)
 * - Automatic event sequence tracking for resumable streams
 * - JSON event payload serialization/deserialization
 * - Event log clearing for data reset scenarios
 * - Efficient last event sequence retrieval from the event log table
 *
 * The service supports the event sourcing pattern where all state changes are stored
 * as immutable events, allowing for event replay, projections, and temporal queries.
 *
 * @example
 * ```typescript
 * import { Effect, Stream } from "effect";
 * import { StoreEventLog } from "./services/store-event-log.js";
 * import type { StoreRef } from "./domain/store.js";
 *
 * const program = Effect.gen(function* () {
 *   const eventLog = yield* StoreEventLog;
 *   const store: StoreRef = { name: "myStore", root: "stores/myStore" };
 *
 *   // Stream all events from the store
 *   const events = yield* eventLog.stream(store).pipe(
 *     Stream.runCollect
 *   );
 *
 *   // Get the last event sequence for resuming streams
 *   const lastSeq = yield* eventLog.getLastEventSeq(store);
 *
 *   // Clear the event log (use with caution)
 *   yield* eventLog.clear(store);
 * });
 *
 * const runnable = program.pipe(Effect.provide(StoreEventLog.layer));
 * ```
 *
 * @module services/store-event-log
 */

const pageSize = 500;

const eventLogRow = Schema.Struct({
  event_seq: EventSeq,
  payload_json: Schema.String
});

const lastEventSeqRow = Schema.Struct({
  value: EventSeq
});

const decodeEventJson = (raw: string) =>
  Schema.decodeUnknown(Schema.parseJson(PostEventRecord))(raw);

const toStoreIoError = (path: StorePath) => (cause: unknown) =>
  StoreIoError.make({ path, cause });

/**
 * Service for managing and streaming store event logs.
 *
 * Provides event sourcing capabilities with paginated streaming, event
 * tracking, and log management. Events are stored as JSON payloads in an
 * SQLite table with sequential event numbers for ordering.
 *
 * @example
 * ```typescript
 * // Stream all events from a store
 * const events = yield* eventLog.stream(store).pipe(
 *   Stream.runCollect
 * );
 *
 * // Process events incrementally
 * yield* eventLog.stream(store).pipe(
 *   Stream.tap((event) => Effect.sync(() => console.log(event))),
 *   Stream.runDrain
 * );
 * ```
 */
export class StoreEventLog extends Context.Tag("@skygent/StoreEventLog")<
  StoreEventLog,
  {
    /**
     * Stream all events from a store's event log.
     *
     * Returns a Stream that emits all `PostEventRecord` events from the store's
     * event_log table in ascending order by event_seq. Events are fetched in
     * paginated batches of 500 for memory efficiency. The stream automatically
     * handles pagination and continues until all events are emitted.
     *
     * @param store - Store reference to stream events from
     * @returns Stream of PostEventRecord events, failing with StoreIoError on database errors
     * @example
     * ```typescript
     * // Collect all events into an array
     * const allEvents = yield* eventLog.stream(store).pipe(
     *   Stream.runCollect
     * );
     *
     * // Process events with backpressure
     * yield* eventLog.stream(store).pipe(
     *   Stream.grouped(10),
     *   Stream.tap((batch) => processBatch(batch)),
     *   Stream.runDrain
     * );
     * ```
     */
    readonly stream: (
      store: StoreRef
    ) => Stream.Stream<EventLogEntry, StoreIoError>;

    /**
     * Clear all events from a store's event log.
     *
     * Deletes all records from the event_log table.
     * This operation is irreversible and should be used with caution, typically
     * for data resets or re-initialization scenarios.
     *
     * @param store - Store reference whose event log should be cleared
     * @returns Effect that completes when the event log is cleared, failing with StoreIoError
     * @example
     * ```typescript
     * // Clear the event log before re-syncing
     * yield* eventLog.clear(store);
     * // Now ready to start fresh event sourcing
     * ```
     */
    readonly clear: (store: StoreRef) => Effect.Effect<void, StoreIoError>;

    /**
     * Retrieve the last event sequence from a store's event log.
     *
     * Queries the event_log table directly for the highest event_seq.
     * Returns None if no events exist.
     *
     * This is useful for resuming event streams from a known position.
     *
     * @param store - Store reference to get the last event sequence from
     * @returns Effect containing Option of EventSeq (None if no events), failing with StoreIoError
     * @example
     * ```typescript
     * // Get last event sequence for incremental processing
     * const lastSeq = yield* eventLog.getLastEventSeq(store);
     *
     * // Use with Option.match to handle empty event log
     * yield* Option.match(lastId, {
     *   onNone: () => syncAllEvents(),
     *   onSome: (id) => syncEventsSince(id)
     * });
     * ```
     */
    readonly getLastEventSeq: (
      store: StoreRef
    ) => Effect.Effect<Option.Option<EventSeq>, StoreIoError>;
  }
>() {
  static readonly layer = Layer.effect(
    StoreEventLog,
    Effect.gen(function* () {
      const storeDb = yield* StoreDb;

      const stream = (store: StoreRef) =>
        Stream.unwrap(
          storeDb.withClient(store, (client) =>
            Effect.gen(function* () {
              const firstPage = SqlSchema.findAll({
                Request: Schema.Void,
                Result: eventLogRow,
                execute: () =>
                  client`SELECT event_seq, payload_json
                    FROM event_log
                    ORDER BY event_seq ASC
                    LIMIT ${pageSize}`
              });
              const nextPage = SqlSchema.findAll({
                Request: EventSeq,
                Result: eventLogRow,
                execute: (after) =>
                  client`SELECT event_seq, payload_json
                    FROM event_log
                    WHERE event_seq > ${after}
                    ORDER BY event_seq ASC
                    LIMIT ${pageSize}`
              });

              const decodeRows = (rows: ReadonlyArray<typeof eventLogRow.Type>) =>
                Effect.forEach(
                  rows,
                  (row) =>
                    decodeEventJson(row.payload_json).pipe(
                      Effect.map((record) => ({
                        seq: row.event_seq,
                        record
                      }) satisfies EventLogEntry)
                    ),
                  { discard: false }
                );

              const toPage = (
                rows: ReadonlyArray<typeof eventLogRow.Type>
              ): Effect.Effect<
                Option.Option<readonly [ReadonlyArray<EventLogEntry>, Option.Option<EventSeq>]>,
                ParseResult.ParseError
              > =>
                rows.length === 0
                  ? Effect.succeed(Option.none())
                  : decodeRows(rows).pipe(
                      Effect.map((records) => {
                        const lastSeq = rows[rows.length - 1]!.event_seq;
                        return Option.some([
                          records,
                          Option.some(lastSeq)
                        ] as const);
                      })
                    );

              return Stream.unfoldEffect(
                Option.none<EventSeq>(),
                (cursor) =>
                  Option.match(cursor, {
                    onNone: () => firstPage(undefined).pipe(Effect.flatMap(toPage)),
                    onSome: (after) => nextPage(after).pipe(Effect.flatMap(toPage))
                  })
              ).pipe(
                Stream.mapConcat((records) => records),
                Stream.mapError(toStoreIoError(store.root))
              );
            })
          ).pipe(Effect.mapError(toStoreIoError(store.root)))
        );

      const clear = Effect.fn("StoreEventLog.clear")((store: StoreRef) =>
        storeDb
          .withClient(store, (client) =>
            Effect.gen(function* () {
              yield* client`DELETE FROM event_log`;
              yield* client`DELETE FROM event_log_meta`;
            }).pipe(Effect.asVoid)
          )
          .pipe(Effect.mapError(toStoreIoError(store.root)))
      );

      const getLastEventSeq = Effect.fn("StoreEventLog.getLastEventSeq")(
        (store: StoreRef) =>
          storeDb
            .withClient(store, (client) => {
              const findLast = SqlSchema.findAll({
                Request: Schema.Void,
                Result: lastEventSeqRow,
                execute: () =>
                  client`SELECT event_seq as value
                    FROM event_log
                    ORDER BY event_seq DESC
                    LIMIT 1`
              });

              return findLast(undefined).pipe(
                Effect.flatMap((rows) =>
                  rows.length > 0
                    ? Effect.succeed(Option.some(rows[0]!.value))
                    : Effect.succeed(Option.none<EventSeq>())
                )
              );
            })
            .pipe(Effect.mapError(toStoreIoError(store.root)))
      );

      return StoreEventLog.of({ stream, clear, getLastEventSeq });
    })
  );
}
