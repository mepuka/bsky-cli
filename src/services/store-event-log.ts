import { Context, Effect, Layer, Option, ParseResult, Schema, Stream } from "effect";
import * as SqlSchema from "@effect/sql/SqlSchema";
import { StoreIoError } from "../domain/errors.js";
import { PostEventRecord } from "../domain/events.js";
import { EventId } from "../domain/primitives.js";
import type { StorePath } from "../domain/primitives.js";
import type { StoreRef } from "../domain/store.js";
import { StoreDb } from "./store-db.js";

const pageSize = 500;

const eventLogRow = Schema.Struct({
  event_id: EventId,
  payload_json: Schema.String
});

const lastEventIdRow = Schema.Struct({
  value: EventId
});

const eventLogMetaKey = "last_event_id";

const decodeEventJson = (raw: string) =>
  Schema.decodeUnknown(Schema.parseJson(PostEventRecord))(raw);

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
      const storeDb = yield* StoreDb;

      const stream = (store: StoreRef) =>
        Stream.unwrap(
          storeDb.withClient(store, (client) =>
            Effect.gen(function* () {
              const firstPage = SqlSchema.findAll({
                Request: Schema.Void,
                Result: eventLogRow,
                execute: () =>
                  client`SELECT event_id, payload_json
                    FROM event_log
                    ORDER BY event_id ASC
                    LIMIT ${pageSize}`
              });
              const nextPage = SqlSchema.findAll({
                Request: EventId,
                Result: eventLogRow,
                execute: (after) =>
                  client`SELECT event_id, payload_json
                    FROM event_log
                    WHERE event_id > ${after}
                    ORDER BY event_id ASC
                    LIMIT ${pageSize}`
              });

              const decodeRows = (rows: ReadonlyArray<typeof eventLogRow.Type>) =>
                Effect.forEach(
                  rows,
                  (row) => decodeEventJson(row.payload_json),
                  { discard: false }
                );

              const toPage = (
                rows: ReadonlyArray<typeof eventLogRow.Type>
              ): Effect.Effect<
                Option.Option<readonly [ReadonlyArray<PostEventRecord>, Option.Option<EventId>]>,
                ParseResult.ParseError
              > =>
                rows.length === 0
                  ? Effect.succeed(Option.none())
                  : decodeRows(rows).pipe(
                      Effect.map((records) => {
                        const lastId = rows[rows.length - 1]!.event_id;
                        return Option.some([
                          records,
                          Option.some(lastId)
                        ] as const);
                      })
                    );

              return Stream.unfoldEffect(
                Option.none<EventId>(),
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

      const getLastEventId = Effect.fn("StoreEventLog.getLastEventId")(
        (store: StoreRef) =>
          storeDb
            .withClient(store, (client) => {
              const findMeta = SqlSchema.findAll({
                Request: Schema.String,
                Result: lastEventIdRow,
                execute: (key) =>
                  client`SELECT value FROM event_log_meta WHERE key = ${key}`
              });

              return findMeta(eventLogMetaKey).pipe(
                Effect.flatMap((rows) =>
                  rows.length > 0
                    ? Effect.succeed(Option.some(rows[0]!.value))
                    : client`SELECT event_id as value
                        FROM event_log
                        ORDER BY event_id DESC
                        LIMIT 1`.pipe(
                        Effect.flatMap((fallbackRows) =>
                          fallbackRows.length > 0
                            ? Schema.decodeUnknown(
                                Schema.Array(lastEventIdRow)
                              )(fallbackRows).pipe(
                                Effect.map((decoded) =>
                                  Option.some(decoded[0]!.value)
                                )
                              )
                            : Effect.succeed(Option.none<EventId>())
                        )
                      )
                )
              );
            })
            .pipe(Effect.mapError(toStoreIoError(store.root)))
      );

      return StoreEventLog.of({ stream, clear, getLastEventId });
    })
  );
}
