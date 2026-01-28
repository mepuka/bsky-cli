import { Context, Effect, Layer, Random, Ref, Schema } from "effect";
import * as SqlSchema from "@effect/sql/SqlSchema";
import { StoreIoError } from "../domain/errors.js";
import { PostEvent, PostEventRecord } from "../domain/events.js";
import { EventId, PostUri } from "../domain/primitives.js";
import type { StorePath } from "../domain/primitives.js";
import type { StoreRef } from "../domain/store.js";
import { StoreDb } from "./store-db.js";

const ULID_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const MAX_ULID_TIME = 0xffff_ffff_ffff;

const encodeTime = (time: number) => {
  if (!Number.isFinite(time) || time < 0 || time > MAX_ULID_TIME) {
    throw new Error(`ULID time out of range: ${time}`);
  }

  let value = BigInt(Math.trunc(time));
  let output = "";
  for (let i = 0; i < 10; i += 1) {
    const mod = Number(value % 32n);
    output = `${ULID_ALPHABET[mod]}${output}`;
    value = value / 32n;
  }
  return output;
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

const eventLogMetaKey = "last_event_id";

const eventLogInsertRow = Schema.Struct({
  event_id: EventId,
  event_type: Schema.String,
  post_uri: PostUri,
  payload_json: Schema.String,
  created_at: Schema.String,
  source: Schema.String
});

const eventLogMetaRow = Schema.Struct({
  key: Schema.String,
  value: Schema.String
});

const toStoreIoError = (path: StorePath) => (cause: unknown) =>
  StoreIoError.make({ path, cause });

export class StoreWriter extends Context.Tag("@skygent/StoreWriter")<
  StoreWriter,
  {
    readonly append: (
      store: StoreRef,
      event: PostEvent
    ) => Effect.Effect<PostEventRecord, StoreIoError>;
  }
>() {
  static readonly layer = Layer.effect(
    StoreWriter,
    Effect.gen(function* () {
      const storeDb = yield* StoreDb;
      const idState = yield* Ref.make({
        lastTime: 0,
        lastRandom: [] as ReadonlyArray<number>
      });

      const nextRandomDigits = () =>
        Effect.forEach(
          Array.from({ length: 16 }),
          () => Random.nextIntBetween(0, 32)
        );

      const generateEventId = Effect.fn("StoreWriter.generateEventId")(() =>
        Effect.gen(function* () {
          const state = yield* Ref.get(idState);
          const now = Date.now();
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

          const id = `${encodeTime(time)}${encodeRandomDigits(digits)}`;
          const decoded = yield* Schema.decodeUnknown(EventId)(id);
          yield* Ref.set(idState, { lastTime: time, lastRandom: digits });
          return decoded;
        }).pipe(Effect.orDie)
      );

      const append = Effect.fn("StoreWriter.append")(
        (store: StoreRef, event: PostEvent) =>
          Effect.gen(function* () {
            const id = yield* generateEventId();
            const record = PostEventRecord.make({
              id,
              version: 1,
              event
            });
            const payloadJson = yield* Schema.encode(
              Schema.parseJson(PostEventRecord)
            )(record).pipe(Effect.mapError(toStoreIoError(store.root)));
            const postUri =
              record.event._tag === "PostUpsert"
                ? record.event.post.uri
                : record.event.uri;
            const createdAt =
              record.event.meta.createdAt instanceof Date
                ? record.event.meta.createdAt.toISOString()
                : new Date(record.event.meta.createdAt).toISOString();

            yield* storeDb.withClient(store, (client) => {
              const insertEvent = SqlSchema.void({
                Request: eventLogInsertRow,
                execute: (row) =>
                  client`INSERT INTO event_log ${client.insert(row)}`
              });
              const upsertMeta = SqlSchema.void({
                Request: eventLogMetaRow,
                execute: (row) =>
                  client`INSERT INTO event_log_meta (key, value)
                    VALUES (${row.key}, ${row.value})
                    ON CONFLICT(key) DO UPDATE SET value = excluded.value`
              });

              return Effect.gen(function* () {
                yield* insertEvent({
                  event_id: record.id,
                  event_type: record.event._tag,
                  post_uri: postUri,
                  payload_json: payloadJson,
                  created_at: createdAt,
                  source: record.event.meta.source
                });
                yield* upsertMeta({
                  key: eventLogMetaKey,
                  value: record.id
                });
              }).pipe(client.withTransaction);
            });
            return record;
          }).pipe(Effect.mapError(toStoreIoError(store.root)))
      );

      return StoreWriter.of({ append });
    })
  );
}
