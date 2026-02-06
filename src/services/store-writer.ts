import { Clock, Effect, Option, Random, Schema, SynchronizedRef } from "effect";
import type * as SqlClient from "@effect/sql/SqlClient";
import * as SqlSchema from "@effect/sql/SqlSchema";
import { StoreIoError } from "../domain/errors.js";
import { type EventLogEntry, PostEvent, PostEventRecord, isPostUpsert } from "../domain/events.js";
import { EventId, EventSeq, PostUri } from "../domain/primitives.js";
import type { StorePath } from "../domain/primitives.js";
import type { StoreRef } from "../domain/store.js";
import { StoreDb } from "./store-db.js";

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAX_ULID_TIME = 0xffff_ffff_ffff;

class UlidTimeError extends Schema.TaggedError<UlidTimeError>()("UlidTimeError", {
  time: Schema.String,
  message: Schema.String
}) {}

const encodeTime = (time: number) => {
  if (!Number.isFinite(time) || time < 0 || time > MAX_ULID_TIME) {
    return Effect.fail(
      UlidTimeError.make({
        time: String(time),
        message: `ULID time out of range: ${time}`
      })
    );
  }
  return Effect.sync(() => {
    let value = BigInt(Math.trunc(time));
    let output = "";
    for (let i = 0; i < 10; i += 1) {
      const mod = Number(value % 32n);
      output = `${ULID_ALPHABET[mod]}${output}`;
      value = value / 32n;
    }
    return output;
  });
};

const encodeRandomDigits = (digits: ReadonlyArray<number>) =>
  digits.map((digit) => ULID_ALPHABET[digit]).join("");

const incrementRandomDigits = (digits: ReadonlyArray<number>) => {
  const next = digits.slice();
  for (let i = next.length - 1; i >= 0; i -= 1) {
    const value = next[i];
    if (typeof value !== "number") {
      continue;
    }
    if (value === 31) {
      next[i] = 0;
      if (i === 0) {
        return { digits: next, overflow: true } as const;
      }
    } else {
      next[i] = value + 1;
      return { digits: next, overflow: false } as const;
    }
  }
  return { digits: next, overflow: true } as const;
};

const eventLogInsertRow = Schema.Struct({
  event_id: EventId,
  event_type: Schema.String,
  post_uri: PostUri,
  payload_json: Schema.String,
  created_at: Schema.String,
  source: Schema.String
});

const eventLogSeqRow = Schema.Struct({
  event_seq: EventSeq
});

const toStoreIoError = (path: StorePath) => (cause: unknown) =>
  StoreIoError.make({ path, cause });

export class StoreWriter extends Effect.Service<StoreWriter>()("@skygent/StoreWriter", {
  effect: Effect.gen(function* () {
      const storeDb = yield* StoreDb;
      const idState = yield* SynchronizedRef.make({
        lastTime: 0,
        lastRandom: [] as ReadonlyArray<number>
      });

      const nextRandomDigits = () =>
        Effect.forEach(
          Array.from({ length: 16 }),
          () => Random.nextIntBetween(0, 32)
        );

      const generateEventId = Effect.fn("StoreWriter.generateEventId")(() =>
        SynchronizedRef.modifyEffect(idState, (state) =>
          Effect.gen(function* () {
            const now = yield* Clock.currentTimeMillis;
            let time = state.lastTime;
            let digits = state.lastRandom;

            if (digits.length === 0 || now > state.lastTime) {
              time = now;
              digits = yield* nextRandomDigits();
            } else {
              const incremented = incrementRandomDigits(digits);
              if (incremented.overflow) {
                time = state.lastTime + 1;
                digits = yield* nextRandomDigits();
              } else {
                time = state.lastTime;
                digits = incremented.digits;
              }
            }

            const timeEncoded = yield* encodeTime(time);
            const id = `${timeEncoded}${encodeRandomDigits(digits)}`;
            const decoded = yield* Schema.decodeUnknown(EventId)(id);
            return [
              decoded,
              { lastTime: time, lastRandom: digits }
            ] as const;
          })
        )
      );

      const appendWithClient = Effect.fn("StoreWriter.appendWithClient")(
        (client: SqlClient.SqlClient, event: PostEvent) =>
          Effect.gen(function* () {
            const id = yield* generateEventId();
            const record = PostEventRecord.make({
              id,
              version: 1,
              event
            });
            const payloadJson = yield* Schema.encode(
              Schema.parseJson(PostEventRecord)
            )(record);
            const postUri = isPostUpsert(record.event)
              ? record.event.post.uri
              : record.event.uri;
            const createdAt =
              record.event.meta.createdAt instanceof Date
                ? record.event.meta.createdAt.toISOString()
                : new Date(record.event.meta.createdAt).toISOString();

            const insertEvent = SqlSchema.findOne({
              Request: eventLogInsertRow,
              Result: eventLogSeqRow,
              execute: (row) =>
                client`INSERT INTO event_log ${client.insert(row)}
                  RETURNING event_seq`
            });

            const inserted = yield* insertEvent({
              event_id: record.id,
              event_type: record.event._tag,
              post_uri: postUri,
              payload_json: payloadJson,
              created_at: createdAt,
              source: record.event.meta.source
            }).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () =>
                    Effect.dieMessage("Expected event_seq from event_log insert."),
                  onSome: (row) => Effect.succeed(row)
                })
              )
            );
            return { seq: inserted.event_seq, record } satisfies EventLogEntry;
          })
      );

      const append = Effect.fn("StoreWriter.append")(
        (store: StoreRef, event: PostEvent) =>
          storeDb
            .withClient(store, (client) =>
              appendWithClient(client, event).pipe(client.withTransaction)
            )
            .pipe(Effect.mapError(toStoreIoError(store.root)))
      );

      return { append, appendWithClient };
    })
}) {
  static readonly layer = StoreWriter.Default;
}
